'use strict';
/* ============================================================
   FABLE UNIVERSE v3 — 3D point renderer (globalThis.Renderer3D).

   WebGL2, gl.POINTS everywhere. v3 upgrades on the proven v2
   renderer (contract: docs/ARCHITECTURE-GPU.md):

   - Two body sources, switched with setSource():
       'arrays'  (default) — reads the global Bodies store into a
                 dynamic interleaved VBO per frame, exactly as v2.
       'texture' — positions+mass live in a GPU RGBA32F texture
                 (posTex, width 2048, row = id >> 11) written by
                 PhysicsGPU; the vertex shader texelFetches by
                 gl_VertexID. rad/colorIdx/type come from a static
                 VBO built once from staticAttribs; the massive
                 region [0, massiveCount) is re-uploaded whenever
                 render opts carry a changed attribsVersion.
                 posTex.w < 0 = dead slot -> vertex clipped.
   - Scene-to-FBO pipeline: the scene accumulates in an RGBA16F
     FBO (RGBA8 fallback) with a depth attachment; trails = no
     clear + multiplicative fade quad inside the FBO (the old
     preserveDrawingBuffer trick is gone); PostFX then presents
     (and gravitationally lenses) the FBO to the screen each frame.
   - render(opts) gains blackHoles [{x,y,z,mass,rad}] (<= 8 used
     for lensing) and attribsVersion. Both optional: old callers
     ({viewProj, eye, lightPos, trails, timeMs}) keep working and
     mean "arrays mode, no lensing".

   Two passes per frame over the body data:
     pass 0 (additive, ONE/ONE): stars, dust, gas haze, black-hole
            halo rings. Planets discard. Depth test off.
     pass 1 (opaque, ONE/ONE_MINUS_SRC_ALPHA, premultiplied):
            planet sphere impostors and black-hole core discs.
            arrays mode: painter-sorted back-to-front in JS.
            texture mode: positions are GPU-side so no CPU sort —
            depth testing against the FBO depth buffer instead
            (planets/BHs are at most a few dozen).

   A separate static VBO holds ~3000 far background stars on a
   radius-5e5 sphere, drawn first so orbiting gives parallax.

   Interleaved arrays-mode vertex layout (6 floats, stride 24):
     a_pos(vec3) @0 | a_rad @12 | a_colorIdx @16 | a_type @20
   Texture-mode static layout (3 floats, stride 12):
     a_rad @0 | a_colorIdx @4 | a_type @8
   ============================================================ */
(function () {

  // PALETTE per contract: 0..6 stellar O→M (as v1), 7 sun-yellow,
  // 8 accretion blue, 9 nebula magenta, 10 nebula teal, 11 dust grey-blue.
  // v8 WANDERER: indices 12..17 add a WIDER VIVID emission-nebula set
  // (H-alpha red, OIII teal/green, gold, violet, vivid magenta, royal
  // blue) so gas reads as luminous colorful clouds. The gas/type-4
  // sprites may use any of 9,10,12..17 (the cosmos-color agent and the
  // integrator code against these indices). Array size is derived from
  // PALETTE.length and threaded into both body shaders, so adding more
  // entries here is safe as long as colorIdx stays in range.
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
    [228, 110, 255], // 9 nebula magenta (vivid)
    [ 70, 235, 205], // 10 nebula teal (vivid)
    [150, 160, 200], // 11 dust grey-blue
    [255,  70,  96], // 12 H-alpha emission red
    [ 60, 230, 150], // 13 OIII teal-green
    [255, 196,  70], // 14 nebula gold
    [176,  96, 255], // 15 violet
    [255,  86, 210], // 16 vivid magenta
    [ 78, 124, 255], // 17 royal blue
  ];
  const PAL_N = PALETTE.length;

  const FLOATS = 6; // x, y, z, rad, colorIdx, type
  const BG_STAR_COUNT = 3000;
  const BG_RADIUS = 5e5;
  const CLEAR = [0.008, 0.008, 0.03]; // opaque near-black (#020208-ish)
  const TRAIL_FADE = 0.10;

  const VERT_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec3  a_pos;      // world coords
layout(location = 1) in float a_rad;      // visual radius, world units
layout(location = 2) in float a_colorIdx; // palette index 0..${PAL_N - 1}
layout(location = 3) in float a_type;     // 0 star 1 bh 2 planet 3 dust 4 gas
uniform mat4  u_viewProj;
uniform vec3  u_palette[${PAL_N}];
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
  // gas gets a larger softer footprint so volumetric clouds bloom wide
  float gasScale = a_type > 3.5 ? 1.6 : 1.0;
  float s = clamp(a_rad * u_sizeScale * gasScale * u_viewportH / w, 1.5, 220.0) * u_dpr;
  gl_PointSize = min(s, u_maxPointSize);
  v_color = u_palette[int(a_colorIdx + 0.5)];
  v_type = a_type;
  v_worldPos = a_pos;
}`;

  /* Texture-sourced variant: position + mass fetched from posTex
     (RGBA32F, width 2048, row-major by slot) using gl_VertexID.
     Dead slots (w < 0) are clipped (position outside the clip
     volume + point size 0). In the opaque pass (u_pass = 1) every
     non-planet/non-BH vertex is clipped too, since we cannot
     pre-filter on the CPU. */
  const VERT_TEX_SRC = `#version 300 es
