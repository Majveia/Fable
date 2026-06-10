# FABLE UNIVERSE v2 — 3D Architecture

Zero-dependency vanilla JS, no build step. Plain `<script>` tags in this order:

```
js/core/bodies.js      -> globalThis.Bodies
js/core/octree.js      -> globalThis.Octree (class)
js/core/physics.js     -> globalThis.Physics
js/render/camera.js    -> globalThis.Camera3D
js/render/renderer.js  -> globalThis.Renderer3D
js/scenarios.js        -> globalThis.Scenarios
js/main.js             -> boots everything
```

Core files (`js/core/*`) must not touch the DOM — they run headless in Node
for tests. Attach globals via `globalThis`.

Simulation units: G = 1. Right-handed coords, y is "up" for the camera.

## Bodies (js/core/bodies.js)

Parallel typed arrays, swap-pop removal. Capacity 1 << 17.

```js
Bodies = {
  CAP, n,                          // capacity, live count
  px, py, pz, vx, vy, vz,          // Float64Array
  mass,                            // Float64Array
  rad,                             // Float32Array — visual radius, world units
  colorIdx,                        // Uint8Array — palette index (see renderer)
  type,                            // Uint8Array — 0 star, 1 black hole, 2 planet, 3 dust, 4 gas
  names,                           // Array<string|null>
  add(x,y,z, vx,vy,vz, mass, rad, colorIdx, type, name) -> index | -1,
  remove(i),                       // swap-pop, keeps names in sync
  clear(),
}
```

`TYPE_STAR=0, TYPE_BH=1, TYPE_PLANET=2, TYPE_DUST=3, TYPE_GAS=4`
(exported on Bodies as constants too).

## Octree (js/core/octree.js)

Pooled Barnes-Hut octree, rebuilt per step.

```js
class Octree {
  constructor(nodeCapacity)
  build(massiveMin)        // inserts bodies with mass >= massiveMin only;
                           // sets this.builtCount = number inserted
  accel(x, y, z, theta2, soft2, out)  // out = {x,y,z}; explicit-stack traversal
}
```

Internals: 8 children allocated contiguously (`child` = base index or -1),
mass-weighted centroid sums normalized after build, max depth 24 with
coincident-body merge at the cap, traversal stack >= 8192, node pool grows
by doubling. Opening test: `size^2 < theta2 * dist2`. Skip zero-mass children.

## Physics (js/core/physics.js)

```js
Physics = {
  cfg: { dt, substeps, softening, theta2, theta2Base, captureRadius,
         massiveMin: 0.01, timeScale: 1, paused: false, t: 0, myrPerT: 1 },
  tree,                       // the Octree instance
  step(dt),                   // one integration step (see below)
  frame(),                    // substeps × step(dt·timeScale/substeps) unless paused
  setPull(x,y,z, mass) | clearPull(),   // interactive gravity well
  adaptQuality(fps),          // theta2 up when slow (cap 2.25), decay to theta2Base
}
```

`step(dt)`: build tree from massive bodies; for every body i compute
tree accel — massive bodies use `cfg.theta2`, tracers (mass < massiveMin) use
`max(2.25, cfg.theta2 * 2)`; add pull-well force if set; semi-implicit Euler
(v += a·dt then p += v·dt); advance `cfg.t`; black-hole capture: each BH
swallows bodies within `max(captureRadius, rad·0.7)`, conserving mass and
momentum (`rad` grows slightly, capped). Holes found inline (swap-pop safe).

## Camera3D (js/render/camera.js)

Orbit camera with smoothing.

```js
Camera3D = {
  target: {x,y,z}, dist, yaw, pitch, fov,    // pitch clamped ±1.55 rad
  update(dtMs),                              // critically-damped approach to goals
  orbit(dYaw, dPitch), dolly(factor), pan(dxPx, dyPx, viewportH),
  setGoal({targetX,targetY,targetZ,dist,yaw,pitch}),  // smooth transition
  eye() -> {x,y,z},
  viewProj(aspect) -> Float32Array(16),      // column-major, perspective near 0.1 far 1e6
}
```

## Renderer3D (js/render/renderer.js)

```js
Renderer3D = {
  init(canvas) -> 'webgl2' | null,
  resize(w, h, dpr),
  render({ viewProj, eye, lightPos, trails, timeMs }),  // reads Bodies directly
}
```

One dynamic interleaved VBO refreshed per frame. All sprites are gl.POINTS
with perspective size attenuation (`sizePx ∝ rad / w_clip`, clamped to
[1.5, 160]·DPR and hardware max). Per-type fragment behavior:

- star (0): additive radial glow, white-hot core → palette color → transparent
- dust (3): same shader, dimmer/smaller
- gas (4): very large, very soft additive billboard, hue from palette, low alpha
- planet (2): sphere impostor — lambert shading from `lightPos`, slight limb
  darkening, NOT additive (drawn after additive pass, painter-sorted in JS)
- black hole (1): black core disc + bright thin rim + additive halo

Background: ~3000 static far stars on a radius-5e5 sphere, drawn first,
faint, so orbiting the camera gives parallax. Trails: preserveDrawingBuffer,
fade by fullscreen quad with blendFunc(ZERO, ONE_MINUS_SRC_ALPHA), alpha 0.10;
trails-off clears to near-black (#020208).

PALETTE (index → rgb, shared contract):
0..6 stellar O→M as v1, 7 sun-yellow, 8 accretion blue,
9 nebula magenta (210,120,255), 10 nebula teal (90,220,200),
11 dust grey-blue (150,160,200).

## Scenarios (js/scenarios.js)

`Scenarios.list` = ordered array of `{ key, label, init() }`. `init()` fills
Bodies, sets Physics.cfg fields, and returns
`{ camDist, lightPos: {x,y,z} }` for main.js to apply.

## main.js + index.html

Minimal immersive UI: fullscreen canvas; tiny wordmark; bottom-center
scenario dots + label; bottom-right stats (bodies/fps); everything fades
after 3 s idle (CSS class). `h` toggles a help overlay. Input: drag orbit,
shift/right-drag pan, wheel dolly, `space` pause, `t` trails, `r` reset,
`[`/`]` time scale, `b` drop black hole on the focal plane along the cursor
ray, hold `g` for gravity well, `1..7` scenarios, `f` fullscreen.

## Tests

`test/smoke.js` (rewritten for 3D, pure Node, no DOM stubs needed for core):
every scenario† 300 steps → finite positions, bounded median radius, per-step
budget ≤ 35 ms in CI-class hardware, momentum drift sanity, accretion check,
`tree.builtCount < Bodies.n` where dust exists.
† scenarios.js is DOM-free by design so Node can load it.
