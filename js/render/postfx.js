'use strict';
/* ============================================================
   FABLE UNIVERSE v3 — post effects (js/render/postfx.js)
   Gravitational lensing + final present. The scene FBO is warped
   per-pixel around up to 8 black holes with the point-lens
   deflection  β = θ · (1 − θE²/|θ|²)  — pixels inside the
   Einstein radius θE sample flipped (the inverted inner image),
   a black shadow disc fills the core, and a thin photon ring
   brightens near 1.08·θE. Far from every hole the warp smoothly
   vanishes and the pass is a plain present.

   PostFX owns the final blit; Renderer3D falls back to its own
   minimal present when PostFX is absent or init fails.
   ============================================================ */
(function () {
  const MAX_BH = 8;

  const VS = `#version 300 es
  void main() {
    // attribute-less fullscreen triangle
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const FS = `#version 300 es
  precision highp float;
  uniform sampler2D u_scene;
  uniform vec2 u_res;                 // backing-store pixels
  uniform int u_nbh;
  uniform vec4 u_bh[${MAX_BH}];       // sx, sy (pixels), thetaE_px, shadow_px
  out vec4 o;

  vec3 fetch(vec2 px) {
    vec2 uv = clamp(px / u_res, vec2(0.001), vec2(0.999));
    return texture(u_scene, uv).rgb;
  }

  void main() {
    vec2 px = gl_FragCoord.xy;
    vec2 sample_px = px;
    float ring = 0.0;
    float shadow = 1.0;
    for (int i = 0; i < ${MAX_BH}; i++) {
      if (i >= u_nbh) break;
      vec2 c = u_bh[i].xy;
      float thetaE = u_bh[i].z;
      vec2 d = px - c;
      float r = length(d);
      if (r > thetaE * 8.0) continue;          // early out: unlensed
      // Point-lens mapping: source angle = image angle * (1 - θE²/r²).
      float r2 = max(r * r, 1e-4);
      float warp = 1.0 - (thetaE * thetaE) / r2;
      sample_px = c + (sample_px - c) * warp;
      // Photon ring: thin additive brightening just outside θE.
      float t = abs(r - thetaE * 1.08) / (thetaE * 0.16 + 1.0);
      ring += exp(-t * t * 3.0) * 0.55;
      // Event-horizon shadow.
      shadow *= smoothstep(u_bh[i].w * 0.55, u_bh[i].w, r);
    }
    vec3 c = fetch(sample_px);
    c += ring * vec3(0.75, 0.85, 1.0) * (c + vec3(0.06));
    c *= shadow;
    o = vec4(c, 1.0);
  }`;

  let gl = null, prog = null, vao = null;
  let uScene, uRes, uNbh, uBh;
  const bhData = new Float32Array(MAX_BH * 4);
  let W = 0, H = 0, DPR = 1;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('PostFX shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  const PostFX = {
    init(glCtx) {
      gl = glCtx;
      try {
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          throw new Error('PostFX link: ' + gl.getProgramInfoLog(prog));
        }
        uScene = gl.getUniformLocation(prog, 'u_scene');
        uRes = gl.getUniformLocation(prog, 'u_res');
        uNbh = gl.getUniformLocation(prog, 'u_nbh');
        uBh = gl.getUniformLocation(prog, 'u_bh');
        vao = gl.createVertexArray();
        return true;
      } catch (e) {
        console.warn(e.message);
        prog = null;
        return false;
      }
    },

    resize(w, h, dpr) { W = w; H = h; DPR = dpr; },

    /* apply(sceneTex, { blackHoles, viewProj, viewportH })
       blackHoles: world-space [{x,y,z,mass,rad}], heaviest first.
       Projects each to screen, derives the Einstein radius from
       mass and camera depth, and presents sceneTex to the default
       framebuffer with the lens warp. */
    apply(sceneTex, opts) {
      if (!prog) return false;
      const vp = opts.viewProj;
      const bhs = opts.blackHoles || [];
      let n = 0;
      // Einstein radius: θE ∝ sqrt(M)/depth in angular terms; in pixels
      // that is K·sqrt(M)/w_clip·H. K tuned so a 40000-mass hole at
      // depth 1500 reads clearly (θE ≈ 4.6% of viewport height).
      const K = 0.36;
      for (let i = 0; i < bhs.length && n < MAX_BH; i++) {
        const b = bhs[i];
        const cx = vp[0] * b.x + vp[4] * b.y + vp[8] * b.z + vp[12];
        const cy = vp[1] * b.x + vp[5] * b.y + vp[9] * b.z + vp[13];
        const cw = vp[3] * b.x + vp[7] * b.y + vp[11] * b.z + vp[15];
        if (cw < 0.1) continue;                       // behind the camera
        const sx = (cx / cw * 0.5 + 0.5) * W * DPR;
        const sy = (cy / cw * 0.5 + 0.5) * H * DPR;   // FBO space: y up
        let thetaE = K * Math.sqrt(b.mass) / cw * H * DPR;
        thetaE = Math.min(thetaE, 0.18 * H * DPR);
        if (thetaE < 2 * DPR) continue;               // sub-pixel: skip
        const margin = thetaE * 8;
        if (sx < -margin || sx > W * DPR + margin ||
            sy < -margin || sy > H * DPR + margin) continue;
        const shadowPx = Math.max(thetaE * 0.45,
                                  (b.rad * 2 / cw) * H * DPR);
        bhData[n * 4] = sx;
        bhData[n * 4 + 1] = sy;
        bhData[n * 4 + 2] = thetaE;
        bhData[n * 4 + 3] = shadowPx;
        n++;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W * DPR, H * DPR);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.uniform1i(uScene, 0);
      gl.uniform2f(uRes, W * DPR, H * DPR);
      gl.uniform1i(uNbh, n);
      gl.uniform4fv(uBh, bhData);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      return true;
    },
  };

  globalThis.PostFX = PostFX;
})();
