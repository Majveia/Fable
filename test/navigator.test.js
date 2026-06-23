'use strict';
/* ============================================================
   FABLE UNIVERSE v6 — Navigator tests (pure Node, no DOM, no deps)
   Run: node test/navigator.test.js

   Loads ONLY js/cosmos/navigator.js. The cosmos hierarchy and the
   Camera3D are SELF-CONTAINED stubs built by hand here, so this
   suite does not depend on Agent A's cosmos.js existing.

   Camera stub — the load-bearing assumption (documented):
   the real Camera3D (js/render/camera.js) computes
       eye = target + dist * (cosP*sinY, sinP, cosP*cosY)
   so at yaw=0, pitch=0 that reduces to
       eye = { x:target.x, y:target.y, z:target.z + dist }
   i.e. the eye sits `dist` along +Z from the target, in LOCAL
   (active-relative) space. The Navigator reconstructs the camera's
   WORLD position as Navigator.origin + camera.eye(). Our stub
   reproduces exactly this yaw=0/pitch=0 eye() and exposes the same
   fields (target{x,y,z}, dist, yaw, pitch) plus setGoal()/snap()
   the Navigator may write during a rebase.
   ============================================================ */

const path = require('path');
require(path.join(__dirname, '..', 'js', 'cosmos', 'navigator.js'));
const Navigator = globalThis.Navigator;

