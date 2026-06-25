'use strict';
/* ============================================================
   FABLE UNIVERSE v3 — post effects (js/render/postfx.js)
   HDR bloom + ACES tone mapping + gravitational lensing, in one
   present chain:

     scene (HDR FBO from Renderer3D)
       → bright-pass downsample (half res)
       → separable gaussian blur (2 passes)
       → final: per-pixel point-lens warp β = θ·(1 − θE²/|θ|²)
         around ≤8 black holes (scene and bloom bend together, as
         light should), photon-ring boost, shadow disc, ACES.

   PostFX owns the final blit; Renderer3D falls back to its own
   minimal present when PostFX is absent or init fails.
   ============================================================ */
(function () {
  const MAX_BH = 8;

  const VS = `#version 300 es
  out vec2 v_uv;
  void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    v_uv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const BRIGHT_FS = `#version 300 es
  precision highp float;
  uniform sampler2D u_scene;
  in vec2 v_uv;
  out vec4 o;
  // v11 LUMINOUS: chroma-preserving soft-knee bloom extraction. We threshold
  // the per-channel max brightness with a soft knee ABOVE the faint starfield
  // and individual star cores, so background stars stay crisp points and only
  // bright nebula cores + the brightest star halos feed the glow. Crucially we
  // multiply the ORIGINAL RGB by the knee factor (not a luminance-only mask),
  // so the bloom keeps the nebula's HUE instead of becoming a white smear.
  // The over-aggressive luminance ceiling that was tamping the glow is gone:
  // the filmic shoulder in the final pass compresses the combined HDR signal.
  const float BLOOM_THRESHOLD = 0.42;            // above the dim starfield floor
  const float BLOOM_KNEE      = 0.55;            // soft onset width (0.5-0.7)
  void main() {
    vec3 c = max(texture(u_scene, v_uv).rgb, vec3(0.0));
    float br = max(c.r, max(c.g, c.b));          // per-channel max keeps hue
    float knee = BLOOM_THRESHOLD * BLOOM_KNEE;
    float soft = clamp(br - BLOOM_THRESHOLD + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    float contrib = max(soft, br - BLOOM_THRESHOLD) / max(br, 1e-4);
    // Gently push chroma into the bloom so the glow carries vivid hue.
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    vec3 sat = mix(vec3(l), c, 1.18);
    o = vec4(max(sat, vec3(0.0)) * contrib, 1.0);
  }`;

  const BLUR_FS = `#version 300 es
  precision highp float;
  uniform sampler2D u_tex;
  uniform vec2 u_dir;            // (1/w, 0) or (0, 1/h)
  in vec2 v_uv;
  out vec4 o;
  void main() {
    vec3 c = texture(u_tex, v_uv).rgb * 0.227;
    vec2 o1 = u_dir * 1.3846, o2 = u_dir * 3.2308;
    c += (texture(u_tex, v_uv + o1).rgb + texture(u_tex, v_uv - o1).rgb) * 0.3162;
    c += (texture(u_tex, v_uv + o2).rgb + texture(u_tex, v_uv - o2).rgb) * 0.0702;
    o = vec4(c, 1.0);
  }`;

  const FINAL_FS = `#version 300 es
  precision highp float;
  uniform sampler2D u_scene;
  uniform sampler2D u_bloom;
  uniform vec2 u_res;                 // backing-store pixels
  uniform int u_nbh;
  uniform vec4 u_bh[${MAX_BH}];       // sx, sy (pixels), thetaE_px, shadow_px
  in vec2 v_uv;
  out vec4 o;

  float luminance(vec3 v) { return dot(v, vec3(0.2126, 0.7152, 0.0722)); }

  // ACES (Narkowicz 2015): a bright, punchy, saturated filmic operator with a
  // gentle highlight roll-off. This is the BRIGHT default that replaces the
  // dim luminance-only tonemap — saturated nebula colour stays vivid as it
  // climbs into the shoulder instead of being pulled down toward grey.
  vec3 acesNarkowicz(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  // Reinhard-Jodie: keeps chroma at high intensity (it tonemaps toward the
  // per-channel Reinhard along the colour direction). We blend a little of it
  // into the very brightest pixels so dense nebula cores read as GLOWING
  // COLOUR rather than flattening to white — the single best fix for the
  // white-blob problem — without dragging the overall image dim.
  vec3 reinhardJodie(vec3 v) {
    float l = luminance(v);
    vec3 tv = v / (1.0 + v);
    return mix(v / (1.0 + l), tv, tv);
  }

  // BRIGHT, COLOURFUL tonemap: ACES for punch + saturation everywhere, with a
  // chroma-preserving Reinhard-Jodie mixed in only where the pre-tonemap HDR
  // is very bright, so the brightest nebula cores keep their hue instead of
  // clipping to flat white. Operates in linear; caller applies sRGB encode.
  vec3 tonemapBright(vec3 c) {
    vec3 aces = acesNarkowicz(c);
    vec3 jodie = reinhardJodie(c);
    // engage the colour-preserving blend only near/above the clipping point.
    float hi = smoothstep(0.9, 2.2, max(c.r, max(c.g, c.b)));
    return clamp(mix(aces, jodie, hi * 0.6), 0.0, 1.0);
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
      if (r > thetaE * 8.0) continue;
      float r2 = max(r * r, 1e-4);
      float warp = 1.0 - (thetaE * thetaE) / r2;
      sample_px = c + (sample_px - c) * warp;
      float t = abs(r - thetaE * 1.08) / (thetaE * 0.16 + 1.0);
      ring += exp(-t * t * 3.0) * 0.55;
      shadow *= smoothstep(u_bh[i].w * 0.55, u_bh[i].w, r);
    }
    vec2 uv = clamp(sample_px / u_res, vec2(0.001), vec2(0.999));
    // v11 LUMINOUS: composite scene + coloured bloom additively in LINEAR HDR,
    // then raise EXPOSURE so the filmic shoulder actually engages, then a
    // single BRIGHT tonemap (ACES + chroma-preserving highlight blend). This
    // reverts the dim luminance-only path: the universe reads as glowing,
    // saturated Cosmos/Hubble colour, not a grey haze.
    const float BLOOM_K  = 1.85;         // luminous colored glow (was 1.4)
    const float EXPOSURE = 1.32;         // lift so the shoulder engages
    vec3 scene = texture(u_scene, uv).rgb;
    vec3 bloom = texture(u_bloom, uv).rgb;
    vec3 c = scene + bloom * BLOOM_K;    // additive HDR composite (linear)
    c += ring * vec3(0.75, 0.85, 1.0) * (c + vec3(0.06));
    c *= shadow;
    c *= EXPOSURE;                       // expose BEFORE the tonemap
    vec3 mapped = tonemapBright(c);      // bright, colourful filmic roll-off
    // A touch of post-tonemap vividness for that extra Cosmos-TV pop without
    // affecting clipping behaviour (mix toward colour, away from grey).
    mapped = clamp(mix(vec3(luminance(mapped)), mapped, 1.12), 0.0, 1.0);
    o = vec4(mapped, 1.0);
  }`;

  let gl = null, vao = null;
  let progBright = null, progBlur = null, progFinal = null;
  const uB = {}, uBl = {}, uF = {};
  let fboA = null, fboB = null, texA = null, texB = null;
  let halfW = 0, halfH = 0, halfFmt = 0;
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

  function link(fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('PostFX link: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  function allocBloomTargets() {
    for (const t of [texA, texB]) if (t) gl.deleteTexture(t);
    for (const f of [fboA, fboB]) if (f) gl.deleteFramebuffer(f);
    halfW = Math.max(1, Math.round(W * DPR / 2));
    halfH = Math.max(1, Math.round(H * DPR / 2));
    const make = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, halfFmt, halfW, halfH);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return [t, f];
    };
    [texA, fboA] = make();
    [texB, fboB] = make();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function fullscreenPass(prog, fbo, w, h) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
  }

  const PostFX = {
    init(glCtx) {
      gl = glCtx;
      try {
        // Half-float bloom targets when renderable, 8-bit fallback.
        halfFmt = gl.getExtension('EXT_color_buffer_float') ? gl.RGBA16F : gl.RGBA8;
        progBright = link(BRIGHT_FS);
        progBlur = link(BLUR_FS);
        progFinal = link(FINAL_FS);
        uB.scene = gl.getUniformLocation(progBright, 'u_scene');
        uBl.tex = gl.getUniformLocation(progBlur, 'u_tex');
        uBl.dir = gl.getUniformLocation(progBlur, 'u_dir');
        uF.scene = gl.getUniformLocation(progFinal, 'u_scene');
        uF.bloom = gl.getUniformLocation(progFinal, 'u_bloom');
        uF.res = gl.getUniformLocation(progFinal, 'u_res');
        uF.nbh = gl.getUniformLocation(progFinal, 'u_nbh');
        uF.bh = gl.getUniformLocation(progFinal, 'u_bh');
        vao = gl.createVertexArray();
        return true;
      } catch (e) {
        console.warn(e.message);
        progFinal = null;
        return false;
      }
    },

    resize(w, h, dpr) {
      W = w; H = h; DPR = dpr;
      if (progFinal) allocBloomTargets();
    },

    /* apply(sceneTex, { blackHoles, viewProj }) — bloom + lens + tone
       map sceneTex onto the default framebuffer. */
    apply(sceneTex, opts) {
      if (!progFinal) return false;
      const vp = opts.viewProj;
      const bhs = opts.blackHoles || [];
      let n = 0;
      // Einstein radius θE ∝ sqrt(M)/depth; K tuned so a 40000-mass
      // hole at depth 1500 reads at ~5% of viewport height.
      const K = 0.36;
      for (let i = 0; i < bhs.length && n < MAX_BH; i++) {
        const b = bhs[i];
        const cx = vp[0] * b.x + vp[4] * b.y + vp[8] * b.z + vp[12];
        const cy = vp[1] * b.x + vp[5] * b.y + vp[9] * b.z + vp[13];
        const cw = vp[3] * b.x + vp[7] * b.y + vp[11] * b.z + vp[15];
        if (cw < 0.1) continue;
        const sx = (cx / cw * 0.5 + 0.5) * W * DPR;
        const sy = (cy / cw * 0.5 + 0.5) * H * DPR;
        let thetaE = K * Math.sqrt(b.mass) / cw * H * DPR;
        thetaE = Math.min(thetaE, 0.18 * H * DPR);
        if (thetaE < 2 * DPR) continue;
        const margin = thetaE * 8;
        if (sx < -margin || sx > W * DPR + margin ||
            sy < -margin || sy > H * DPR + margin) continue;
        const shadowPx = Math.max(thetaE * 0.45, (b.rad * 2 / cw) * H * DPR);
        bhData[n * 4] = sx; bhData[n * 4 + 1] = sy;
        bhData[n * 4 + 2] = thetaE; bhData[n * 4 + 3] = shadowPx;
        n++;
      }

      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(vao);

      // bright pass: scene -> A (half res)
      fullscreenPass(progBright, fboA, halfW, halfH);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.uniform1i(uB.scene, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // blur: A -> B (horizontal), B -> A (vertical)
      fullscreenPass(progBlur, fboB, halfW, halfH);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(uBl.tex, 0);
      gl.uniform2f(uBl.dir, 1 / halfW, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      fullscreenPass(progBlur, fboA, halfW, halfH);
      gl.bindTexture(gl.TEXTURE_2D, texB);
      gl.uniform2f(uBl.dir, 0, 1 / halfH);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // final: lens + bloom composite + tone map -> screen
      fullscreenPass(progFinal, null, W * DPR, H * DPR);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.uniform1i(uF.scene, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(uF.bloom, 1);
      gl.uniform2f(uF.res, W * DPR, H * DPR);
      gl.uniform1i(uF.nbh, n);
      gl.uniform4fv(uF.bh, bhData);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindVertexArray(null);
      gl.activeTexture(gl.TEXTURE0);
      return true;
    },
  };

  globalThis.PostFX = PostFX;
})();