precision highp float;
layout(location = 0) in float a_rad;
layout(location = 1) in float a_colorIdx;
layout(location = 2) in float a_type;
uniform sampler2D u_posTex;    // xyz = world pos, w = mass (< 0 dead)
uniform mat4  u_viewProj;
uniform vec3  u_palette[${PAL_N}];
uniform float u_sizeScale;
uniform float u_viewportH;
uniform float u_dpr;
uniform float u_maxPointSize;
uniform float u_pass;
out vec3  v_color;
out float v_type;
out vec3  v_worldPos;
void main() {
  ivec2 tc = ivec2(gl_VertexID & 2047, gl_VertexID >> 11);
  vec4 pm = texelFetch(u_posTex, tc, 0);
  bool opaqueBody = a_type > 0.5 && a_type < 2.5;   // BH or planet
  if (pm.w < 0.0 || (u_pass > 0.5 && !opaqueBody)) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // z > w -> clipped away
    gl_PointSize = 0.0;
    v_color = vec3(0.0); v_type = 0.0; v_worldPos = vec3(0.0);
    return;
  }
  vec4 clip = u_viewProj * vec4(pm.xyz, 1.0);
  gl_Position = clip;
  float w = max(clip.w, 1e-4);
  float gasScale = a_type > 3.5 ? 1.6 : 1.0;
  float s = clamp(a_rad * u_sizeScale * gasScale * u_viewportH / w, 1.5, 220.0) * u_dpr;
  gl_PointSize = min(s, u_maxPointSize);
  v_color = u_palette[int(a_colorIdx + 0.5)];
  v_type = a_type;
  v_worldPos = pm.xyz;
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
      // gas: luminous pure-hue volumetric haze, no white core. A wider,
      // softer Gaussian-ish falloff (gentle out to the rim) so many huge
      // overlapping points additively build into glowing colorful clouds.
      // A faint warm inner lift gives nebulae depth without a hard core.
      float core = exp(-d * d * 2.4);            // soft inner brightening
      float halo = 1.0 - smoothstep(0.0, 1.0, d); // broad outer falloff
      a = 0.10 * (0.22 * core + halo * halo);
      // keep the hue saturated so stacked gas glows colorful, not white
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
  // opaque near-black background*. v3: this runs INSIDE the scene
  // FBO, so the default framebuffer needs no preserveDrawingBuffer.
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

  // Minimal present (FBO -> screen) used only when PostFX is not
  // loaded / failed: clamp + opaque alpha. PostFX normally owns
  // the present so lensing + tone fold into a single blit.
  const PRESENT_FRAG_SRC = `#version 300 es
precision highp float;
uniform sampler2D u_scene;
out vec4 outColor;
void main() {
  vec3 c = texelFetch(u_scene, ivec2(gl_FragCoord.xy), 0).rgb;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

  /* ---- ship overlay (v8 WANDERER) ----
     A dedicated tiny pass drawn AFTER the universe + post-processing.
     Glowing additive GL_LINES (wireframe ship hull) + additive point
     sprites (interior nodes / markers), projected with the SAME
     viewProj as the scene so they sit in the active node's local frame,
     in front of the bodies. No overlay opts -> this pass never runs and
     behaviour is byte-for-byte unchanged. */
  const OVL_LINE_VERT_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;     // node-local segment endpoint
uniform mat4 u_viewProj;
void main() {
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

  const OVL_LINE_FRAG_SRC = `#version 300 es
