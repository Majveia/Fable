# FABLE: DRIFTER v8 — THE WANDERER

Two headline asks, built on the playable v7 DRIFTER:
1. **Be a person, not just a ship.** Switch between PILOTING and WALKING
   your ship, each in FIRST- and THIRD-person. Four camera contexts:
   fly-FP (cockpit), fly-TP (chase), walk-FP (eyes), walk-TP (over-shoulder).
2. **A luminous, colorful cosmos.** Vivid emission nebulae, richer bloom,
   a lush palette — *Cosmos* (Sagan/Tyson awe) × *Planet Earth* (Attenborough
   grandeur). Brighten and colorize without blowing out.

## Foundation (v7, do not rewrite)
- `js/game/ship.js` (Ship): flight model; `Ship.state{pos,vel,yaw,pitch,roll,
  throttle,speed}`, `Ship.facing()`, `Ship.cameraGoal('chase'|'cockpit'|'orbit')`.
  Forward at yaw0/pitch0 is **+Z**; up is **+Y**.
- `js/game/drifter.js`, `js/game/hud.js`, `js/game/score.js`, `js/game/poi.js`,
  `js/game/lore.js`, `js/cosmos/*`, `js/render/renderer.js`, `js/main.js`.
- Everything renders in the ACTIVE node's LOCAL frame; the camera (Camera3D)
  orbits a `target` with `dist/yaw/pitch`; eye() in that local frame.

## Coordinate conventions (the load-bearing contract)
- **Ship space**: origin at ship centre, **+Z forward, +Y up, +X right**
  (matches Ship.facing at yaw0). The ship model & avatar live here.
- The ship's pose places ship space into node-local space: forward F =
  Ship.facing(); up U ≈ +Y re-orthonormalized; right R = U×F (roll applied
  about F). Integrator owns the ship→local transform `M` and its use; agents
  only work in ship space and return ship-space data.

## New modules

### js/game/shipmodel.js → globalThis.ShipModel  (DOM-free, Node-test)
A procedural WIREFRAME ship + interior in SHIP SPACE (glowing-line aesthetic
that fits the point-sprite universe).
```
ShipModel.build(seed?)                 // caches; idempotent
ShipModel.scale                        // world length of the ship (~16 units)
ShipModel.lines  -> Float32Array       // [x0,y0,z0, x1,y1,z1, ...] segment ends
ShipModel.lineColor -> [r,g,b]         // hull glow (cyan-ish), 0..1
ShipModel.nodes  -> [{pos:[x,y,z], colorIdx, label}]  // seat/console/engine/hold
ShipModel.seat   -> { pos:[x,y,z], forward:[0,0,1], eye:[x,y,z] }  // cockpit mount
ShipModel.bounds -> [{min:[x,y,z], max:[x,y,z]}]      // walkable volume(s)
ShipModel.clamp(pos) -> [x,y,z]        // nearest point inside the walkable bounds
```
Recognisable hull (nose at +Z, swept body, engine at -Z) + an interior the
avatar can stand in (cockpit forward, corridor, hold). Geometry deterministic.
Test: lines non-empty & finite; bounds non-empty; clamp keeps points inside;
seat & nodes within bounds; determinism.

### js/game/avatar.js → globalThis.Avatar  (DOM-free, Node-test)
On-foot controller in SHIP SPACE.
```
Avatar.reset({ seat })                 // stand at the seat
Avatar.state = { pos:[x,y,z], yaw, pitch, moving:bool }
Avatar.update(dtSec, input, model)     // input {fwd:-1..1, strafe:-1..1,
                                       //   turn:-1..1, lookPitch:-1..1, run:bool}
  // walk in the ship-space horizontal (X/Z) plane by yaw; clamp via
  // model.clamp; pitch clamps to ~±1.4; gentle accel/damp.
Avatar.cameraMount(mode) -> { pos:[x,y,z], forward:[x,y,z], up:[x,y,z] }  // ship space
  // mode 'fp' = eye height, looking along yaw/pitch; 'tp' = behind & above.
```
Test: fwd moves pos along yaw (clamped in bounds); strafe sideways; pitch
clamps; fp/tp mounts finite & distinct; 1000 random steps stay in bounds.

