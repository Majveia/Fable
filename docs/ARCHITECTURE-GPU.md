# FABLE UNIVERSE v3 — GPU Compute, Lensing, Evolution, Scale

Addendum to ARCHITECTURE.md. Same rules: zero dependencies, plain script
tags, core logic DOM-free where possible. New script order:

```
js/core/bodies.js
js/core/octree.js
js/core/treepack.js      -> octree -> texture flattening   (NEW)
js/core/physics.js       -> CPU engine (fallback, unchanged surface)
js/core/physics-gpu.js   -> globalThis.PhysicsGPU          (NEW)
js/core/evolution.js     -> globalThis.Evolution           (NEW)
js/render/camera.js
js/render/renderer.js    -> texture-sourced mode + FBO pipeline (UPGRADED)
js/render/postfx.js      -> gravitational lensing pass     (NEW)
js/scenarios.js          -> budget-aware init(budget)      (UPGRADED)
js/main.js               -> engine select + wiring
```

## GPU physics (hybrid Barnes-Hut)

Why hybrid: WebGL2 has no compute; all-pairs O(n²) dies above ~50k. So:
CPU builds the octree over massive bodies only (≤ 24k), flattens it to a
texture; a fragment-shader pass integrates ALL bodies (≤ 524288) against
that tree with **stackless escape-pointer traversal**; positions stay on
the GPU and are consumed directly by the renderer.

### Body slots (GPU mode)

Fixed slots, never swap-popped. Scenario fills the normal `Bodies` store,
then `PhysicsGPU.upload()` partitions it: massive bodies (mass >=
cfg.massiveMin, plus ALL black holes) into slots `[0, M)`, tracers into
`[M, N)`, plus `SPARE = 64` initially-dead massive slots in `[M, M+64)`
(so tracer slots actually begin at M+64). Dead = posTex.w < 0. Upload
computes the permutation; original Bodies order need not be sorted.

### Textures (all RGBA32F, width 2048, row-major by slot)

- `posTex`  : xyz = position, w = mass (w = -1 dead)
- `velTex`  : xyz = velocity, w = type (0 star, 1 BH, 2 planet, 3 dust, 4 gas)
- `treeTex` : 2 texels/node:
  T0 = (comX, comY, comZ, mass), T1 = (size², hitIndex, missIndex, leafBody)
  hit = first child (descend), miss = next sibling / ancestor's sibling
  (escape). Traversal: `i = root; while (i >= 0) { if (open) i = hit else
  { accumulate; i = miss } }` — opening test `size² >= theta2 * dist²`.
- Ping-pong pos/vel pairs; integration = fragment pass over an N-texel
  quad: read pos/vel, traverse treeTex, semi-implicit Euler, write both
  (MRT with 2 color attachments). Requires `EXT_color_buffer_float`
  (init fails → CPU fallback).

### PhysicsGPU (js/core/physics-gpu.js)

```js
PhysicsGPU = {
  cfg,                                  // same shape as Physics.cfg
  init(gl, { maxBodies: 1<<19 }) -> bool,
  upload() -> { count, massiveCount },  // from Bodies; builds slot tables
  frame(),                              // substeps; tree rebuild from mirror
  setPull(x,y,z,mass) | clearPull(),
  adaptQuality(fps),
  posTex, count, massiveCount,          // renderer source
  staticAttribs,                        // Float32Array slot-ordered [rad, colorIdx, type] ×N
  attribsVersion,                       // bump => renderer re-uploads massive VBO region
  evolutionView() -> mirror view (see Evolution),
  blackHoleList() -> [{x,y,z,mass,rad}],// from mirror, sorted by mass desc
  addMassive(x,y,z,vx,vy,vz,m,rad,c,type) -> slot|-1,  // uses spare slots
  simTimeMyr() -> cfg.t * cfg.myrPerT,
  bodyCount() -> live count,
}
```

Per frame: (1) async-read massive region of pos/vel (PIXEL_PACK_BUFFER +
fence, 1-frame latency; sync readPixels fallback) into the **massive
mirror** (CPU Float64 arrays, slot-ordered); (2) CPU on mirror: BH capture
among massive (momentum-conserving — write merged BH vel/mass and victim
death back via texSubImage), tree rebuild + treepack upload; (3) GPU
integration pass(es). Tracer capture happens IN-SHADER against a uniform
list of the ≤16 heaviest black holes (uniform vec4 pos+captureR): inside →
w = -1 (tracer mass is negligible, so skipping the mass transfer is
physically honest). The pull well is a uniform force term in the shader.