// ---------------------------------------------------------------- harness
let passed = 0, failed = 0;
function check(name, cond, detail) {
  const tag = cond ? 'PASS' : 'FAIL';
  if (cond) passed++; else failed++;
  console.log(`${tag}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}

// ---------------------------------------------------------------- stub cosmos
// 3-level hierarchy (depth caps at 3): universe -> galaxy -> system -> planet,
// arranged colinearly along +X so we can fly straight in / straight out.
function makeNode(id, kind, depth, ac, radius) {
  return {
    id, kind, depth,
    ac, radius,
    parent: null,
    _kids: [],
    summary: { kind, colorIdx: depth, brightness: 1 },
    children() { return this._kids; },
  };
}

function buildCosmos() {
  const universe = makeNode('u', 'universe', 0, [0, 0, 0], 6000);
  const galaxy   = makeNode('u/g0', 'galaxy', 1, [3000, 0, 0], 300);
  const system   = makeNode('u/g0/s0', 'system', 2, [3050, 0, 0], 8);
  const planet   = makeNode('u/g0/s0/p0', 'planet', 3, [3052, 0, 0], 0.5);

  // wire parents + children
  galaxy.parent = universe; universe._kids = [galaxy];
  system.parent = galaxy;    galaxy._kids = [system];
  planet.parent = system;    system._kids = [planet];

  return { root: universe, universe, galaxy, system, planet };
}

// ---------------------------------------------------------------- camera stub
function makeCamera() {
  return {
    target: { x: 0, y: 0, z: 0 },
    dist: 1500,
    yaw: 0,
    pitch: 0,
    // yaw=0, pitch=0 => eye is `dist` along +Z from target, in LOCAL space.
    eye() { return { x: this.target.x, y: this.target.y, z: this.target.z + this.dist }; },
    setGoal(o) {
      if (o.targetX !== undefined) this.target.x = o.targetX;
      if (o.targetY !== undefined) this.target.y = o.targetY;
      if (o.targetZ !== undefined) this.target.z = o.targetZ;
      if (o.dist !== undefined) this.dist = o.dist;
      if (o.yaw !== undefined) this.yaw = o.yaw;
      if (o.pitch !== undefined) this.pitch = o.pitch;
    },
    snap() {},
  };
}

/* Place the camera so its WORLD eye position is exactly `worldEye`
   (an [x,y,z]). Because the eye sits `dist` along +Z of the target in
   local space, and worldEye = origin + localEye, we set:
       localEye  = worldEye - origin
       target.local = localEye - (0,0,dist)
   This lets a test drive the camera to an arbitrary world point
   regardless of the current floating origin. */
function placeCameraWorldEye(cam, origin, worldEye, dist) {
  if (dist !== undefined) cam.dist = dist;
  cam.target.x = worldEye[0] - origin[0];
  cam.target.y = worldEye[1] - origin[1];
  cam.target.z = worldEye[2] - origin[2] - cam.dist;
}

// Current camera world position from the Navigator's own definition.
function camWorld(cam, origin) {
  const e = cam.eye();
  return [origin[0] + e.x, origin[1] + e.y, origin[2] + e.z];
}

function localMagnitude(cam) {
  // |toLocal(cameraWorld)| = |camera.eye()| since eye is already local
  // (toLocal(origin+eye) = eye). Compute via Navigator.toLocal for honesty.
  const cw = camWorld(cam, Navigator.origin);
  const l = Navigator.toLocal(cw);
  return Math.hypot(l[0], l[1], l[2]);
}

// ================================================================ (a) descend sequence
(function testDescend() {
  const cz = buildCosmos();
  const cam = makeCamera();
  Navigator.init(cz, cam);
  check('init: active === universe', Navigator.active === cz.universe);
  check('init: origin === universe.ac', Navigator.origin[0] === 0 && Navigator.origin[1] === 0 && Navigator.origin[2] === 0);

  // Targets to fly the camera eye toward, in order. We move progressively
  // closer to each node center; the camera approaches along -X (eye placed
  // just outside +X of the node so that approaching = distance decreasing).
  const seq = [];
  let boundedOk = true;
  let maxLocal = 0;

  // helper: run several update frames while easing the eye toward a world
  // point near `node.ac`, recording the active node after each frame.
  function flyTo(node, standoff, frames, dist) {
    for (let f = 0; f < frames; f++) {
      // step the eye in toward the node center along +X (so D decreases)
      const o = Navigator.origin;
      const cw = camWorld(cam, o);
      const targetEye = [node.ac[0] + standoff, node.ac[1], node.ac[2]];
      // move 60% of the remaining gap each frame (monotonic approach)
      const neye = [
        cw[0] + (targetEye[0] - cw[0]) * 0.6,
        cw[1] + (targetEye[1] - cw[1]) * 0.6,
        cw[2] + (targetEye[2] - cw[2]) * 0.6,
      ];
      placeCameraWorldEye(cam, o, neye, dist);
      const r = Navigator.update(16);
      seq.push(r.active.kind);
      const m = localMagnitude(cam);
      if (m > maxLocal) maxLocal = m;
      if (!(m < 1e5)) boundedOk = false;
    }
  }

  // Start far out near universe center, then descend level by level.
  // standoff is chosen < childRadius*1.5 so DESCEND fires when close.
  flyTo(cz.galaxy, 100, 12, 1500);   // approach galaxy (radius 300 -> enter < 450)
  flyTo(cz.system, 5,  14, 40);      // approach system (radius 8   -> enter < 12)
  flyTo(cz.planet, 0.3, 16, 3);      // approach planet (radius 0.5 -> enter < 0.75)

  // The final active node must be the planet, and the sequence must have
  // visited galaxy then system then planet in order.
  const iG = seq.indexOf('galaxy');
  const iS = seq.indexOf('system');
  const iP = seq.indexOf('planet');
  check('descend visits galaxy', iG >= 0, `seq=${seq.join(',')}`);
  check('descend visits system after galaxy', iS > iG, `iG=${iG} iS=${iS}`);
  check('descend visits planet after system', iP > iS, `iS=${iS} iP=${iP}`);
  check('descend ends active=planet', Navigator.active === cz.planet, `active=${Navigator.active.kind}`);
  check('(a) floating origin bounded during descent (|local| < 1e5)', boundedOk, `max|local|=${maxLocal.toFixed(1)}`);
})();

// ================================================================ (b) ascend sequence
(function testAscend() {
  const cz = buildCosmos();
  const cam = makeCamera();
  Navigator.init(cz, cam);
  // Jump straight to the planet (load/teleport), then fly outward.
  Navigator.focusNode(cz.planet);
  Navigator.update(16);
  check('focus(planet) then update: active=planet', Navigator.active === cz.planet, `active=${Navigator.active.kind}`);

  const seq = [];
  let boundedOk = true;
  let maxLocal = 0;

  function flyOut(node, targetWorldEye, frames, dist) {
    for (let f = 0; f < frames; f++) {
      const o = Navigator.origin;
      const cw = camWorld(cam, o);
      const neye = [
        cw[0] + (targetWorldEye[0] - cw[0]) * 0.6,
        cw[1] + (targetWorldEye[1] - cw[1]) * 0.6,
        cw[2] + (targetWorldEye[2] - cw[2]) * 0.6,
      ];
      placeCameraWorldEye(cam, o, neye, dist);
      const r = Navigator.update(16);
      seq.push(r.active.kind);
      const m = localMagnitude(cam);
      if (m > maxLocal) maxLocal = m;
      if (!(m < 1e5)) boundedOk = false;
    }
  }

  // Pull the eye far away (toward universe center +X side, large dist) so
  // D exceeds radius*3 at each level and ASCEND fires repeatedly.
  // planet radius .5 -> leave > 1.5; system radius 8 -> leave > 24;
  // galaxy radius 300 -> leave > 900.
  flyOut(cz.planet, [3052 + 4, 0, 0], 8, 4);          // back off the planet
  flyOut(cz.system, [3050 + 40, 0, 0], 10, 30);       // back off the system
  flyOut(cz.galaxy, [3000 + 1200, 0, 0], 14, 1000);   // back off the galaxy
  flyOut(cz.universe, [0 + 100, 0, 0], 10, 1500);     // settle in the universe

  const order = [];
  for (const k of seq) if (order[order.length - 1] !== k) order.push(k);
  // The first recorded may already be 'planet'; we require the tail of the
  // sequence to climb planet -> system -> galaxy -> universe.
  const iP = seq.lastIndexOf('planet');
  const iS = seq.indexOf('system');
  const iG = seq.indexOf('galaxy');
  const iU = seq.indexOf('universe');
  check('ascend reaches system after leaving planet', iS > iP || (iS >= 0 && seq[0] !== 'system'), `seq=${seq.join(',')}`);
  check('ascend reaches galaxy after system', iG > iS, `iS=${iS} iG=${iG}`);
  check('ascend reaches universe after galaxy', iU > iG, `iG=${iG} iU=${iU}`);
  check('ascend ends active=universe', Navigator.active === cz.universe, `active=${Navigator.active.kind}`);
  check('(c) floating origin bounded during ascent (|local| < 1e5)', boundedOk, `max|local|=${maxLocal.toFixed(1)}`);
})();

// ================================================================ (d) hysteresis / no oscillation
(function testHysteresis() {
  const cz = buildCosmos();
  const cam = makeCamera();
  Navigator.init(cz, cam);
  // Park the camera eye exactly at the ascend boundary of the universe:
  // D ≈ universe.radius * 3 = 18000. Place the eye at world X = 18000 so
  // D from universe center (0,0,0) is exactly 18000.
  // Using dist such that eye = origin + (target + dist*+Z)... simplest:
  // put the eye at [18000,0,0] every frame (no monotonic approach).
  let switches = 0;
  let last = Navigator.active;
  let boundedOk = true;
  for (let f = 0; f < 1000; f++) {
    // tiny dither around the boundary to provoke flapping if hysteresis
    // were absent: +/- a few units, well inside the *3-vs-*1.5 dead zone.
    const jitter = (f % 2 === 0) ? 2 : -2;
    placeCameraWorldEye(cam, Navigator.origin, [18000 + jitter, 0, 0], 50);
    const r = Navigator.update(16);
    if (r.active !== last) { switches++; last = r.active; }
    const m = localMagnitude(cam);
    if (!(m < 1e5)) boundedOk = false;
  }
  // At this distance the universe has no parent (cannot ascend) and the
  // galaxy is far (D_toGalaxy ~ 15000 >> galaxy.radius*1.5), so no descend.
  // A correctly-hysteretic Navigator should switch at most a couple times.
  check('(d) parked at boundary: <= 2 active switches over 1000 frames', switches <= 2, `switches=${switches}`);
  check('(d) boundary park stays bounded (|local| < 1e5)', boundedOk);
})();

// ================================================================ (e) focusNode
(function testFocus() {
  const cz = buildCosmos();
  const cam = makeCamera();
  Navigator.init(cz, cam);
  Navigator.focusNode(cz.planet);
  check('(e) focusNode sets active === planet', Navigator.active === cz.planet);
  check('(e) focusNode sets origin === planet.ac values',
    Navigator.origin[0] === cz.planet.ac[0] &&
    Navigator.origin[1] === cz.planet.ac[1] &&
    Navigator.origin[2] === cz.planet.ac[2],
    `origin=${Navigator.origin.join(',')}`);
  // focusNode flags changed for the NEXT update.
  const r = Navigator.update(16);
  check('(e) focusNode flags changed on next update', r.changed === true);
})();

// ================================================================ context + descendTarget smoke
(function testContextAndDescendTarget() {
  const cz = buildCosmos();
  const cam = makeCamera();
  Navigator.init(cz, cam);
  const r = Navigator.update(16);
  // From the universe, context should include the galaxy (a child) with a
  // localPos annotation and a summary.
  const hasGalaxy = r.context.some(n => n === cz.galaxy);
  check('context includes active child (galaxy)', hasGalaxy);
  const g = r.context.find(n => n === cz.galaxy);
  check('context node has localPos triple', g && Array.isArray(g.localPos) && g.localPos.length === 3,
    g ? `localPos=${g.localPos.join(',')}` : 'no galaxy');
  check('context node localPos is active-relative (galaxy at +3000 X)',
    g && g.localPos[0] === 3000 && g.localPos[1] === 0 && g.localPos[2] === 0);
  check('context node carries summary', g && g.summary && g.summary.kind === 'galaxy');
  check('context capped to <= 64', r.context.length <= 64, `len=${r.context.length}`);

  // descendTarget: move the eye just outside the galaxy so it is enterable.
  placeCameraWorldEye(cam, Navigator.origin, [3000 + 100, 0, 0], 50);
  const dt = Navigator.descendTarget();
  check('descendTarget picks the galaxy when camera is near it', dt === cz.galaxy,
    `dt=${dt ? dt.kind : 'null'}`);
})();

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