precision highp float;
uniform vec3  u_color;
uniform float u_intensity;
out vec4 outColor;
void main() {
  // additive premultiplied glow; bloom in PostFX widens the line.
  vec3 c = u_color * u_intensity;
  outColor = vec4(c, 1.0);
}`;

  const OVL_PT_VERT_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec3  a_pos;      // node-local marker position
layout(location = 1) in float a_colorIdx; // palette index
layout(location = 2) in float a_size;     // pixel size hint
uniform mat4  u_viewProj;
uniform vec3  u_palette[${PAL_N}];
uniform float u_dpr;
uniform float u_maxPointSize;
out vec3 v_color;
void main() {
  vec4 clip = u_viewProj * vec4(a_pos, 1.0);
  gl_Position = clip;
  float s = clamp(a_size, 2.0, 64.0) * u_dpr;
  gl_PointSize = min(s, u_maxPointSize);
  v_color = u_palette[int(a_colorIdx + 0.5)];
}`;

  const OVL_PT_FRAG_SRC = `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 outColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;
  // bright core -> palette colour -> transparent (additive glow marker)
  float a = 1.0 - smoothstep(0.0, 1.0, d);
  a *= a;
  vec3 col = mix(vec3(1.0), v_color, smoothstep(0.0, 0.35, d));
  outColor = vec4(col * a, a);
}`;

  /* ---- ship overlay SOLID mesh pass (v9 SHIPWRIGHT) ----
     A shaded, depth-tested triangle pass drawn BEFORE the wireframe lines so
     the hull reads as a real, self-occluding solid rather than a flat cyan
     cage. Lambert diffuse + ambient + a subtle rim/fresnel term. Runs on the
     default framebuffer (now created with depth:true) with depth write+test
     and blending OFF. No overlay.tris -> this whole pass is a clean no-op. */
  const OVL_MESH_VERT_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;    // node-local vertex position
layout(location = 1) in vec3 a_norm;   // node-local unit normal
layout(location = 2) in vec3 a_color;  // per-triangle material RGB
uniform mat4 u_viewProj;
out vec3 v_norm;
out vec3 v_color;
out vec3 v_viewDir;
void main() {
  vec4 clip = u_viewProj * vec4(a_pos, 1.0);
  gl_Position = clip;
  v_norm = a_norm;
  v_color = a_color;
  // approximate view direction in node-local space: the overlay is drawn in
  // the active node's local frame where the camera sits near the origin, so
  // -a_pos points roughly toward the eye. Good enough for a rim term.
  v_viewDir = -a_pos;
}`;

  const OVL_MESH_FRAG_SRC = `#version 300 es
