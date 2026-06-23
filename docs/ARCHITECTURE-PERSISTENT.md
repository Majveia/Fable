# FABLE UNIVERSE v6 — The Persistent Universe

The shift: eight scenarios become **one continuous, persistent universe**.
A single seed generates a supercluster; you fly — in one unbroken camera
flight — from the cosmic web into a galaxy, down to a star system, onto a
planet, around its moons. The universe is saved to IndexedDB and **ages
while you are away**. No scenario switching; the old scenarios remain as a
separate "sandbox" menu.

Three hard problems, three modules. All of `js/cosmos/*` is DOM-free and
Node-testable (IndexedDB has an in-memory shim for tests).

```
js/cosmos/cosmos.js     -> globalThis.Cosmos      (procedural gen + analytic aging)
js/cosmos/navigator.js  -> globalThis.Navigator   (floating origin + LOD + transitions)
js/cosmos/persist.js    -> globalThis.Persist     (IndexedDB save/load/age, + shim)
```

Shared, untouched: Bodies, Octree, TreePack, Physics, PhysicsGPU,
Evolution, DarkMatter, Camera3D, the renderers, scenarios (sandbox).

## The core idea — continuous full physics where you are, analytic
## everywhere else and across time gaps

Exactly ONE node is **active**: its body population is generated into the
global Bodies store and simulated at full fidelity by the existing engine.
Every other node is **context**: rendered cheaply (billboard / point /
analytic orbit), never live-simulated. Across save/reload gaps, and for
distant nodes, the universe advances **analytically** (O(nodes), not
O(bodies)): galaxies rotate by phase, stars advance evolution clocks, the
web drifts. Re-entering a node regenerates its live population at the aged
phase. This is the only tractable way to "age 100 Myr while away."

## Coordinates & floating origin (the precision problem)

Absolute coordinates are float64 (plain JS numbers), astronomically large.
The renderer/engine only ever see coordinates **relative to the active
node's center** — kept small, float32-safe. Crossing into a new node
**rebases**: recompute camera + visible context relative to the new
origin. Navigator owns this.

## Cosmos (js/cosmos/cosmos.js) — owner: Agent A

Deterministic hierarchy from one seed. Lazy: children generated on first
access, cached. Mulberry32 RNG hashed with node id (copy the pattern from
evolution.js / scenarios.js — seeded, reproducible).

```js
Cosmos.create(seed) -> root node, sets Cosmos.root, Cosmos.clockMyr = 0
Cosmos.clockMyr                         // universe age, advanced by main loop
Cosmos.ageTo(myr)                       // analytic: set phases for clock = myr

// Node (plain object; methods via prototype or closures):
node = {
  id: string,            // stable path id, e.g. "u/g7/s3/p2" — RNG seed source
  kind: 'universe'|'galaxy'|'system'|'planet',
  depth: 0..3,
  ac: [x,y,z],           // ABSOLUTE center, float64, universe frame
  radius: number,        // node's spatial extent (same units throughout)
  parent: node|null,
  // analytic state at Cosmos.clockMyr (set by ageTo):
  phase: number,         // rotation/orbital phase, radians
  // visual summary for context rendering (no body gen needed):
  summary: { colorIdx, brightness, kind },
}
node.children() -> node[]               // lazy, cached, deterministic
node.populate(budget, out) -> { bodies, cfg, light }
    // Fill the GLOBAL Bodies store (out === globalThis.Bodies) with this
    // node's full live population in LOCAL coords (relative to node.ac),
    // and return the Physics.cfg overrides + light position. REUSE the
    // existing generators: a 'galaxy' node calls the same disk/bulge/halo
    // code as scenarios.makeGalaxy; a 'system' builds star+planets+belts
    // like the solar scenario; 'planet' builds planet+moons; 'universe'
    // builds the ~50-galaxy web like the supercluster. Populations scale
    // to `budget` (gpu/maxBodies) exactly as scenarios do.
    // Velocities/phase must respect node.phase so re-entry after aging is
    // continuous (a galaxy re-entered at phase π is rotated half a turn).
```

Hierarchy fan-out (tune for quality, keep visitable counts modest):
universe → ~50 galaxies; galaxy → ~12 visitable systems (+ the visual star
sea from populate); system → star + 2–8 planets; planet → 0–4 moons
(moons are bodies within the planet node, not separate nodes — depth caps
at 3). Absolute centers: galaxies along web filaments (reuse the
supercluster filament sampling); systems on the galaxy disk at their orbital
radius; planets at orbital radii around the star.

`Cosmos.ageTo(myr)`: for every CACHED node, advance `phase` by its angular
rate × Δmyr (Keplerian: galaxies slow, planets fast); let Evolution-style
star aging be handled at populate time from the node's age. Pure, no bodies.

