# FABLE: DRIFTER — v7, the playable universe

No Man's Sky × Starfield × Cowboy Bebop × Rick and Morty. You pilot a ship
through ONE continuous, persistent universe (the v6 cosmos), discover and
scan points of interest, hunt bounties, and build a codex — seamless from
the cosmic web to a planet's moons. The 8 old sandboxes are MERGED IN as
named landmarks you can actually fly to.

## Foundation (already built — v6, do not rewrite)
- `js/cosmos/cosmos.js` (Cosmos): seed → lazy hierarchy
  (universe→galaxy→system→planet), `node.populate(budget,Bodies)`,
  `node.children()`, `node.ac/radius/viewRadius/phase`, `Cosmos.ageTo`.
- `js/cosmos/navigator.js` (Navigator): floating origin + LOD active node.
- `js/cosmos/persist.js` (Persist): IndexedDB seed+clock, aging-on-load.
- Engines (Physics/PhysicsGPU/PhysicsWGPU), renderers, `globalThis.Builders`
  (galaxy/system/planet generators), `globalThis.Scenarios` (the 8 sandboxes).

## Aesthetic contract (ALL visual/audio modules honor this)
Neon-noir over deep space. Palette: ink `#05060a`; cyan `#37e6ff`; magenta
`#ff4fd8`; amber `#ffb347`; bone `#e8ecf8`; dim `#5a6ب88`→ use `#5a6688`.
Type: mono everywhere; a wide-tracked display look for headers
(letter-spacing). Cockpit frame with faint scanlines + vignette + subtle
chromatic edge. Copy voice: terse jazz-noir narration spiked with absurd
cosmic-bureaucratic and dimensional-science humor. Keep it CLEAN and
immersive — never cluttered; UI fades when idle (reuse body.idle).

## New modules

### js/game/lore.js → globalThis.Lore  (DOM-free, Node-test)
Deterministic procedural text from a key string (mulberry32-hashed, copy
the RNG pattern). Blends four registers: cosmic-scientific (NMS),
corporate-registry (Starfield), jazz-noir-bounty (Bebop), absurd-
dimensional (R&M).
```
Lore.systemName(key) -> "Kepler-Veil 9" / "Sector Bebop-7" / "New Cygnus"
Lore.poiName(key, kind) -> string
Lore.poiBlurb(key, kind) -> 1-2 sentence noir/absurd description
Lore.bounty(key) -> { name, alias, crime, reward, danger:1..5, flavor }
Lore.discovery(kind) -> short toast line ("ANOMALY LOGGED · …")
Lore.shipName(key) -> a Bebop-ish ship name
```
Word banks are data tables; output must read coherent, never word-salad.
Test: determinism (same key → same string), non-empty, variety across keys,
no undefined/NaN in templates.

### js/game/poi.js → globalThis.POI  (DOM-free, Node-test)
Deterministic points of interest for a cosmos node.
```
POI.forNode(node) -> POI[]   // cached on the node (node._pois)
  POI = { id, kind:'station'|'derelict'|'anomaly'|'portal'|'beacon',
          localPos:[x,y,z], radius, name, blurb, scanned:false }
POI.scan(poi) -> { kind, name, blurb, first:bool }   // marks scanned
```
Counts/kinds weighted by node.kind (systems richest; portals/anomalies rare
— the R&M weirdness). localPos within node.viewRadius. Names/blurbs via Lore
(POI may call globalThis.Lore when present; degrade to plain ids if absent).
Test: determinism, positions finite & bounded by viewRadius, kind weights
sane, scan idempotent (first=true once).

### js/game/ship.js → globalThis.Ship  (DOM-free core, Node-test)
Arcade-Newtonian flight in the active node's LOCAL frame.
```
Ship.reset({pos,viewRadius})
Ship.state = { pos:[x,y,z], vel:[x,y,z], yaw, pitch, roll, throttle, speed }
Ship.update(dtSec, input)   // input {thrust:-1..1, pitch, yaw, roll, boost:bool}
  // thrust accelerates along facing; rotation from pitch/yaw/roll rates;
  // inertial damper bleeds lateral velocity toward facing; boost ×N.
Ship.facing() -> [x,y,z]    // unit forward
Ship.cameraGoal(mode) -> { targetX,targetY,targetZ, dist, yaw, pitch }
  // mode 'chase' (behind ship) | 'cockpit' (near ship, look forward) |
  //      'orbit' (free, returns null so caller keeps manual orbit)
```
Test: forward thrust increases speed along facing; zero input + damper
reduces |vel|; yaw/pitch rotate facing; speed = |vel|; finite always.

