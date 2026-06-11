# FABLE UNIVERSE v5 — WebGPU Compute Milestone

Addendum to ARCHITECTURE.md / ARCHITECTURE-GPU.md. Target: **2,097,152
bodies** (1 << 21) via WGSL compute, with the existing WebGL2 hybrid and
CPU engines as automatic fallbacks. WebGPU cannot share a canvas with
WebGL, so WebGPU mode swaps BOTH the engine and the renderer:

```
boot chain (js/main.js, async):
  await WGPU.boot(canvas)  -> PhysicsWGPU + RendererWGPU   (js/webgpu/*)
  else WebGL2 + EXT_color_buffer_float -> PhysicsGPU + Renderer3D
  else WebGL2 -> Physics (CPU) + Renderer3D
```

Both new modules implement the EXISTING surfaces (engine surface from
ARCHITECTURE-GPU.md: cfg/frame/upload/setPull/clearPull/addMassive/
addBurst/evolutionView/blackHoleList/adaptQuality/bodyCount/simTimeMyr;
renderer surface: init/resize/render(opts)). main.js stays
engine-agnostic. Camera3D, Bodies, Octree, TreePack, Evolution,
Scenarios, DarkMatter are shared untouched.

## What stays on the CPU (deliberately)

The octree. Per-frame: async readback of the massive mirror (≤ 32k
bodies) → capture among massive → tree rebuild → TreePack.flatten →
write tree storage buffer. TreePack's 8-float node encoding
(comX,comY,comZ,mass | size²,hit,miss,unused) is reused VERBATIM — the
flat array uploads as `array<vec4f>` with node i at indices 2i, 2i+1.
GPU tree construction (Morton/LBVH) is out of scope.

## Buffer layout (the binding contract)

All storage buffers `array<vec4f>` unless noted. Compute pipeline
@group(0):

| binding | buffer | contents |
|---|---|---|
| 0 | posBuf  (read_write) | xyz = position, w = alive (>=0) / dead (<0) |
| 1 | velBuf  (read_write) | xyz = velocity, w = type (0 star,1 BH,2 planet,3 dust,4 gas) |
| 2 | treeBuf (read)       | TreePack nodes, 2 vec4f per node |
| 3 | simU (uniform)       | struct SimParams (below) |
| 4 | bhBuf (read)         | 16 × vec4f: xyz + capture radius |
| 5 | haloBuf (read)       | 64 × (vec4f A: xyz + v0², vec4f B: rc², rMax², 0, 0) interleaved A,B |

```wgsl
struct SimParams {
  dt: f32, soft2: f32, thetaM: f32, thetaT: f32,
  count: u32, massiveCount: u32, nbh: u32, nhalo: u32,
  pull: vec4f,            // xyz + mass (0 = off)
}
```

Integration is IN PLACE (each invocation reads/writes only its own
slot; forces come from treeBuf, so no ping-pong). Workgroup size 64,
dispatch ceil(count / 64). The kernel is the WGSL transcription of the
proven GLSL: DKD leapfrog, stackless hit/miss traversal (max 8192
iterations), per-body theta (massive vs tracer), halos, pull well,
in-shader tracer capture against ≤16 BHs.

Slot layout identical to v3: [0, M) massive · [M, M+64) spare massive ·
[M+64, …) tracers · final 16384 = remnant-shell pool.

Readback: copy massive pos+vel regions into a staging buffer ring
(2 buffers), `mapAsync` — consume whichever is ready; the mirror just
runs a frame or two stale. Never block. Point writes (capture deaths,
addMassive, addBurst) via queue.writeBuffer.

## RendererWGPU (js/webgpu/render.js + js/webgpu/post.js)

Same visual language as Renderer3D, in WGSL:
- Bodies as instanced quads (4-vertex triangle-strip, instance =
  body slot): vertex stage pulls posBuf[slot] + attribBuf[slot]
  (vec4f: rad, colorIdx, type, 0), projects, sizes with the same
  clamp(rad·k·viewportH / w, 1.5, 160)·dpr rule; w<0 or slot>=count →
  degenerate (zero-size) quad.
- Fragment per type: star additive glow / dust dim / gas soft haze /
  planet lambert impostor with terminator / BH halo+core. Additive
  passes first (blend one,one), then opaque (planets+BH cores)
  painter-sorted on CPU (few). PALETTE as a uniform array, indices
  0..11 as in the GL contract.
- Background starfield: own small static buffer, drawn first.
- Scene target rgba16float; trails = skip clear + fade quad
  (multiplicative, alpha 0.10). Post (post.js): bright-pass half-res →
  separable blur → composite with lens warp (same Einstein math, ≤8
  BHs) + photon ring + shadow + ACES → canvas (preferred format).
- Depth: none (additive) — matches the GL renderer's look.

RendererWGPU.render(opts) takes the SAME opts as Renderer3D.render
(viewProj, eye, lightPos, trails, timeMs, blackHoles, attribsVersion —
re-upload massive attrib region on version change).

## WGPU.boot (owner: compute agent, tiny)

`js/webgpu/boot.js`: `WGPU.boot(canvas)` → requestAdapter (prefer
high-performance) → requestDevice (require maxStorageBufferBindingSize
≥ 256 MB? No: pos/vel are 32 MB each at 2M — defaults suffice; request
nothing exotic) → configure canvas context (alphaMode opaque) → expose
{ device, context, format } on globalThis.WGPU. Returns null anywhere
unsupported. PhysicsWGPU.init(WGPU, {maxBodies}) and
RendererWGPU.init(WGPU) consume it.

## Budgets & scenarios

`budget.maxBodies` = 1<<21 in WebGPU mode (main.js). Scenarios scale
tracer populations from budget.maxBodies (massive counts stay ≤ ~30k —
the CPU tree is the cap): galaxy ≈ 550k, collision ≈ 800k, supercluster
≈ 1.9M. CPU/WebGL counts unchanged.

## Verification

- dev/wgpu-harness.html: same protocol as dev/gpu-harness.html
  (window.__result with radErr/finite/burstOk) on PhysicsWGPU.
- dev/wgpu-render-harness.html: synthetic buffers, screenshot-verified.
- Headless Chromium may need flags: try
  `--enable-unsafe-webgpu --enable-features=Vulkan` and
  `--use-webgpu-adapter=swiftshader`. If no adapter exists in the
  environment, the agent must still ship code verified to the maximum
  extent available and report exactly what was and wasn't verified.
- test/wgpu.browser.test.js (integrator-owned): adapter-tolerant — CI
  SKIPS (passes with a notice) when no adapter; the WebGL job remains
  the hard gate.

## Ownership (parallel build — do not cross)

- **A (compute)**: js/webgpu/boot.js, js/webgpu/compute.js,
  dev/wgpu-harness.html
- **B (render)**: js/webgpu/render.js, js/webgpu/post.js,
  dev/wgpu-render-harness.html
- **Integrator**: main.js boot chain, scenarios scaling, index.html,
  test/wgpu.browser.test.js, ci.yml, README

COMMIT INCREMENTALLY — after each working unit, not only at the end.