### Renderer enrichment (Agent: renderer)  js/render/renderer.js (+ postfx.js)
1. **Luminous nebulae**: gas sprites get a WIDER VIVID palette (H-alpha red,
   OIII teal/green, gold, violet, magenta, royal blue), larger softer
   volumetric falloff, additive layering so overlapping gas reads as glowing
   clouds. Lift overall exposure/bloom a notch for a *Cosmos* glow — colorful
   and bright but NOT blown-out white. Keep stars readable.
2. **Overlay pass** for the ship: `Renderer3D.render(opts)` honors
   `opts.overlay = { lines:Float32Array(node-local seg ends), lineColor:[r,g,b],
   points:[{x,y,z,colorIdx,size}] }` — drawn AFTER the universe + post as
   additive glowing GL_LINES + point sprites (so the ship wireframe and
   interior nodes appear in front, in the same local frame as the bodies).
   No overlay → unchanged. Both engine source modes (texture/arrays) keep
   working; all existing tests + the gpu/cosmos/drifter browser gates green.
   Browser-verify with screenshots (colorful nebula + a sample wireframe).

### Lush content (Agent: cosmos-color)  scenarios.js / cosmos.js / lore.js
- Expand the nebula/gas PALETTE to vivid emission hues and use them: galaxies,
  the nursery, and the universe web get more gas in richer colors (brighten,
  don't clutter). A couple of new colorful nebula flavors are welcome.
- Lore gains a GRAND-NARRATION voice: `Lore.narrate(kind|key) -> string` — a
  short awe-struck *Cosmos*/*Planet Earth* line ("A cathedral of newborn
  light, ten thousand suns drawing their first breath."). Non-empty, varied,
  characterful; deterministic when given a key.
- Node-test: palette/gas determinism + bounded; narrate non-empty/varied; all
  existing scenario/cosmos tests stay green (counts may rise — keep smoke
  perf budgets met; if needed, raise gas modestly, not massively).

## Integration (INTEGRATOR — me)  main.js + hud.js + index.html
- Camera-context state machine: `mode ∈ {fly,walk}`, `view ∈ {fp,tp}`.
  Keys: **X** enter/exit ship (fly↔walk; on exit-to-walk the ship holds
  position, throttle 0); **V** toggle FP/TP. (Keep C as a 4-way cycle too.)
- fly: Ship piloting as v7; camera = Ship.cameraGoal(view==='fp'?'cockpit':'chase').
- walk: Avatar.update with WASD+drag; build ship→local transform M from Ship
  pose; set Camera3D from Avatar.cameraMount(view) transformed by M.
- ALWAYS render the ship wireframe overlay: transform ShipModel.lines/nodes
  ship→local by M each frame, pass as opts.overlay (so you SEE your ship in
  chase/walk views). Scale the model to the active node so it's visible.
- HUD shows mode/view (FLY · CHASE etc.); discovery toasts may use Lore.narrate.
- Persist nothing new required. Keep WebGPU bulletproofing + all gates green.
- Browser test `test/wanderer.browser.test.js`: boot, fly FP & TP, press X to
  walk, move the avatar (pos changes, stays in bounds), toggle V (camera
  changes), exit back to fly — zero page errors; assert overlay present.

## Ownership (parallel workflow agents — worktrees, commit incrementally)
- Agent A (renderer): js/render/renderer.js, js/render/postfx.js, a dev
  screenshot harness. Luminous nebulae + the overlay pass.
- Agent B (shipmodel): js/game/shipmodel.js + test/shipmodel.test.js
- Agent C (avatar): js/game/avatar.js + test/avatar.test.js
- Agent D (cosmos-color): scenarios.js + cosmos.js + lore.js palette/gas/
  narrate + test updates; keep all existing tests green.
Integrator owns main.js, hud.js, index.html, the browser test, ci, README.
No model identifiers in commits. Node-test everything testable in Node.
