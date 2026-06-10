'use strict';
/* ============================================================
   FABLE UNIVERSE v2 — 3D point renderer (globalThis.Renderer3D).

   WebGL2, gl.POINTS everywhere, generalizing the proven v1 2D
   renderer: one dynamic interleaved VBO refreshed per frame from
   the global Bodies store, premultiplied-alpha trails fade via an
   attribute-less fullscreen triangle, and v1's piecewise radial
   glow falloff — now with perspective size attenuation.

   Two passes per frame over the body data:
     pass 0 (additive, ONE/ONE): stars, dust, gas haze, black-hole
            halo rings. Planets discard.
     pass 1 (opaque, ONE/ONE_MINUS_SRC_ALPHA, premultiplied):
            planet sphere impostors and black-hole core discs,
            painter-sorted back-to-front in JS (< 20 of them).

   A separate static VBO holds ~3000 far background stars on a
   radius-5e5 sphere, drawn first so orbiting gives parallax.

   Interleaved vertex layout (6 floats, stride 24):
     a_pos(vec3) @0 | a_rad @12 | a_colorIdx @16 | a_type @20
   ============================================================ */
(function () {

  // PALETTE per contract: 0..6 stellar O→M (as v1), 7 sun-yellow,
  // 8 accretion blue, 9 nebula magenta, 10 nebula teal, 11 dust grey-blue.
  const PALETTE = [
    [155, 176, 255], // 0 O  hot blue
    [170, 191, 255], // 1 B
    [202, 215, 255], // 2 A
    [248, 247, 255], // 3 F  white
    [255, 244, 234], // 4 G  sun-like
    [255, 210, 161], // 5 K  orange
    [255, 163, 110], // 6 M  red dwarf
    [255, 220,  90], // 7 sun yellow
    [120, 200, 255], // 8 accretion blue
    [210, 120, 255], // 9 nebula magenta
    [ 90, 220, 200], // 10 nebula teal
    [150, 160, 200], // 11 dust grey-blue
  ];

  const FLOATS = 6; // x, y, z, rad, colorIdx, type
  const BG_STAR_COUNT = 3000;
  const BG_RADIUS = 5e5;
  const CLEAR = [0.008, 0.008, 0.03]; // opaque near-black (#020208-ish)
  const TRAIL_FADE = 0.10;

  const VERT_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec3  a_pos;      // world coords
layout(location = 1) in float a_rad;      // visual radius, world units
layout(location = 2) in float a_colorIdx; // palette index 0..11
layout(location = 3) in float a_type;     // 0 star 1 bh 2 planet 3 dust 4 gas
uniform mat4  u_viewProj;
uniform vec3  u_palette[12];
uniform float u_sizeScale;     // glow vs. solid-body scale, set per pass
uniform float u_viewportH;     // CSS pixels
uniform float u_dpr;
uniform float u_maxPointSize;  // hardware ALIASED_POINT_SIZE_RANGE max
out vec3  v_color;
out float v_type;
out vec3  v_worldPos;
void main() {
  vec4 clip = u_viewProj * vec4(a_pos, 1.0);
  gl_Position = clip;
  float w = max(clip.w, 1e-4);
  float s = clamp(a_rad * u_sizeScale * u_viewportH / w, 1.5, 160.0) * u_dpr;
  gl_PointSize = min(s, u_maxPointSize);
  v_color = u_palette[int(a_colorIdx + 0.5)];
  v_type = a_type;
  v_worldPos = a_pos;
}`;

  // All output is premultiplied alpha. u_pass selects behavior:
  // 0 = additive sprites, 1 = opaque impostors.
  const FRAG_SRC = `#version 300 es
precision highp float;
in vec3  v_color;
in float v_type;
in vec3  v_worldPos;
uniform float u_pass;
uniform float u_alphaScale;   // global dimmer (background stars)
uniform vec3  u_eye;
uniform vec3  u_lightPos;     // world-space light for planet impostors
out vec4 outColor;

// v1 sprite falloff: gradient stops 0 / 0.18 / 0.45 / 1.0
float glowAlpha(float d) {
  if (d < 0.18) return mix(1.0, 0.9,  d / 0.18);
  if (d < 0.45) return mix(0.9, 0.25, (d - 0.18) / 0.27);
  return mix(0.25, 0.0, (d - 0.45) / 0.55);
}

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  p.y = -p.y;                      // gl_PointCoord y is down; flip to screen-up
  float d = length(p);
  if (d > 1.0) discard;
  float t = v_type;

  if (u_pass < 0.5) {
    /* ---------------- additive pass ---------------- */
    if (t > 1.5 && t < 2.5) discard;   // planets render in the opaque pass
    float a; vec3 col;
    if (t > 3.5) {
      // gas: very soft pure-hue haze, no white core — reads volumetric
      // when many huge points overlap.
      float fall = 1.0 - smoothstep(0.0, 1.0, d);
      a = 0.07 * fall * fall;
      col = v_color;
    } else if (t > 0.5 && t < 1.5) {
      // black hole halo: bright thin annulus, slightly blue, plus a
      // faint outer glow. Center kept dark for the core disc.
      float ring = 0.95 * exp(-pow((d - 0.34) / 0.06, 2.0));
      float glow = 0.16 * (1.0 - smoothstep(0.22, 1.0, d));
      a = ring + glow;
      if (d < 0.17) a = 0.0;
      col = mix(vec3(0.75, 0.85, 1.0), v_color, 0.45);
    } else {
      // star / dust: white-hot core -> palette color -> transparent
      a = glowAlpha(d);
      col = mix(vec3(1.0), v_color, smoothstep(0.0, 0.18, d));
      if (t > 2.5) a *= 0.35;          // dust is the same but dimmer
    }
    a *= u_alphaScale;
    outColor = vec4(col * a, a);

  } else {
    /* ---------------- opaque pass ---------------- */
    float edge = 1.0 - smoothstep(0.92, 1.0, d);  // antialiased rim
    if (edge <= 0.0) discard;
    if (t > 1.5 && t < 2.5) {
      // planet sphere impostor: reconstruct the sphere normal from the
      // point disc, build the camera basis per-fragment from u_eye
      // (up = +Y, matching the camera contract), lambert from the
      // world-space light, ambient 0.08, limb darkening.
      float nz = sqrt(max(0.0, 1.0 - d * d));
      vec3 back = normalize(u_eye - v_worldPos);
      vec3 rt = cross(vec3(0.0, 1.0, 0.0), back);
      rt = dot(rt, rt) > 1e-6 ? normalize(rt) : vec3(1.0, 0.0, 0.0);
      vec3 up = cross(back, rt);
      vec3 n = normalize(rt * p.x + up * p.y + back * nz);
      vec3 L = normalize(u_lightPos - v_worldPos);
      float diff = max(dot(n, L), 0.0);
      float limb = 0.55 + 0.45 * nz;   // limb darkening
      vec3 col = v_color * min(1.0, 0.08 + 0.95 * diff) * limb;
      outColor = vec4(col * edge, edge);
    } else if (t > 0.5 && t < 1.5) {
      // black hole core: opaque black disc with a thin bright rim.
      float rim = smoothstep(0.74, 0.88, d) * (1.0 - smoothstep(0.88, 1.0, d));
      vec3 col = rim * mix(vec3(0.8, 0.88, 1.0), v_color, 0.4);
      outColor = vec4(col * edge, edge);
    } else {
      discard;
    }
  }
}`;

  // Trails fade: attribute-less fullscreen triangle. Blended with
  // (ONE, ONE_MINUS_SRC_ALPHA) and premultiplied output it computes
  // dst = bg·fade + dst·(1-fade): a multiplicative fade *toward the
  // opaque near-black background* instead of toward transparent
  // black, so the canvas never goes see-through (no CSS backdrop
  // needed in 3D — the starfield is in-scene).
  const FADE_VERT_SRC = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const FADE_FRAG_SRC = `#version 300 es
precision mediump float;
uniform float u_fade;
uniform vec3  u_fadeColor;
out vec4 outColor;
void main() { outColor = vec4(u_fadeColor * u_fade, u_fade); }`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('Shader compile failed: ' + log);
    }
    return sh;
  }

  function link(gl, vsSrc, fsSrc) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  // ---------------------------------------------------------------- state
  let gl = null, canvas = null;
  let prog = null, fadeProg = null;
  const uni = {};
  let maxPointSize = 64;
  let cssW = 1, cssH = 1, dprV = 1;

  let dynVao = null, dynVbo = null, dynCapFloats = 0;
  let opqVao = null, opqVbo = null, opqCapFloats = 0;
  let bgVao = null, bgVbo = null, bgCount = 0;

  let scratch = new Float32Array(0);     // all bodies, additive pass
  let opqScratch = new Float32Array(0);  // planets + BHs, sorted
  let opqOrder = [];                     // reusable {i, d2} records

  function setupAttribs() {
    const stride = FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 20);
  }

  function ensureDynCapacity(floats) {
    if (floats <= dynCapFloats) return;
    dynCapFloats = Math.max(floats, dynCapFloats * 2, 65536 * FLOATS);
    gl.bindVertexArray(dynVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, dynVbo);
    gl.bufferData(gl.ARRAY_BUFFER, dynCapFloats * 4, gl.DYNAMIC_DRAW);
    setupAttribs();
    gl.bindVertexArray(null);
  }

  function ensureOpqCapacity(floats) {
    if (floats <= opqCapFloats) return;
    opqCapFloats = Math.max(floats, opqCapFloats * 2, 64 * FLOATS);
    gl.bindVertexArray(opqVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, opqVbo);
    gl.bufferData(gl.ARRAY_BUFFER, opqCapFloats * 4, gl.DYNAMIC_DRAW);
    setupAttribs();
    gl.bindVertexArray(null);
  }

  /* ~3000 static far stars on a sphere — drawn first every frame so
     orbiting the camera produces background parallax. */
  function buildBackground() {
    const data = new Float32Array(BG_STAR_COUNT * FLOATS);
    let o = 0;
    for (let i = 0; i < BG_STAR_COUNT; i++) {
      // uniform direction on the sphere
      const z = Math.random() * 2 - 1;
      const phi = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z);
      data[o++] = BG_RADIUS * s * Math.cos(phi);
      data[o++] = BG_RADIUS * z;
      data[o++] = BG_RADIUS * s * Math.sin(phi);
      // tiny: most clamp to the 1.5px floor, a few sparkle larger
      data[o++] = 120 + 700 * Math.pow(Math.random(), 4);
      // cool-dwarf-dominated population, like v1
      const u = Math.random();
      data[o++] = u < 0.40 ? 6 : u < 0.62 ? 5 : u < 0.80 ? 4 : u < 0.90 ? 3 : u < 0.96 ? 2 : u < 0.99 ? 1 : 0;
      data[o++] = 0; // type star
    }
    bgCount = BG_STAR_COUNT;
    gl.bindVertexArray(bgVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, bgVbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    setupAttribs();
    gl.bindVertexArray(null);
  }

  const Renderer3D = {

    init(cnv) {
      canvas = cnv;
      try {
        gl = canvas.getContext('webgl2', {
          alpha: true,
          premultipliedAlpha: true,
          preserveDrawingBuffer: true,   // trails accumulate in the backbuffer
          antialias: false,
          depth: false,
          stencil: false,
        });
      } catch (e) {
        return null;
      }
      if (!gl || typeof gl.createShader !== 'function') return null;

      try {
        prog = link(gl, VERT_SRC, FRAG_SRC);
        fadeProg = link(gl, FADE_VERT_SRC, FADE_FRAG_SRC);
      } catch (e) {
        return null;
      }

      uni.viewProj = gl.getUniformLocation(prog, 'u_viewProj');
      uni.palette = gl.getUniformLocation(prog, 'u_palette');
      uni.sizeScale = gl.getUniformLocation(prog, 'u_sizeScale');
      uni.viewportH = gl.getUniformLocation(prog, 'u_viewportH');
      uni.dpr = gl.getUniformLocation(prog, 'u_dpr');
      uni.maxPointSize = gl.getUniformLocation(prog, 'u_maxPointSize');
      uni.pass = gl.getUniformLocation(prog, 'u_pass');
      uni.alphaScale = gl.getUniformLocation(prog, 'u_alphaScale');
      uni.eye = gl.getUniformLocation(prog, 'u_eye');
      uni.lightPos = gl.getUniformLocation(prog, 'u_lightPos');
      uni.fade = gl.getUniformLocation(fadeProg, 'u_fade');
      uni.fadeColor = gl.getUniformLocation(fadeProg, 'u_fadeColor');

      const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
      maxPointSize = (range && range[1]) ? range[1] : 64;

      // palette is constant — upload once
      const pal = new Float32Array(36);
      for (let i = 0; i < 12; i++) {
        pal[i * 3] = PALETTE[i][0] / 255;
        pal[i * 3 + 1] = PALETTE[i][1] / 255;
        pal[i * 3 + 2] = PALETTE[i][2] / 255;
      }
      gl.useProgram(prog);
      gl.uniform3fv(uni.palette, pal);

      dynVao = gl.createVertexArray(); dynVbo = gl.createBuffer();
      opqVao = gl.createVertexArray(); opqVbo = gl.createBuffer();
      bgVao = gl.createVertexArray(); bgVbo = gl.createBuffer();
      ensureDynCapacity(1);
      ensureOpqCapacity(1);
      buildBackground();

      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.clearColor(CLEAR[0], CLEAR[1], CLEAR[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return 'webgl2';
    },

    resize(w, h, dpr) {
      cssW = Math.max(1, w);
      cssH = Math.max(1, h);
      dprV = dpr || 1;
      canvas.width = Math.max(1, Math.round(w * dprV));
      canvas.height = Math.max(1, Math.round(h * dprV));
      if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
    },

    /* render({ viewProj, eye, lightPos, trails, timeMs }) — reads the
       global Bodies store directly. */
    render(opts) {
      if (!gl) return;
      const B = globalThis.Bodies;
      const viewProj = opts.viewProj;
      const eye = opts.eye || { x: 0, y: 0, z: 0 };
      const light = opts.lightPos || { x: 0, y: 1e4, z: 0 };
      const trails = !!opts.trails;

      gl.viewport(0, 0, canvas.width, canvas.height);

      // ---- background fade / clear ----
      if (trails) {
        gl.useProgram(fadeProg);
        gl.uniform1f(uni.fade, TRAIL_FADE);
        gl.uniform3f(uni.fadeColor, CLEAR[0], CLEAR[1], CLEAR[2]);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      } else {
        gl.clearColor(CLEAR[0], CLEAR[1], CLEAR[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }

      gl.useProgram(prog);
      gl.uniformMatrix4fv(uni.viewProj, false, viewProj);
      gl.uniform1f(uni.viewportH, cssH);
      gl.uniform1f(uni.dpr, dprV);
      gl.uniform1f(uni.maxPointSize, maxPointSize);
      gl.uniform3f(uni.eye, eye.x, eye.y, eye.z);
      gl.uniform3f(uni.lightPos, light.x, light.y, light.z);

      // ---- pass 0: additive (background stars first, then bodies) ----
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(uni.pass, 0);
      gl.uniform1f(uni.sizeScale, 6.0);   // glow extends past the body

      // Static far starfield. In trails mode these would accumulate
      // (steady state ≈ alpha/fade), so pre-dim by the fade factor.
      gl.uniform1f(uni.alphaScale, trails ? 0.55 * TRAIL_FADE : 0.55);
      gl.bindVertexArray(bgVao);
      gl.drawArrays(gl.POINTS, 0, bgCount);

      const n = B ? B.n : 0;
      let opqCount = 0;
      if (n > 0) {
        const floats = n * FLOATS;
        if (scratch.length < floats) {
          scratch = new Float32Array(Math.max(floats, scratch.length * 2));
        }
        const px = B.px, py = B.py, pz = B.pz, rad = B.rad,
              ci = B.colorIdx, ty = B.type;
        let o = 0;
        opqOrder.length = 0;
        for (let i = 0; i < n; i++) {
          scratch[o++] = px[i];
          scratch[o++] = py[i];
          scratch[o++] = pz[i];
          scratch[o++] = rad[i];
          scratch[o++] = ci[i];
          scratch[o++] = ty[i];
          if (ty[i] === 1 || ty[i] === 2) {  // BH or planet → opaque pass
            const dx = px[i] - eye.x, dy = py[i] - eye.y, dz = pz[i] - eye.z;
            opqOrder.push({ i, d2: dx * dx + dy * dy + dz * dz });
          }
        }

        ensureDynCapacity(floats);
        gl.bindVertexArray(dynVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, dynVbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratch, 0, floats);
        gl.uniform1f(uni.alphaScale, 1.0);
        gl.drawArrays(gl.POINTS, 0, n);

        // ---- pass 1: opaque impostors, painter-sorted back-to-front ----
        opqCount = opqOrder.length;
        if (opqCount > 0) {
          opqOrder.sort((a, b) => b.d2 - a.d2);  // far first
          const ofl = opqCount * FLOATS;
          if (opqScratch.length < ofl) {
            opqScratch = new Float32Array(Math.max(ofl, opqScratch.length * 2));
          }
          let q = 0;
          for (let k = 0; k < opqCount; k++) {
            const i = opqOrder[k].i;
            opqScratch[q++] = px[i];
            opqScratch[q++] = py[i];
            opqScratch[q++] = pz[i];
            opqScratch[q++] = rad[i];
            opqScratch[q++] = ci[i];
            opqScratch[q++] = ty[i];
          }
          ensureOpqCapacity(ofl);
          gl.bindVertexArray(opqVao);
          gl.bindBuffer(gl.ARRAY_BUFFER, opqVbo);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, opqScratch, 0, ofl);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);  // premultiplied over
          gl.uniform1f(uni.pass, 1);
          gl.uniform1f(uni.sizeScale, 2.2);  // solid body, no glow margin
          gl.drawArrays(gl.POINTS, 0, opqCount);
        }
      }
      gl.bindVertexArray(null);
    },
  };

  Renderer3D.PALETTE = PALETTE;
  globalThis.Renderer3D = Renderer3D;
})();
