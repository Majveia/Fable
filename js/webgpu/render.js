'use strict';
/* ============================================================
   FABLE UNIVERSE v5 — WebGPU renderer (globalThis.RendererWGPU).

   WGSL port of the WebGL2 renderer's visual language
   (js/render/renderer.js — palette, per-type fragment behavior,
   sizing rule, additive-then-opaque pass split, trails fade,
   background starfield), per docs/ARCHITECTURE-WEBGPU.md.

   - Bodies are instanced quads: draw(4, count), triangle-strip.
     The vertex stage pulls posBuf[slot] (xyz pos, w < 0 = dead)
     and attribBuf[slot] (rad, colorIdx, type, 0) — both GPUBuffers
     owned by PhysicsWGPU per the v5 binding contract — projects
     with viewProj and sizes with the same GL point rule:
       sizePx = clamp(rad * k * viewportH / clip.w, 1.5, 160) * dpr
     with k = 6.0 for the additive glow pass and k = 2.2 for the
     opaque pass (the GL renderer's two u_sizeScale values). The
     quad spans sizePx device pixels, exactly like gl_PointSize.
   - Pass 0 (additive, ONE/ONE, no depth): stars, dust, gas haze,
     BH halo rings. Planets emit degenerate quads.
   - Pass 1 (premultiplied over): planet sphere impostors + BH
     core discs, painter-sorted back-to-front on the CPU each
     frame from the Bodies global mirror (it always holds the
     massive set) and drawn through a small per-frame index remap
     storage buffer.
   - ~3000 static far stars on a radius-5e5 sphere, drawn first.
   - Scene accumulates in an rgba16float texture; trails = loadOp
     'load' + a fade quad (dst = clear*0.10 + dst*0.90, the GL
     TRAIL_FADE semantics); otherwise loadOp 'clear' (near-black).
   - PostWGPU (js/webgpu/post.js) owns the present: bloom + lens +
     ACES onto the canvas. It MUST init or init() returns null and
     the app falls back to WebGL entirely (no plain-present path).

   Deviation from the GL renderer noted in the contract: the
   COMPUTE engine owns attribBuf, so attribsVersion needs no
   tracking here — the buffer is read fresh every draw.
   ============================================================ */