### js/cosmos/landmarks.js → globalThis.Landmarks  (DOM-free, Node-test)
MERGE THE SANDBOXES. Inject named landmark nodes into the cosmos whose
`populate` calls the matching scenario builder (via Builders / Scenarios),
so flying to them loads that set-piece in-world.
```
Landmarks.inject(Cosmos)   // makes landmarks discoverable in the hierarchy
Landmarks.list() -> [{ id, name, kind, ac:[x,y,z], scenario }]
```
Map: Sol→solar, Antennae→collision, Orion Nursery→nebula,
The Maw→binary, Omega→cluster, Cosmic Dawn→bigbang, plus a couple original
named systems. Each landmark node has a stable id ("u/lm/sol"), an ac placed
in the universe, kind matching the scenario scale, and a populate() that
runs the scenario's generator centered at local origin. Determinism + the
node.populate filling Bodies are the test targets. Navigator must treat
landmark nodes like any node (same {ac,radius,viewRadius,children,populate}).

### js/game/hud.js → globalThis.HUD  (DOM, browser-verify)
The cockpit overlay (its own DOM in an #hud container). Honors the aesthetic.
```
HUD.init(root)
HUD.update(s)  // s = { speed, throttle, boost, heading:[yaw,pitch],
               //       breadcrumb, coords:[x,y,z], target, scanProgress,
               //       bounty, fps, mode }
HUD.toast(line) / HUD.discovery(payload) / HUD.setTarget(t|null)
HUD.codex(open?) / HUD.logBounty(b) / HUD.show(bool)
```
Elements: throttle+speed gauge, heading/coords, center reticle + off-screen
nav arrow to target, scanner sweep ring with progress, top discovery toasts,
a bounty tracker chip, a codex panel (list of discoveries), idle-fade.

### js/game/score.js → globalThis.Score  (audio, browser; may extend sound.js)
A loopable jazz-noir ambient bed (WebAudio synthesis — walking-bass-ish
pattern, brush-ish noise, warm pad) plus context stingers: scan ping,
discovery chime, bounty-accept motif, danger drone near black holes. Starts
on first gesture; `m` mutes (coordinate with existing Sound).

## Integration (INTEGRATOR — not an agent)
`js/game/drifter.js` + main.js wiring a DRIFTER mode (the default; sandbox
direct-load stays on shift+number or a menu):
- Pilot the Ship; feed Ship.cameraGoal → Camera3D each frame; WASD/arrows +
  pointer for thrust/rotation; throttle; boost; camera mode cycle (`c`).
- Navigator drives LOD off the ship's position; on node change repopulate +
  rebuild POIs (POI.forNode) and render POI markers as HUD nav/reticle data.
- Scanning (`f` or hold): fills scanProgress; on complete, POI.scan →
  HUD.discovery + Lore + Score chime + codex + persist.
- Bounties: a board (`j`) lists Lore.bounty targets pinned to landmark/random
  systems; accept → HUD target; reaching+scanning the target completes it.
- Landmarks.inject at boot; nav menu (`n`) can set course to any Landmark.
- Persist v2: extend the saved record with { discoveries[], bounties[],
  shipPos, activeId } (back-comp: old records still load).
- Keep WebGPU bulletproofing, fallbacks, and ALL existing tests green.
- Browser test `test/drifter.browser.test.js`: boot DRIFTER, fly with the
  ship, descend a level, scan a POI (discovery logged), accept+track a
  bounty, open codex — zero page errors; reload restores discoveries.

## Ownership (parallel agents — worktrees, commit incrementally)
- Agent A: js/game/lore.js + test/lore.test.js
- Agent B: js/game/poi.js + test/poi.test.js
- Agent C: js/game/ship.js + test/ship.test.js
- Agent D: js/cosmos/landmarks.js + test/landmarks.test.js
Integrator owns: hud.js, score.js, drifter.js, main.js, index.html, the
browser test, ci.yml, README, and final integration/verification.
No model identifiers in commits. Node-test everything testable in Node.