### treepack.js

`TreePack.flatten(octree) -> { data: Float32Array, nodeCount }` —
escape-pointer linearization (preorder; miss of last child = parent's
miss). Pure function, Node-testable against a reference recursive
traversal.

## Renderer upgrades (js/render/renderer.js — owner: renderer agent)

- `Renderer3D.setSource({ mode:'texture', posTex, count, massiveCount,
  staticAttribs })` or `{ mode:'arrays' }` (default, reads Bodies as today).
  Texture mode: position via `texelFetch(posTex, slot)` using gl_VertexID;
  rad/colorIdx/type from a static VBO (massive region re-uploaded when
  the engine's attribsVersion changes); w<0 → gl_PointSize 0.
- **Scene-to-FBO pipeline**: scene (RGBA16F or 8-bit fallback) accumulates
  in an FBO; trails = don't clear + fade quad INSIDE the FBO (drop the
  preserveDrawingBuffer trick); then postfx pass to screen every frame.
- `render(opts)` gains `blackHoles: [{x,y,z,mass,rad}]` (≤8 used).

## Lensing (js/render/postfx.js)

Screen-space point-lens warp per black hole (≤8): for pixel offset θ from
BH screen center, sample the scene at β = θ·(1 − θE²/|θ|²) (Einstein
deflection; |θ|<θE flips — correct, keep it). θE_px =
k·sqrt(mass)/dist·viewportH, clamped to ≤ 18% of viewport height. Inside
~0.45·θE: black shadow disc. Photon ring: brightness boost where
||θ|−θE·1.08| is small. Smooth falloff so far pixels are untouched (skip
work with an early-out). Works in BOTH engine modes.

## Stellar evolution (js/core/evolution.js — DOM-free)

Operates on a *view* (works for CPU Bodies and the GPU massive mirror):
`{ n, mass, rad, colorIdx, type, setDirty() }` plus Evolution-owned
parallel state (age, lifetime, phase) sized on `Evolution.reset(view, seed)`.

`Evolution.step(view, dtMyr)`:
- Only TYPE_STAR evolves. Lifetime ∝ class: hot O/B/A (colorIdx 0–2)
  die within ~0.5–2 demo-minutes of sim time; G/K/M effectively immortal
  at demo timescales.
- Phases: main sequence → red giant (color slides toward palette 6,
  rad ×1.6, last ~15% of life) → **supernova** (rad ×6, white flash,
  ~2 s) → remnant: white dwarf (tiny, palette 3) or neutron star (tiny,
  palette 8) or, for the most massive few percent, **a black hole**
  (type → TYPE_BH, palette 8, rad 2) which immediately starts feeding via
  the engines' capture logic. Supernova mass loss: ×0.2 stays.
- Deterministic given seed. Calls `view.setDirty()` when visuals change.
- Engines/main call it every ~10 frames with accumulated dtMyr.

## Scenarios: budget + scale (owner: evolution/scenarios agent)

`init(budget)` where `budget = { gpu: bool, maxBodies }`. Each scenario
scales its populations ~6–10x in GPU mode (galaxy ≈ 150k, collision ≈
200k). CPU counts stay exactly as today. Plus:
- **solar**: Earth's Moon; Io/Europa/Ganymede/Callisto around Jupiter;
  Titan at Saturn — real relative spacing, circular orbits about their
  planet (`about` mechanics already exist for Saturn's ring). Planet
  masses/dt already resolve these (verify in the smoke test: moons stay
  bound to their planet for 300 steps).
- **supercluster** (NEW, 8th scenario): cosmic web of 40–60 dwarf
  galaxies along 3–4 filaments, mild Hubble flow + mutual attraction →
  mergers over minutes. GPU: ~20k massive + ~480k tracers ≈ 500k total;
  CPU: ~25k total. dt 0.5, softening 12.
- smoke.js: pass `{gpu:false, maxBodies: 1<<17}`, add moon-boundness and
  supercluster checks; evolution gets its own Node test (test/evolution.test.js).

## Ownership (parallel build — do not cross)

- **A (gpu)**: physics-gpu.js, treepack.js, bodies.js CAP→1<<19,
  dev/gpu-harness.html, test/treepack.test.js
- **B (render)**: renderer.js, postfx.js, camera.js (if needed),
  dev/render-harness.html
- **C (cosmos)**: evolution.js, scenarios.js, test/evolution.test.js,
  test/smoke.js
- **Integrator**: main.js, index.html, ci.yml, README