(function () {

  // PALETTE per contract: 0..6 stellar O→M, 7 sun-yellow,
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

  const BG_STAR_COUNT = 3000;
  const BG_RADIUS = 5e5;
  const CLEAR = [0.008, 0.008, 0.03]; // opaque near-black (#020208-ish)
  const TRAIL_FADE = 0.10;
  const SIZE_ADDITIVE = 6.0;          // glow extends past the body
  const SIZE_OPAQUE = 2.2;            // solid body, no glow margin
  const SCENE_FORMAT = 'rgba16float';

  /* Body shader: vs_add draws instance = slot directly (additive
     pass over every slot); vs_opq remaps instance -> slot through
     the painter-sorted index buffer. One fragment fn, switched on
     D.pass exactly like the GL FRAG_SRC's u_pass. uv is the GL
     gl_PointCoord*2-1 with y already flipped to screen-up. */
  const BODY_WGSL = `
struct Frame {
  viewProj : mat4x4f,
  eye      : vec4f,    // xyz = camera eye, w = viewport height (CSS px)
  light    : vec4f,    // xyz = world light pos, w = dpr
  viewport : vec4f,    // xy = backing-store pixel size
};
struct DrawParams {
  sizeScale  : f32,    // 6.0 additive, 2.2 opaque
  alphaScale : f32,    // global dimmer (background stars)
  pass       : f32,    // 0 = additive sprites, 1 = opaque impostors
  pad        : f32,
};
@group(0) @binding(0) var<uniform> F : Frame;
@group(0) @binding(1) var<uniform> D : DrawParams;
@group(0) @binding(2) var<storage, read> posBuf : array<vec4f>;
@group(0) @binding(3) var<storage, read> attribBuf : array<vec4f>;
@group(0) @binding(4) var<uniform> palette : array<vec4f, 12>;
@group(0) @binding(5) var<storage, read> remap : array<u32>;   // vs_opq only

struct VOut {
  @builtin(position) clip : vec4f,
  @location(0) uv    : vec2f,   // -1..1 across the sprite, +y screen-up
  @location(1) color : vec3f,
  @location(2) @interpolate(flat) vtype : f32,
  @location(3) world : vec3f,
};

fn bodyVertex(vi : u32, body : u32) -> VOut {
  var o : VOut;                                   // zero-initialized
  let pm = posBuf[body];
  let at = attribBuf[body];                       // rad, colorIdx, type, 0
  let t = at.z;
  let opaqueBody = t > 0.5 && t < 2.5;            // BH or planet
  // dead slot / wrong pass for this type -> degenerate clipped quad
  if (pm.w < 0.0 ||
      (D.pass > 0.5 && !opaqueBody) ||
      (D.pass < 0.5 && t > 1.5 && t < 2.5)) {     // planets skip additive
    o.clip = vec4f(0.0, 0.0, 2.0, 1.0);           // z > w -> clipped away
    return o;
  }
  let clip = F.viewProj * vec4f(pm.xyz, 1.0);
  if (clip.w < 1e-4) {                            // behind the camera
    o.clip = vec4f(0.0, 0.0, 2.0, 1.0);
    return o;
  }
  // GL point-size rule: full sprite size in device pixels
  let sizePx = clamp(at.x * D.sizeScale * F.eye.w / clip.w, 1.5, 160.0)
               * F.light.w;
  let corner = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2.0 - 1.0;
  // half-extent sizePx/2 px -> NDC offset corner * sizePx / viewportPx
  o.clip = vec4f(clip.xy + corner * (sizePx / F.viewport.xy) * clip.w,
                 clip.zw);
  o.uv = corner;
  o.color = palette[min(u32(at.y + 0.5), 11u)].rgb;
  o.vtype = t;
  o.world = pm.xyz;
  return o;
}

@vertex fn vs_add(@builtin(vertex_index) vi : u32,
                  @builtin(instance_index) inst : u32) -> VOut {
  return bodyVertex(vi, inst);
}
@vertex fn vs_opq(@builtin(vertex_index) vi : u32,
                  @builtin(instance_index) inst : u32) -> VOut {
  return bodyVertex(vi, remap[inst]);
}

// v1 sprite falloff: gradient stops 0 / 0.18 / 0.45 / 1.0
fn glowAlpha(d : f32) -> f32 {
  if (d < 0.18) { return mix(1.0, 0.9, d / 0.18); }
  if (d < 0.45) { return mix(0.9, 0.25, (d - 0.18) / 0.27); }
  return mix(0.25, 0.0, (d - 0.45) / 0.55);
}

@fragment fn fs(v : VOut) -> @location(0) vec4f {
  let p = v.uv;
  let d = length(p);
  if (d > 1.0) { discard; }
  let t = v.vtype;

  if (D.pass < 0.5) {
    /* ---------------- additive pass ---------------- */
    var a : f32;
    var col : vec3f;
    if (t > 3.5) {
      // gas: very soft pure-hue haze, no white core
      let fall = 1.0 - smoothstep(0.0, 1.0, d);
      a = 0.07 * fall * fall;
      col = v.color;
    } else if (t > 0.5 && t < 1.5) {
      // black hole halo: bright thin annulus + faint outer glow,
      // center kept dark for the core disc
      let q = (d - 0.34) / 0.06;
      let ring = 0.95 * exp(-q * q);
      let glow = 0.16 * (1.0 - smoothstep(0.22, 1.0, d));
      a = ring + glow;
      if (d < 0.17) { a = 0.0; }
      col = mix(vec3f(0.75, 0.85, 1.0), v.color, 0.45);
    } else {
      // star / dust: white-hot core -> palette color -> transparent
      a = glowAlpha(d);
      col = mix(vec3f(1.0), v.color, smoothstep(0.0, 0.18, d));
      if (t > 2.5) { a *= 0.35; }     // dust is the same but dimmer
    }
    a *= D.alphaScale;
    return vec4f(col * a, a);
  }

  /* ---------------- opaque pass ---------------- */
  let edge = 1.0 - smoothstep(0.92, 1.0, d);      // antialiased rim
  if (edge <= 0.0) { discard; }
  if (t > 1.5 && t < 2.5) {
    // planet sphere impostor: normal from the disc, camera basis from
    // eye (up = +Y), lambert from the world light, ambient 0.08,
    // limb darkening — the GL impostor math verbatim.
    let nz = sqrt(max(0.0, 1.0 - d * d));
    let back = normalize(F.eye.xyz - v.world);
    var rt = cross(vec3f(0.0, 1.0, 0.0), back);
    if (dot(rt, rt) > 1e-6) { rt = normalize(rt); }
    else { rt = vec3f(1.0, 0.0, 0.0); }
    let up = cross(back, rt);
    let n = normalize(rt * p.x + up * p.y + back * nz);
    let L = normalize(F.light.xyz - v.world);
    let diff = max(dot(n, L), 0.0);
    let limb = 0.55 + 0.45 * nz;                  // limb darkening
    let col = v.color * min(1.0, 0.08 + 0.95 * diff) * limb;
    return vec4f(col * edge, edge);
  }
  if (t > 0.5 && t < 1.5) {
    // black hole core: opaque black disc with a thin bright rim
    let rim = smoothstep(0.74, 0.88, d) * (1.0 - smoothstep(0.88, 1.0, d));
    let col = rim * mix(vec3f(0.8, 0.88, 1.0), v.color, 0.4);
    return vec4f(col * edge, edge);
  }
  discard;
  return vec4f(0.0);
}
`;

  /* Trails fade: fullscreen triangle blended ONE/ONE_MINUS_SRC_ALPHA
     so dst = clear*fade + dst*(1-fade) — a multiplicative fade toward
     the opaque near-black background (GL FADE semantics, fade 0.10). */
  const FADE_WGSL = `
@vertex fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f {
  return vec4f(${(CLEAR[0] * TRAIL_FADE).toFixed(6)},
               ${(CLEAR[1] * TRAIL_FADE).toFixed(6)},
               ${(CLEAR[2] * TRAIL_FADE).toFixed(6)},
               ${TRAIL_FADE.toFixed(6)});
}
`;

  // ---------------------------------------------------------------- state
  let device = null, context = null, format = null;
  let pipeAdd = null, pipeOpq = null, pipeFade = null;
  let layoutAdd = null, layoutOpq = null;
  let frameU = null, paletteU = null;
  let drawBgU = null, drawAddU = null, drawOpqU = null;
  let bgPosBuf = null, bgAttribBuf = null, bgGroup = null;
  let sceneTex = null, sceneView = null;
  let source = null, bodyAddGroup = null, bodyOpqGroup = null;
  let remapBuf = null, remapArr = null;
  let cssW = 1, cssH = 1, dprV = 1;
  let lastBgAlpha = -1;
  const frameData = new Float32Array(28);  // viewProj | eye+vpH | light+dpr | viewportPx
  const drawData = new Float32Array(4);
  const order = [];                        // reusable {i, d2} painter-sort records

  function makeLayouts() {
    const V = GPUShaderStage.VERTEX, FR = GPUShaderStage.FRAGMENT;
    const e = (binding, visibility, type) => ({ binding, visibility, buffer: { type } });
    const base = [
      e(0, V | FR, 'uniform'),            // Frame
      e(1, V | FR, 'uniform'),            // DrawParams
      e(2, V, 'read-only-storage'),       // posBuf
      e(3, V, 'read-only-storage'),       // attribBuf
      e(4, V, 'uniform'),                 // palette
    ];
    layoutAdd = device.createBindGroupLayout({ entries: base });
    layoutOpq = device.createBindGroupLayout({
      entries: base.concat([e(5, V, 'read-only-storage')]),  // remap
    });
  }

  function makePipelines() {
    const mod = device.createShaderModule({ code: BODY_WGSL });
    const fadeMod = device.createShaderModule({ code: FADE_WGSL });
    const addBlend = {
      color: { srcFactor: 'one', dstFactor: 'one' },
      alpha: { srcFactor: 'one', dstFactor: 'one' },
    };
    const overBlend = {                   // premultiplied 'normal'
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    };
    pipeAdd = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layoutAdd] }),
      vertex: { module: mod, entryPoint: 'vs_add' },
      fragment: { module: mod, entryPoint: 'fs',
                  targets: [{ format: SCENE_FORMAT, blend: addBlend }] },
      primitive: { topology: 'triangle-strip' },
    });
    pipeOpq = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layoutOpq] }),
      vertex: { module: mod, entryPoint: 'vs_opq' },
      fragment: { module: mod, entryPoint: 'fs',
                  targets: [{ format: SCENE_FORMAT, blend: overBlend }] },
      primitive: { topology: 'triangle-strip' },
    });
    pipeFade = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: fadeMod, entryPoint: 'vs' },
      fragment: { module: fadeMod, entryPoint: 'fs',
                  targets: [{ format: SCENE_FORMAT, blend: overBlend }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  function uniformBuf(bytes) {
    return device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  function storageBuf(data) {
    const b = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(b, 0, data);
    return b;
  }

  /* ~3000 static far stars on a sphere — same population as the GL
     renderer's buildBackground(): tiny radii (most clamp to the 1.5px
     floor), cool-dwarf-dominated colors. Stored as the standard
     posBuf/attribBuf vec4f pair so the additive pipeline draws them. */
  function buildBackground() {
    const pos = new Float32Array(BG_STAR_COUNT * 4);
    const att = new Float32Array(BG_STAR_COUNT * 4);
    for (let i = 0; i < BG_STAR_COUNT; i++) {
      const z = Math.random() * 2 - 1;
      const phi = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z);
      pos[i * 4] = BG_RADIUS * s * Math.cos(phi);
      pos[i * 4 + 1] = BG_RADIUS * z;
      pos[i * 4 + 2] = BG_RADIUS * s * Math.sin(phi);
      pos[i * 4 + 3] = 1;                 // alive
      att[i * 4] = 120 + 700 * Math.pow(Math.random(), 4);
      const u = Math.random();
      att[i * 4 + 1] =
        u < 0.40 ? 6 : u < 0.62 ? 5 : u < 0.80 ? 4 :
        u < 0.90 ? 3 : u < 0.96 ? 2 : u < 0.99 ? 1 : 0;
      att[i * 4 + 2] = 0;                 // type star
      att[i * 4 + 3] = 0;
    }
    bgPosBuf = storageBuf(pos);
    bgAttribBuf = storageBuf(att);
    bgGroup = device.createBindGroup({
      layout: layoutAdd,
      entries: [
        { binding: 0, resource: { buffer: frameU } },
        { binding: 1, resource: { buffer: drawBgU } },
        { binding: 2, resource: { buffer: bgPosBuf } },
        { binding: 3, resource: { buffer: bgAttribBuf } },
        { binding: 4, resource: { buffer: paletteU } },
      ],
    });
  }

  /* (Re)allocate the rgba16float scene texture at the canvas size. */
  function allocTarget() {
    const canvas = context.canvas;
    const w = Math.max(1, canvas.width), h = Math.max(1, canvas.height);
    if (sceneTex) sceneTex.destroy();
    sceneTex = device.createTexture({
      size: [w, h],
      format: SCENE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    sceneView = sceneTex.createView();
  }

  function makeBodyGroups() {
    if (!source) return;
    const base = [
      { binding: 0, resource: { buffer: frameU } },
      { binding: 1, resource: { buffer: drawAddU } },
      { binding: 2, resource: { buffer: source.posBuf } },
      { binding: 3, resource: { buffer: source.attribBuf } },
      { binding: 4, resource: { buffer: paletteU } },
    ];
    bodyAddGroup = device.createBindGroup({ layout: layoutAdd, entries: base });
    bodyOpqGroup = device.createBindGroup({
      layout: layoutOpq,
      entries: base.map((e) => e.binding === 1
        ? { binding: 1, resource: { buffer: drawOpqU } } : e)
        .concat([{ binding: 5, resource: { buffer: remapBuf } }]),
    });
  }

  function ensureRemap(count) {
    if (remapArr && count <= remapArr.length) return;
    let cap = remapArr ? remapArr.length : 256;
    while (cap < count) cap *= 2;
    remapArr = new Uint32Array(cap);
    if (remapBuf) remapBuf.destroy();
    remapBuf = device.createBuffer({
      size: cap * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    makeBodyGroups();                     // opq group references remapBuf
  }

  const RendererWGPU = {

    /* init(wgpu) — wgpu = { device, context, format } from WGPU.boot
       (or an equivalent inline boot). Returns 'webgpu' or null; null
       means the app must fall back to WebGL entirely (PostWGPU is
       required — there is no plain-present path). */
    init(wgpu) {
      if (!wgpu || !wgpu.device || !wgpu.context || !wgpu.format) return null;
      device = wgpu.device;
      context = wgpu.context;
      format = wgpu.format;
      try {
        makeLayouts();
        makePipelines();

        frameU = uniformBuf(frameData.byteLength);
        drawBgU = uniformBuf(16);
        drawAddU = uniformBuf(16);
        drawOpqU = uniformBuf(16);
        device.queue.writeBuffer(drawAddU, 0,
          new Float32Array([SIZE_ADDITIVE, 1.0, 0, 0]));
        device.queue.writeBuffer(drawOpqU, 0,
          new Float32Array([SIZE_OPAQUE, 1.0, 1, 0]));

        // palette is constant — upload once as array<vec4f, 12>
        const pal = new Float32Array(48);
        for (let i = 0; i < 12; i++) {
          pal[i * 4] = PALETTE[i][0] / 255;
          pal[i * 4 + 1] = PALETTE[i][1] / 255;
          pal[i * 4 + 2] = PALETTE[i][2] / 255;
          pal[i * 4 + 3] = 1;
        }
        paletteU = uniformBuf(pal.byteLength);
        device.queue.writeBuffer(paletteU, 0, pal);

        buildBackground();
        ensureRemap(1);
        allocTarget();

        const post = globalThis.PostWGPU;
        if (!post || !post.init || !post.init(wgpu)) return null;
      } catch (e) {
        console.warn('RendererWGPU init failed:', e && e.message);
        return null;
      }
      return 'webgpu';
    },

    /* setSource({ posBuf, velBuf, attribBuf, count, massiveCount }) —
       GPUBuffers owned by PhysicsWGPU, array<vec4f> per the v5
       contract. velBuf is accepted for surface parity but unused
       (type lives in attribBuf.z for rendering). */
    setSource(spec) {
      if (!spec || !spec.posBuf || !spec.attribBuf) {
        source = null;
        bodyAddGroup = null;
        bodyOpqGroup = null;
        return;
      }
      source = {
        posBuf: spec.posBuf,
        velBuf: spec.velBuf || null,
        attribBuf: spec.attribBuf,
        count: spec.count | 0,
        massiveCount: spec.massiveCount | 0,
      };
      makeBodyGroups();
    },

    resize(w, h, dpr) {
      cssW = Math.max(1, w);
      cssH = Math.max(1, h);
      dprV = dpr || 1;
      const canvas = context.canvas;
      canvas.width = Math.max(1, Math.round(cssW * dprV));
      canvas.height = Math.max(1, Math.round(cssH * dprV));
      allocTarget();
      globalThis.PostWGPU.resize(cssW, cssH, dprV);
    },

    /* render({ viewProj, eye, lightPos, trails, timeMs, blackHoles,
                attribsVersion }) — the Renderer3D opts surface.
       viewProj: Float32Array(16) column-major; WGSL mat4x4f shares
       the layout so it uploads directly. attribsVersion is ignored:
       the compute engine owns attribBuf and rewrites the massive
       region itself; we read the buffer fresh each draw. */
    render(opts) {
      if (!device || !sceneView || !opts || !opts.viewProj) return;
      const eye = opts.eye || { x: 0, y: 0, z: 0 };
      const light = opts.lightPos || { x: 0, y: 1e4, z: 0 };
      const trails = !!opts.trails;
      const canvas = context.canvas;

      frameData.set(opts.viewProj, 0);
      frameData[16] = eye.x; frameData[17] = eye.y; frameData[18] = eye.z;
      frameData[19] = cssH;
      frameData[20] = light.x; frameData[21] = light.y; frameData[22] = light.z;
      frameData[23] = dprV;
      frameData[24] = canvas.width; frameData[25] = canvas.height;
      device.queue.writeBuffer(frameU, 0, frameData);

      // Static far starfield pre-dims by the fade factor in trails
      // mode (steady state ≈ alpha/fade), exactly like the GL path.
      const bgAlpha = trails ? 0.55 * TRAIL_FADE : 0.55;
      if (bgAlpha !== lastBgAlpha) {
        lastBgAlpha = bgAlpha;
        drawData[0] = SIZE_ADDITIVE; drawData[1] = bgAlpha;
        drawData[2] = 0; drawData[3] = 0;
        device.queue.writeBuffer(drawBgU, 0, drawData);
      }

      // ---- CPU painter sort of the few planets/BHs (back-to-front).
      // Positions come from the Bodies global mirror — it always holds
      // the massive set, slot-aligned with the GPU buffers.
      let opqCount = 0;
      const B = globalThis.Bodies;
      if (source && source.count > 0 && B && B.n > 0) {
        const n = Math.min(B.n, source.count);
        const px = B.px, py = B.py, pz = B.pz, ty = B.type;
        order.length = 0;
        for (let i = 0; i < n; i++) {
          const t = ty[i];
          if (t === 1 || t === 2) {       // BH or planet
            const dx = px[i] - eye.x, dy = py[i] - eye.y, dz = pz[i] - eye.z;
            order.push({ i, d2: dx * dx + dy * dy + dz * dz });
          }
        }
        opqCount = order.length;
        if (opqCount > 0) {
          order.sort((a, b) => b.d2 - a.d2);  // far first
          ensureRemap(opqCount);
          for (let k = 0; k < opqCount; k++) remapArr[k] = order[k].i;
          device.queue.writeBuffer(remapBuf, 0, remapArr, 0, opqCount);
        }
      }

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: sceneView,
          loadOp: trails ? 'load' : 'clear',
          clearValue: { r: CLEAR[0], g: CLEAR[1], b: CLEAR[2], a: 1 },
          storeOp: 'store',
        }],
      });

      // ---- background fade (trails) ----
      if (trails) {
        pass.setPipeline(pipeFade);
        pass.draw(3);
      }

      // ---- pass 0: additive — background stars first ----
      pass.setPipeline(pipeAdd);
      pass.setBindGroup(0, bgGroup);
      pass.draw(4, BG_STAR_COUNT);

      if (source && source.count > 0 && bodyAddGroup) {
        pass.setBindGroup(0, bodyAddGroup);
        pass.draw(4, source.count);

        // ---- pass 1: opaque impostors, painter-sorted ----
        if (opqCount > 0 && bodyOpqGroup) {
          pass.setPipeline(pipeOpq);
          pass.setBindGroup(0, bodyOpqGroup);
          pass.draw(4, opqCount);
        }
      }
      pass.end();

      // ---- present: bloom + lens + ACES onto the canvas ----
      globalThis.PostWGPU.apply(encoder, sceneView, {
        blackHoles: opts.blackHoles,
        viewProj: opts.viewProj,
        viewportH: cssH,
        dpr: dprV,
      });

      device.queue.submit([encoder.finish()]);
    },
  };

  RendererWGPU.PALETTE = PALETTE;
  globalThis.RendererWGPU = RendererWGPU;
})();