`test/cosmos.test.js` (Agent A): determinism (same seed → identical ids,
ac, radii two runs); laziness (children cached, same identity); aging
monotonic + reversible (ageTo(t) then ageTo(t) idempotent; phase advances
with t); populate fills Bodies with finite local coords within node.radius
and count ≤ budget.maxBodies; id→seed stability.

## Navigator (js/cosmos/navigator.js) — owner: Agent B

Given the camera and the cosmos, pick the active node, drive transitions,
own the floating origin.

```js
Navigator.init(cosmos, camera)          // camera = Camera3D
Navigator.active                        // current active node
Navigator.origin                        // [x,y,z] absolute = active.ac
Navigator.update(dtMs) -> {
  changed: bool,                        // active node changed this frame
  active, context: node[],              // context = ancestors + their children
                                        //   within view, capped (~64), each
                                        //   with a LOCAL-frame position+summary
}
Navigator.toLocal(ac) -> [x,y,z]        // absolute -> active-relative (float32 safe)
Navigator.descendTarget()               // nearest child the camera is entering, or null
Navigator.focusNode(node)               // jump active to node (used on load / teleport)
```

Active-node rule with hysteresis (no flapping):
- camera distance from active.ac (world) call it D.
- ascend: if D > active.radius * 3 and active.parent, active = parent (rebase).
- descend: if a child C has D_toC < C.radius * 1.5 and camera closing, active = C.
- on any change: rebase — Navigator.origin = active.ac; the main loop calls
  engine populate for the new active node and re-centers Camera3D so the
  view is continuous (no visual jump): newCamTarget = toLocal(oldOrigin + oldLocalTarget).

Context list: active's parent (as a backdrop), parent's other children
(points/billboards), and active's own children (so you SEE the planets you
can descend into) — each {node, localPos:[x,y,z], summary}. Cap ~64 by
nearest. The renderer draws these as simple additive sprites/rings; they
are NOT in the Bodies store.

`test/navigator.test.js` (Agent B): synthetic camera path (fly from
universe center toward a galaxy toward a system) crosses the expected
active-node sequence universe→galaxy→system→planet and back; rebase keeps
toLocal(camera) bounded (< ~1e5) at every step; hysteresis (no oscillation
when parked at a boundary across 1000 frames); focusNode sets origin = ac.

## Persist (js/cosmos/persist.js) — owner: integrator

IndexedDB store 'fable' key 'universe': `{ seed, clockMyr, lastVisitMs,
edits[] }`. In-memory shim when indexedDB is absent (Node/tests).

```js
await Persist.load() -> { seed, clockMyr, edits } | null
await Persist.save({ seed, clockMyr, edits })
Persist.ageDelta(lastVisitMs, nowMs) -> myr   // AGE_RATE: 1 real hour = 200 Myr, capped 5000
```

On boot: load; if present, Cosmos.create(seed), Cosmos.ageTo(clockMyr +
ageDelta), toast "your universe aged N Myr while you were away"; else new
random seed. Autosave every ~10 s and on visibilitychange/pagehide.
`edits` = user-dropped black holes etc. as {nodeId, ...}; replayed on the
active node when it loads. v6 may ship edits as an empty-array stub if time
is short — persistence of seed+clock is the must-have.

## Integration (integrator) — main.js + index.html + ci + README

- New first dot / 'u' key: UNIVERSE mode. Sandbox scenarios remain on a
  secondary toggle (shift+number, or a "sandbox" submenu).
- Main loop in UNIVERSE mode: Navigator.update → on `changed`, repopulate
  active node into Bodies + engine.upload (gpu) / direct (cpu), rebase
  camera; advance Cosmos.clockMyr by dt·myrPerT; render context nodes
  behind the live scene; HUD breadcrumb (Universe › Galaxy 7 › System 3 ›
  Earth) and an "age" readout. Scroll keeps driving Camera3D.dolly; the
  Navigator turns sustained zoom into descend/ascend.
- Floating origin: feed Navigator.toLocal for body upload base; the active
  node populates in local coords already, so the engine is unchanged.
- test/cosmos.browser.test.js (integrator): in real Chromium, enter
  UNIVERSE mode, programmatically fly inward 3 levels and back out,
  asserting zero page errors, the breadcrumb changing, body counts > 0 at
  each level, and a reload restoring the same seed with an aged clock.
- Keep the WebGPU bulletproofing + all existing suites green.

## Ownership & rules

- Agent A: js/cosmos/cosmos.js, test/cosmos.test.js
- Agent B: js/cosmos/navigator.js, test/navigator.test.js
- Integrator: js/cosmos/persist.js, main.js, index.html, scenarios glue
  (export makeGalaxy/system builders for Cosmos to reuse — add a
  `globalThis.Builders = { galaxy, system, planet, universe }` to
  scenarios.js WITHOUT changing existing scenario behavior), the browser
  test, ci.yml, README, docs.

COMMIT INCREMENTALLY after each working unit. No pushing, no PRs, no model
identifiers in commits.