precision highp float;
in vec3 v_norm;
in vec3 v_color;
in vec3 v_viewDir;
uniform vec3 u_lightDir;   // node-local, points TOWARD the light (normalized)
out vec4 outColor;
void main() {
  vec3 N = normalize(v_norm);
  vec3 L = normalize(u_lightDir);
  vec3 V = normalize(v_viewDir);
  // two-sided shading so back-facing winding still lights (robustness).
  float ndl = dot(N, L);
  float diff = max(abs(ndl) * 0.85 + 0.15, 0.0); // soft wrap-ish diffuse
  float ambient = 0.28;
  // subtle rim / fresnel to catch the silhouette edges.
  float rim = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), 3.0);
  vec3 base = v_color * (ambient + diff * 0.95);
  vec3 col = base + rim * 0.35 * (v_color * 0.5 + vec3(0.25, 0.35, 0.45));
  outColor = vec4(col, 1.0);
}`;

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
  let progA = null, progT = null, fadeProg = null, presentProg = null;
  let ovlLineProg = null, ovlPtProg = null, ovlMeshProg = null;
  const uniA = {}, uniT = {}, uniF = {}, uniP = {};
  const uniOL = {}, uniOP = {}, uniOM = {};
  let maxPointSize = 64;
  let cssW = 1, cssH = 1, dprV = 1;

  let dynVao = null, dynVbo = null, dynCapFloats = 0;
  let opqVao = null, opqVbo = null, opqCapFloats = 0;
  let bgVao = null, bgVbo = null, bgCount = 0;
  let texVao = null, texVbo = null, texCapFloats = 0;
  let ovlLineVao = null, ovlLineVbo = null, ovlLineCapFloats = 0;
  let ovlPtVao = null, ovlPtVbo = null, ovlPtCapFloats = 0;
  let ovlPtScratch = new Float32Array(0);
  // solid hull mesh: interleaved [pos.xyz, norm.xyz, color.rgb] = 9 floats/vert
  let ovlMeshVao = null, ovlMeshVbo = null, ovlMeshCapFloats = 0;
  let ovlMeshScratch = new Float32Array(0);

  let scratch = new Float32Array(0);     // all bodies, additive pass
  let opqScratch = new Float32Array(0);  // planets + BHs, sorted
  let opqOrder = [];                     // reusable {i, d2} records

  // scene render target
  let fbo = null, sceneTex = null, depthRb = null;
  let targetFormat = null;               // 'rgba16f' | 'rgba8' | null (direct)
  let halfFloatRT = false;
  let pfOK = false;                      // PostFX initialized

  // body source
  let source = { mode: 'arrays' };
  let lastAttribsVersion = undefined;

  function bodyUniforms(prog, u) {
    u.viewProj = gl.getUniformLocation(prog, 'u_viewProj');
    u.palette = gl.getUniformLocation(prog, 'u_palette');
    u.sizeScale = gl.getUniformLocation(prog, 'u_sizeScale');
    u.viewportH = gl.getUniformLocation(prog, 'u_viewportH');
    u.dpr = gl.getUniformLocation(prog, 'u_dpr');
    u.maxPointSize = gl.getUniformLocation(prog, 'u_maxPointSize');
    u.pass = gl.getUniformLocation(prog, 'u_pass');
    u.alphaScale = gl.getUniformLocation(prog, 'u_alphaScale');
    u.eye = gl.getUniformLocation(prog, 'u_eye');
    u.lightPos = gl.getUniformLocation(prog, 'u_lightPos');
    u.posTex = gl.getUniformLocation(prog, 'u_posTex');  // texture variant only
  }

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

  function setupTexAttribs() {
    const stride = 3 * 4;                // rad, colorIdx, type
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 1, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 8);
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

  function ensureOvlLineCapacity(floats) {
    if (floats <= ovlLineCapFloats) return;
    ovlLineCapFloats = Math.max(floats, ovlLineCapFloats * 2, 1024 * 6);
    gl.bindVertexArray(ovlLineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, ovlLineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, ovlLineCapFloats * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);
  }

  function ensureOvlPtCapacity(floats) {
    if (floats <= ovlPtCapFloats) return;
    ovlPtCapFloats = Math.max(floats, ovlPtCapFloats * 2, 256 * 5);
    gl.bindVertexArray(ovlPtVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, ovlPtVbo);
    gl.bufferData(gl.ARRAY_BUFFER, ovlPtCapFloats * 4, gl.DYNAMIC_DRAW);
    const stride = 5 * 4;                 // x,y,z, colorIdx, size
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 16);
    gl.bindVertexArray(null);
  }

  function ensureOvlMeshCapacity(floats) {
    if (floats <= ovlMeshCapFloats) return;
    ovlMeshCapFloats = Math.max(floats, ovlMeshCapFloats * 2, 4096 * 9);
    gl.bindVertexArray(ovlMeshVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, ovlMeshVbo);
    gl.bufferData(gl.ARRAY_BUFFER, ovlMeshCapFloats * 4, gl.DYNAMIC_DRAW);
    const stride = 9 * 4;                  // pos.xyz, norm.xyz, color.rgb
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 24);
    gl.bindVertexArray(null);
  }

  /* Draw the ship overlay onto the default framebuffer, AFTER PostFX
     present. Additive glowing GL_LINES (wireframe) + additive point
     sprites (markers), in node-local space via the scene viewProj. */
  function drawOverlay(overlay, viewProj) {
    if (!overlay || !ovlLineProg) return;
    const lines = overlay.lines;
    const points = overlay.points;
    const tris = overlay.tris;
    const norms = overlay.norms;
    const triColor = overlay.triColor;
    const haveLines = lines && lines.length >= 6;
    const havePoints = points && points.length > 0;
    const haveMesh = ovlMeshProg && tris && tris.length >= 9 &&
                     norms && norms.length === tris.length &&
                     triColor && triColor.length * 3 === tris.length;
    if (!haveLines && !havePoints && !haveMesh) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);

    // ---- SOLID HULL PASS (opaque, depth write+test) ----
    // Runs first so the shaded triangles self-occlude; then the wireframe
    // accent edges and markers are drawn depth-tested but additive on top.
    if (haveMesh) {
      const nVerts = tris.length / 3;          // 3 floats per vertex position
      const nTri = tris.length / 9;            // 9 floats per triangle
      const floats = nVerts * 9;               // interleaved pos+norm+color
      if (ovlMeshScratch.length < floats) {
        ovlMeshScratch = new Float32Array(Math.max(floats, ovlMeshScratch.length * 2));
      }
      const S = ovlMeshScratch;
      // interleave: for each vertex v, [pos.xyz, norm.xyz, triColor.rgb].
      for (let t = 0; t < nTri; t++) {
        const cr = triColor[t * 3], cg = triColor[t * 3 + 1], cb = triColor[t * 3 + 2];
        for (let j = 0; j < 3; j++) {
          const vi = t * 3 + j;                // vertex index
          const pi = vi * 3;                   // base into tris/norms
          const oi = vi * 9;                   // base into interleaved scratch
          S[oi]     = tris[pi];     S[oi + 1] = tris[pi + 1]; S[oi + 2] = tris[pi + 2];
          S[oi + 3] = norms[pi];    S[oi + 4] = norms[pi + 1]; S[oi + 5] = norms[pi + 2];
          S[oi + 6] = cr;           S[oi + 7] = cg;           S[oi + 8] = cb;
        }
      }
      const ld = overlay.lightDir || [0.4, 0.8, 0.3];
      ensureOvlMeshCapacity(floats);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.BLEND);
      gl.useProgram(ovlMeshProg);
      gl.uniformMatrix4fv(uniOM.viewProj, false, viewProj);
      gl.uniform3f(uniOM.lightDir, ld[0], ld[1], ld[2]);
      gl.bindVertexArray(ovlMeshVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, ovlMeshVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, S, 0, floats);
      gl.drawArrays(gl.TRIANGLES, 0, nVerts);
    }

    // ---- additive accent / marker pass ----
    // Depth TEST on (so glowing trim sits on the hull surface, hidden behind
    // it where occluded) but depth WRITE off, additive blend. When there is no
    // solid mesh, depth test is disabled so behaviour is byte-for-byte the old
    // additive-only overlay.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);          // additive glow
    if (haveMesh) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
    } else {
      gl.disable(gl.DEPTH_TEST);
    }
    gl.depthMask(false);

    // ---- wireframe lines ----
    if (haveLines) {
      const lc = overlay.lineColor || [0.55, 0.95, 1.0];
      const usable = lines.length - (lines.length % 6);  // whole segments
      ensureOvlLineCapacity(usable);
      gl.useProgram(ovlLineProg);
      gl.uniformMatrix4fv(uniOL.viewProj, false, viewProj);
      gl.uniform3f(uniOL.color, lc[0], lc[1], lc[2]);
      gl.uniform1f(uniOL.intensity, overlay.intensity != null ? overlay.intensity : 0.9);
      // best-effort thicker lines (most drivers clamp to 1; harmless)
      try { gl.lineWidth(overlay.lineWidth != null ? overlay.lineWidth : 2); } catch (e) {}
      gl.bindVertexArray(ovlLineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, ovlLineVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, lines, 0, usable);
      gl.drawArrays(gl.LINES, 0, usable / 3);
    }

    // ---- marker point sprites ----
    if (havePoints) {
      const np = points.length;
      const floats = np * 5;
      if (ovlPtScratch.length < floats) {
        ovlPtScratch = new Float32Array(Math.max(floats, ovlPtScratch.length * 2));
      }
      let o = 0;
      for (let k = 0; k < np; k++) {
        const p = points[k];
        ovlPtScratch[o++] = p.x; ovlPtScratch[o++] = p.y; ovlPtScratch[o++] = p.z;
        ovlPtScratch[o++] = (p.colorIdx != null ? p.colorIdx : 8);
        ovlPtScratch[o++] = (p.size != null ? p.size : 10);
      }
      ensureOvlPtCapacity(floats);
      gl.useProgram(ovlPtProg);
      gl.uniformMatrix4fv(uniOP.viewProj, false, viewProj);
      gl.uniform1f(uniOP.dpr, dprV);
      gl.uniform1f(uniOP.maxPointSize, maxPointSize);
      gl.bindVertexArray(ovlPtVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, ovlPtVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, ovlPtScratch, 0, floats);
      gl.drawArrays(gl.POINTS, 0, np);
    }

    gl.bindVertexArray(null);
    gl.depthMask(true);
    // leave depth test disabled (matches the renderer's default GL state after
    // every other pass, which manages DEPTH_TEST locally).
    gl.disable(gl.DEPTH_TEST);
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

  /* (Re)allocate the scene render target at the current canvas size:
     RGBA16F color (RGBA8 fallback) + DEPTH_COMPONENT24. Returns true
     if a complete FBO exists; false drops the renderer into a direct
     emergency path (no trails persistence, no lensing). */
  function allocTarget() {
    const w = Math.max(1, canvas.width), h = Math.max(1, canvas.height);
    if (sceneTex) { gl.deleteTexture(sceneTex); sceneTex = null; }
    if (depthRb) { gl.deleteRenderbuffer(depthRb); depthRb = null; }
    if (fbo) { gl.deleteFramebuffer(fbo); fbo = null; }
    targetFormat = null;

    fbo = gl.createFramebuffer();
    depthRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);

    const formats = halfFloatRT ? [gl.RGBA16F, gl.RGBA8] : [gl.RGBA8];
    for (const fmt of formats) {
      sceneTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
      // linear so the lensing warp resamples smoothly (16F filtering
      // is core WebGL2); clamp so warped reads never wrap.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        targetFormat = (fmt === gl.RGBA16F) ? 'rgba16f' : 'rgba8';
        gl.clearColor(CLEAR[0], CLEAR[1], CLEAR[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return true;
      }
      gl.deleteTexture(sceneTex);
      sceneTex = null;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return false;
  }

  /* Full (re)build of the texture-mode static-attribute VBO from
     source.staticAttribs ([rad, colorIdx, type] × count). */
  function uploadStaticAttribs() {
    if (!gl || source.mode !== 'texture' || !source.staticAttribs) return;
    const floats = source.count * 3;
    gl.bindVertexArray(texVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, texVbo);
    if (floats > texCapFloats) {
      texCapFloats = Math.max(floats, texCapFloats * 2, 4096 * 3);
      gl.bufferData(gl.ARRAY_BUFFER, texCapFloats * 4, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, source.staticAttribs, 0,
                     Math.min(floats, source.staticAttribs.length));
    setupTexAttribs();
    gl.bindVertexArray(null);
  }

  /* Per-frame uniforms shared by both body programs. */
  function setFrameUniforms(u, viewProj, eye, light) {
    gl.uniformMatrix4fv(u.viewProj, false, viewProj);
    gl.uniform1f(u.viewportH, cssH);
    gl.uniform1f(u.dpr, dprV);
    gl.uniform1f(u.maxPointSize, maxPointSize);
    gl.uniform3f(u.eye, eye.x, eye.y, eye.z);
    gl.uniform3f(u.lightPos, light.x, light.y, light.z);
  }

  /* arrays mode: v2 path — copy Bodies into the dynamic VBO, draw the
     additive pass, then painter-sort planets/BHs for the opaque pass. */
  function drawArrayBodies(eye) {
    const B = globalThis.Bodies;
    const n = B ? B.n : 0;
    if (n <= 0) return;

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
      if (ty[i] === 1 || ty[i] === 2) {  // BH or planet -> opaque pass
        const dx = px[i] - eye.x, dy = py[i] - eye.y, dz = pz[i] - eye.z;
        opqOrder.push({ i, d2: dx * dx + dy * dy + dz * dz });
      }
    }

    ensureDynCapacity(floats);
    gl.bindVertexArray(dynVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, dynVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratch, 0, floats);
    gl.uniform1f(uniA.alphaScale, 1.0);
    gl.drawArrays(gl.POINTS, 0, n);

    // ---- pass 1: opaque impostors, painter-sorted back-to-front ----
    const opqCount = opqOrder.length;
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
      gl.uniform1f(uniA.pass, 1);
      gl.uniform1f(uniA.sizeScale, 2.2);  // solid body, no glow margin
      gl.drawArrays(gl.POINTS, 0, opqCount);
    }
  }

  /* texture mode: both passes draw all `count` slots; the vertex
     shader clips dead slots, and (pass 1) everything that is not a
     planet/BH. Opaque pass uses the depth buffer instead of a CPU
     painter sort (positions live on the GPU). */
  function drawTextureBodies(opts, viewProj, eye, light) {
    const s = source;
    // posTex may be a getter: ping-pong engines swap textures per frame.
    const posTex = typeof s.posTex === 'function' ? s.posTex() : s.posTex;
    if (!posTex || s.count <= 0) return;

    gl.useProgram(progT);
    setFrameUniforms(uniT, viewProj, eye, light);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, posTex);
    gl.uniform1i(uniT.posTex, 0);

    // engine bumped attribsVersion -> re-upload the massive region
    if (opts.attribsVersion !== undefined &&
        opts.attribsVersion !== lastAttribsVersion) {
      lastAttribsVersion = opts.attribsVersion;
      if (s.staticAttribs && s.massiveCount > 0) {
        const floats = Math.min(s.massiveCount, s.count) * 3;
        gl.bindBuffer(gl.ARRAY_BUFFER, texVbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.staticAttribs, 0,
                         Math.min(floats, s.staticAttribs.length));
      }
    }

    gl.bindVertexArray(texVao);

    // ---- pass 0: additive ----
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform1f(uniT.pass, 0);
    gl.uniform1f(uniT.sizeScale, 6.0);
    gl.uniform1f(uniT.alphaScale, 1.0);
    gl.drawArrays(gl.POINTS, 0, s.count);

    // ---- pass 1: opaque, depth-tested ----
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(uniT.pass, 1);
    gl.uniform1f(uniT.sizeScale, 2.2);
    gl.drawArrays(gl.POINTS, 0, s.count);
    gl.disable(gl.DEPTH_TEST);
  }

  const Renderer3D = {

    init(cnv) {
      canvas = cnv;
      try {
        gl = canvas.getContext('webgl2', {
          alpha: false,
          premultipliedAlpha: true,
          preserveDrawingBuffer: false,  // trails now live in the scene FBO
          antialias: false,
          depth: true,                   // default FB depth for the solid ship overlay pass
          stencil: false,
        });
      } catch (e) {
        return null;
      }
      if (!gl || typeof gl.createShader !== 'function') return null;

      try {
        progA = link(gl, VERT_SRC, FRAG_SRC);
        progT = link(gl, VERT_TEX_SRC, FRAG_SRC);
        fadeProg = link(gl, FADE_VERT_SRC, FADE_FRAG_SRC);
        presentProg = link(gl, FADE_VERT_SRC, PRESENT_FRAG_SRC);
        ovlLineProg = link(gl, OVL_LINE_VERT_SRC, OVL_LINE_FRAG_SRC);
        ovlPtProg = link(gl, OVL_PT_VERT_SRC, OVL_PT_FRAG_SRC);
        ovlMeshProg = link(gl, OVL_MESH_VERT_SRC, OVL_MESH_FRAG_SRC);
      } catch (e) {
        return null;
      }

      bodyUniforms(progA, uniA);
      bodyUniforms(progT, uniT);
      uniF.fade = gl.getUniformLocation(fadeProg, 'u_fade');
      uniF.fadeColor = gl.getUniformLocation(fadeProg, 'u_fadeColor');
      uniP.scene = gl.getUniformLocation(presentProg, 'u_scene');
      uniOL.viewProj = gl.getUniformLocation(ovlLineProg, 'u_viewProj');
      uniOL.color = gl.getUniformLocation(ovlLineProg, 'u_color');
      uniOL.intensity = gl.getUniformLocation(ovlLineProg, 'u_intensity');
      uniOP.viewProj = gl.getUniformLocation(ovlPtProg, 'u_viewProj');
      uniOP.palette = gl.getUniformLocation(ovlPtProg, 'u_palette');
      uniOP.dpr = gl.getUniformLocation(ovlPtProg, 'u_dpr');
      uniOP.maxPointSize = gl.getUniformLocation(ovlPtProg, 'u_maxPointSize');
      uniOM.viewProj = gl.getUniformLocation(ovlMeshProg, 'u_viewProj');
      uniOM.lightDir = gl.getUniformLocation(ovlMeshProg, 'u_lightDir');

      const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
      maxPointSize = (range && range[1]) ? range[1] : 64;

      // half-float color rendering (for the RGBA16F scene target)
      halfFloatRT = !!(gl.getExtension('EXT_color_buffer_float') ||
                       gl.getExtension('EXT_color_buffer_half_float'));

      // palette is constant — upload once per program
      const pal = new Float32Array(PAL_N * 3);
      for (let i = 0; i < PAL_N; i++) {
        pal[i * 3] = PALETTE[i][0] / 255;
        pal[i * 3 + 1] = PALETTE[i][1] / 255;
        pal[i * 3 + 2] = PALETTE[i][2] / 255;
      }
      gl.useProgram(progA);
      gl.uniform3fv(uniA.palette, pal);
      gl.useProgram(progT);
      gl.uniform3fv(uniT.palette, pal);
      gl.useProgram(ovlPtProg);
      gl.uniform3fv(uniOP.palette, pal);

      dynVao = gl.createVertexArray(); dynVbo = gl.createBuffer();
      opqVao = gl.createVertexArray(); opqVbo = gl.createBuffer();
      bgVao = gl.createVertexArray(); bgVbo = gl.createBuffer();
      texVao = gl.createVertexArray(); texVbo = gl.createBuffer();
      ovlLineVao = gl.createVertexArray(); ovlLineVbo = gl.createBuffer();
      ovlPtVao = gl.createVertexArray(); ovlPtVbo = gl.createBuffer();
      ovlMeshVao = gl.createVertexArray(); ovlMeshVbo = gl.createBuffer();
      ensureDynCapacity(1);
      ensureOpqCapacity(1);
      ensureOvlLineCapacity(1);
      ensureOvlPtCapacity(1);
      ensureOvlMeshCapacity(1);
      buildBackground();

      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      allocTarget();

      // PostFX owns the present pass (lensing + tone) when loaded.
      // init is idempotent so the integrator may also call it.
      const pf = globalThis.PostFX;
      pfOK = !!(pf && pf.init && pf.init(gl));
      if (pfOK) pf.resize(cssW, cssH, dprV);

      this.gl = gl;                      // shared context (PhysicsGPU et al.)
      this.targetFormat = targetFormat;
      return 'webgl2';
    },

    /* Select the body source.
       setSource({ mode:'arrays' })  -> read globalThis.Bodies (default)
       setSource({ mode:'texture', posTex, count, massiveCount,
                   staticAttribs })  -> positions from posTex by slot;
       rebuilds the static VBO, resets attribsVersion tracking. */
    setSource(spec) {
      if (!spec || !spec.mode || spec.mode === 'arrays') {
        source = { mode: 'arrays' };
        return;
      }
      if (spec.mode !== 'texture') {
        throw new Error('Renderer3D.setSource: unknown mode ' + spec.mode);
      }
      source = {
        mode: 'texture',
        posTex: spec.posTex,
        count: spec.count | 0,
        massiveCount: spec.massiveCount | 0,
        staticAttribs: spec.staticAttribs,
      };
      lastAttribsVersion = undefined;
      uploadStaticAttribs();
    },

    resize(w, h, dpr) {
      cssW = Math.max(1, w);
      cssH = Math.max(1, h);
      dprV = dpr || 1;
      canvas.width = Math.max(1, Math.round(w * dprV));
      canvas.height = Math.max(1, Math.round(h * dprV));
      if (gl) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        allocTarget();
        this.targetFormat = targetFormat;
        if (pfOK) globalThis.PostFX.resize(cssW, cssH, dprV);
      }
    },

    /* render({ viewProj, eye, lightPos, trails, timeMs,
                blackHoles, attribsVersion })
       blackHoles: [{x,y,z,mass,rad}] — up to 8 used for lensing.
       attribsVersion: change triggers a massive-region attrib
       re-upload in texture mode. Both optional (v2 callers OK). */
    render(opts) {
      if (!gl) return;
      const viewProj = opts.viewProj;
      const eye = opts.eye || { x: 0, y: 0, z: 0 };
      const light = opts.lightPos || { x: 0, y: 1e4, z: 0 };
      const trails = !!opts.trails;
      const haveTarget = !!targetFormat;

      gl.bindFramebuffer(gl.FRAMEBUFFER, haveTarget ? fbo : null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.enable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(true);

      // ---- background fade / clear (depth always clears) ----
      if (trails && haveTarget) {
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.useProgram(fadeProg);
        gl.uniform1f(uniF.fade, TRAIL_FADE);
        gl.uniform3f(uniF.fadeColor, CLEAR[0], CLEAR[1], CLEAR[2]);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      } else {
        gl.clearColor(CLEAR[0], CLEAR[1], CLEAR[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT | (haveTarget ? gl.DEPTH_BUFFER_BIT : 0));
      }

      // ---- pass 0: additive — background stars first ----
      gl.useProgram(progA);
      setFrameUniforms(uniA, viewProj, eye, light);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(uniA.pass, 0);
      gl.uniform1f(uniA.sizeScale, 6.0);   // glow extends past the body

      // Static far starfield. In trails mode these would accumulate
      // (steady state ≈ alpha/fade), so pre-dim by the fade factor.
      gl.uniform1f(uniA.alphaScale, trails ? 0.55 * TRAIL_FADE : 0.55);
      gl.bindVertexArray(bgVao);
      gl.drawArrays(gl.POINTS, 0, bgCount);

      if (source.mode === 'texture') {
        drawTextureBodies(opts, viewProj, eye, light);
      } else {
        drawArrayBodies(eye);
      }
      gl.bindVertexArray(null);

      // ---- present: FBO -> default framebuffer (lensing lives here) ----
      if (!haveTarget) {
        // emergency direct path: scene already on the default framebuffer.
        drawOverlay(opts.overlay, viewProj);
        return;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      const pf = globalThis.PostFX;
      if (pfOK && pf) {
        pf.apply(sceneTex, {
          blackHoles: opts.blackHoles,
          viewProj,
          viewportH: cssH,
          dpr: dprV,
        });
      } else {
        gl.disable(gl.BLEND);
        gl.useProgram(presentProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sceneTex);
        gl.uniform1i(uniP.scene, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.enable(gl.BLEND);
      }

      // ---- ship overlay: glowing wireframe + markers, in front, in the
      // active node's local frame (same viewProj). No-op without opts. ----
      drawOverlay(opts.overlay, viewProj);
    },
  };

  Renderer3D.PALETTE = PALETTE;
  Renderer3D.PALETTE_N = PAL_N;
  globalThis.Renderer3D = Renderer3D;
})();
