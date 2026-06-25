'use strict';
/* ============================================================
   FABLE: DRIFTER — Ship flight-model tests (pure Node, no DOM).
   Run: node test/ship.test.js   (exit 1 on any failure)

   Loads js/render/camera.js + js/game/ship.js via indirect-eval-to-
   global (matching test/smoke.js) so globalThis.Camera3D / Ship exist.
   We test the flight model AND that cameraGoal() matches camera.js's
   yaw/pitch/dist/target -> eye convention EXACTLY (the ship must end up
   ahead of the camera, with the view direction along the ship's facing).
   ============================================================ */

const fs = require('fs');
const path = require('path');

for (const f of ['js/render/camera.js', 'js/game/ship.js']) {
  (0, eval)(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
}

const { Ship, Camera3D } = globalThis;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
  if (cond) passed++; else failed++;
}

// Deterministic RNG (mulberry32) so failures reproduce.
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mag = (v) => Math.hypot(v[0], v[1], v[2]);
const finite3 = (v) => isFinite(v[0]) && isFinite(v[1]) && isFinite(v[2]);

// ---------------------------------------------------------- (1) thrust along facing
{
  Ship.reset({ pos: [0, 0, 0], viewRadius: 1500 });
  const F0 = Ship.facing();
  // pure forward thrust, no rotation
  let prevSpeed = 0, monotonic = true, alignedOk = true;
  for (let i = 0; i < 30; i++) {
    Ship.update(0.05, { thrust: 1, pitch: 0, yaw: 0, roll: 0, boost: false });
    if (Ship.state.speed < prevSpeed - 1e-9) monotonic = false;
    prevSpeed = Ship.state.speed;
  }
  // velocity must point along the (unchanged) facing
  const v = Ship.state.vel, F = Ship.facing();
  const cos = dot(v, F) / (mag(v) || 1);
  check('thrust=1 increases speed', Ship.state.speed > 0 && monotonic,
    'speed=' + Ship.state.speed.toFixed(1));
  check('thrust=1 velocity aligned with facing', cos > 0.999,
    'cos=' + cos.toFixed(5));
  check('facing unit length', Math.abs(mag(F0) - 1) < 1e-9, '|F|=' + mag(F0).toFixed(6));
}

// ---------------------------------------------------------- (2) damper bleeds |vel|
{
  Ship.reset({ pos: [0, 0, 0], viewRadius: 1500 });
  // build up some speed
  for (let i = 0; i < 20; i++) Ship.update(0.05, { thrust: 1 });
  const before = Ship.state.speed;
  // now coast: zero input -> damper should reduce |vel| over steps
  let prev = before, decreasing = true;
  for (let i = 0; i < 60; i++) {
    Ship.update(0.05, { thrust: 0, pitch: 0, yaw: 0, roll: 0, boost: false });
    if (Ship.state.speed > prev + 1e-9) decreasing = false;
    prev = Ship.state.speed;
  }
  check('zero input + damper reduces |vel|', Ship.state.speed < before && decreasing,
    before.toFixed(1) + ' -> ' + Ship.state.speed.toFixed(1));
}

// ---------------------------------------------------------- (2b) lateral drift bled toward facing
{
  Ship.reset({ pos: [0, 0, 0], viewRadius: 1500 });
  // gain forward velocity along +Z, then yaw 90deg so old velocity is now lateral.
  for (let i = 0; i < 20; i++) Ship.update(0.05, { thrust: 1 });
  // rotate the nose ~90 degrees (yaw) over time; coast (no thrust)
  for (let i = 0; i < 40; i++) Ship.update(0.05, { thrust: 0, yaw: 1 });
  // continue coasting so the (now lateral) momentum bleeds off
  const v0 = Ship.state.vel.slice();
  const F = Ship.facing();
  const lat0 = mag([
    v0[0] - F[0] * dot(v0, F),
    v0[1] - F[1] * dot(v0, F),
    v0[2] - F[2] * dot(v0, F),
  ]);
  for (let i = 0; i < 40; i++) Ship.update(0.05, { thrust: 0, yaw: 0 });
  const v1 = Ship.state.vel, F1 = Ship.facing();
  const lat1 = mag([
    v1[0] - F1[0] * dot(v1, F1),
    v1[1] - F1[1] * dot(v1, F1),
    v1[2] - F1[2] * dot(v1, F1),
  ]);
  check('inertial damper bleeds lateral velocity toward zero', lat1 < lat0 * 0.5 + 1e-6,
    'lateral ' + lat0.toFixed(2) + ' -> ' + lat1.toFixed(2));
}

// ---------------------------------------------------------- (3) yaw rotates facing
{
  Ship.reset({ pos: [0, 0, 0], viewRadius: 1500 });
  const F0 = Ship.facing();              // +Z
  for (let i = 0; i < 20; i++) Ship.update(0.05, { yaw: 1 });   // ~1s of yaw
  const F1 = Ship.facing();
  // yaw rotates in the XZ plane; Y stays ~0, heading swings toward +X.
  const turned = dot(F0, F1) < 0.99;     // facing actually changed
  const inPlane = Math.abs(F1[1]) < 1e-6; // pure yaw keeps pitch (Y) at 0
  const swungX = F1[0] > 0.05;            // +yaw turns toward +X (sin(yaw)>0)
  check('yaw rotates facing as expected', turned && inPlane && swungX,
    'F1=[' + F1.map(x => x.toFixed(3)).join(',') + ']');
}

// ---------------------------------------------------------- (4) pitch changes elevation
{
  Ship.reset({ pos: [0, 0, 0], viewRadius: 1500 });
  const F0 = Ship.facing();              // Y component 0
  for (let i = 0; i < 15; i++) Ship.update(0.05, { pitch: 1 });
  const F1 = Ship.facing();
  check('pitch changes facing elevation', F1[1] > F0[1] + 0.05 && Math.abs(mag(F1) - 1) < 1e-9,
    'Fy ' + F0[1].toFixed(3) + ' -> ' + F1[1].toFixed(3));
  // clamp: hammer pitch and confirm |Fy| < 1 (never gimbal-flips to straight up)
  for (let i = 0; i < 200; i++) Ship.update(0.05, { pitch: 1 });
  const Fc = Ship.facing();
  check('pitch clamped short of vertical (no gimbal flip)', Fc[1] < 0.999 && finite3(Fc),
    'Fy=' + Fc[1].toFixed(4));
}

// ---------------------------------------------------------- (4b) NON-INVERTED look axis
{
  // The input-mapping contract (js/main.js): drag DOWN negates dy, feeding a
  // NEGATIVE pitch input, while the ship treats +pitch as nose UP. So we assert
  // the sign convention this depends on: pitch input +1 raises the nose (look
  // up, facing Y increases), pitch input -1 lowers it (look down). If this flips
  // the mouse look would be inverted.
  Ship.reset({ pos: [0, 0, 0], viewRadius: 1500 });
  for (let i = 0; i < 10; i++) Ship.update(0.05, { pitch: 1 });
  const up = Ship.facing()[1];
  Ship.reset({ pos: [0, 0, 0], viewRadius: 1500 });
  for (let i = 0; i < 10; i++) Ship.update(0.05, { pitch: -1 });
  const down = Ship.facing()[1];
  check('non-inverted: +pitch input looks UP, -pitch looks DOWN',
    up > 0.05 && down < -0.05, 'up Fy=' + up.toFixed(3) + ' down Fy=' + down.toFixed(3));
}

// ---------------------------------------------------------- (5) speed == |vel|
{
  Ship.reset({ pos: [0, 0, 0], viewRadius: 1500 });
  const rng = makeRng(99);
  let ok = true;
  for (let i = 0; i < 50; i++) {
    Ship.update(0.04, { thrust: rng() * 2 - 1, yaw: rng() * 2 - 1, pitch: rng() * 2 - 1, roll: rng() * 2 - 1, boost: rng() > 0.5 });
    if (Math.abs(Ship.state.speed - mag(Ship.state.vel)) > 1e-6) ok = false;
  }
  check('speed equals hypot(vel)', ok, 'last speed=' + Ship.state.speed.toFixed(2));
}

// ---------------------------------------------------------- (6) finite after 1000 random steps
{
  Ship.reset({ pos: [10, -5, 3], viewRadius: 4000 });
  const rng = makeRng(2024);
  let finite = true;
  for (let i = 0; i < 1000; i++) {
    Ship.update(rng() * 0.05, {
      thrust: rng() * 2 - 1, yaw: rng() * 2 - 1,
      pitch: rng() * 2 - 1, roll: rng() * 2 - 1, boost: rng() > 0.7,
    });
    const s = Ship.state;
    if (!finite3(s.pos) || !finite3(s.vel) || !isFinite(s.speed) ||
        !isFinite(s.yaw) || !isFinite(s.pitch) || !isFinite(s.roll)) { finite = false; break; }
  }
  check('finite after 1000 random-input steps', finite,
    'speed=' + Ship.state.speed.toFixed(1) + ' pos=[' + Ship.state.pos.map(x => x.toFixed(0)).join(',') + ']');
}

// ---------------------------------------------------------- (7) cameraGoal finite + orbit null
{
  Ship.reset({ pos: [100, 20, -30], viewRadius: 1500 });
  // point the ship somewhere non-trivial
  for (let i = 0; i < 7; i++) Ship.update(0.05, { yaw: 1, pitch: 1 });

  const chase = Ship.cameraGoal('chase');
  const cockpit = Ship.cameraGoal('cockpit');
  const orbit = Ship.cameraGoal('orbit');

  const goalFinite = (g) => g && ['targetX', 'targetY', 'targetZ', 'dist', 'yaw', 'pitch']
    .every(k => isFinite(g[k]));
  check('cameraGoal chase finite', goalFinite(chase),
    'dist=' + (chase && chase.dist.toFixed(1)));
  check('cameraGoal cockpit finite', goalFinite(cockpit),
    'dist=' + (cockpit && cockpit.dist.toFixed(1)));
  check('cameraGoal orbit returns null', orbit === null);
  check('cockpit boom tighter than chase', cockpit.dist < chase.dist,
    cockpit.dist.toFixed(1) + ' < ' + chase.dist.toFixed(1));
}

// ---------------------------------------------------------- (8) camera convention: ship sits AHEAD of eye
{
  // Drive cameraGoal through the REAL Camera3D, snap, and confirm the
  // camera's eye() -> target view direction equals the ship's facing,
  // and the ship's position is in front of the eye (and behind target).
  const rng = makeRng(7);
  let alignWorst = 1, aheadOk = true, behindEye = true;
  for (let trial = 0; trial < 8; trial++) {
    Ship.reset({ pos: [rng() * 200 - 100, rng() * 200 - 100, rng() * 200 - 100], viewRadius: 1500 });
    for (let i = 0; i < 10; i++) Ship.update(0.05, { yaw: rng() * 2 - 1, pitch: rng() * 2 - 1 });

    const g = Ship.cameraGoal('chase');
    Camera3D.setGoal(g);
    Camera3D.snap();
    const eye = Camera3D.eye();
    const t = Camera3D.target;

    // view direction = normalize(target - eye)
    const view = [t.x - eye.x, t.y - eye.y, t.z - eye.z];
    const vm = mag(view) || 1;
    view[0] /= vm; view[1] /= vm; view[2] /= vm;
    const F = Ship.facing();
    const cos = dot(view, F);
    alignWorst = Math.min(alignWorst, cos);

    // ship must be in front of the eye along the view (forward) direction
    const p = Ship.state.pos;
    const toShip = [p[0] - eye.x, p[1] - eye.y, p[2] - eye.z];
    if (dot(toShip, F) <= 0) aheadOk = false;
    // and the eye must be roughly behind the ship (not in front of the nose)
    if (dot([eye.x - p[0], eye.y - p[1], eye.z - p[2]], F) >= 0) behindEye = false;
  }
  check('chase view direction == ship facing (camera convention matched)', alignWorst > 0.9999,
    'worst cos=' + alignWorst.toFixed(6));
  check('ship sits ahead of the camera eye', aheadOk);
  check('camera eye sits behind the ship nose', behindEye);
}

// ---------------------------------------------------------- (9) boost makes you faster
{
  Ship.reset({ pos: [0, 0, 0], viewRadius: 1500 });
  for (let i = 0; i < 80; i++) Ship.update(0.05, { thrust: 1, boost: false });
  const cruise = Ship.state.speed;
  Ship.reset({ pos: [0, 0, 0], viewRadius: 1500 });
  for (let i = 0; i < 80; i++) Ship.update(0.05, { thrust: 1, boost: true });
  const boosted = Ship.state.speed;
  check('boost raises top speed', boosted > cruise * 1.5,
    'cruise=' + cruise.toFixed(0) + ' boost=' + boosted.toFixed(0));
}

// ========================================================== SURFACE MODE
// ---------------------------------------------------------- (S1) gravity makes you fall
{
  const flat = () => 0;
  Ship.surfaceReset({ spawn: { pos: [0, 500, 0], yaw: 0 }, gravity: 12, extent: 1200 });
  const y0 = Ship.state.pos[1];
  // zero thrust: gravity pulls you down (and you stay well above the ground)
  for (let i = 0; i < 20; i++) Ship.surfaceUpdate(0.05, { thrust: 0 }, flat);
  check('surface: zero thrust falls under gravity', Ship.state.pos[1] < y0,
    'y ' + y0.toFixed(1) + ' -> ' + Ship.state.pos[1].toFixed(1));
}

// ---------------------------------------------------------- (S2) never sinks below heightAt+clearance
{
  // bumpy terrain so collision must track height across X/Z
  const heightAt = (x, z) => 40 * Math.sin(x * 0.01) + 30 * Math.cos(z * 0.013) + 60;
  Ship.surfaceReset({ spawn: { pos: [0, 300, 0], yaw: 0 }, gravity: 14, extent: 1000, clearance: 6 });
  const rng = makeRng(123);
  let belowGround = false, minClear = Infinity;
  for (let i = 0; i < 2000; i++) {
    Ship.surfaceUpdate(0.05, {
      thrust: rng() * 2 - 1, pitch: rng() * 2 - 1,
      yaw: rng() * 2 - 1, roll: rng() * 2 - 1, boost: rng() > 0.8,
    }, heightAt);
    const p = Ship.state.pos;
    const floor = heightAt(p[0], p[2]) + 6;
    if (p[1] < floor - 1e-6) belowGround = true;
    minClear = Math.min(minClear, p[1] - heightAt(p[0], p[2]));
  }
  check('surface: never sinks below heightAt+clearance', !belowGround,
    'min(y-h)=' + minClear.toFixed(3));
}

// ---------------------------------------------------------- (S3) upward thrust gains altitude
{
  const flat = () => 0;
  Ship.surfaceReset({ spawn: { pos: [0, 50, 0], yaw: 0 }, gravity: 12, extent: 1200 });
  // pitch the nose UP, then burn: a lander climbs by tilting back + thrust.
  for (let i = 0; i < 25; i++) Ship.surfaceUpdate(0.05, { pitch: 1, thrust: 0 }, flat);
  const yBefore = Ship.state.pos[1];
  for (let i = 0; i < 60; i++) Ship.surfaceUpdate(0.05, { pitch: 1, thrust: 1, boost: true }, flat);
  check('surface: nose-up thrust gains altitude', Ship.state.pos[1] > yBefore + 5,
    'y ' + yBefore.toFixed(1) + ' -> ' + Ship.state.pos[1].toFixed(1));
}

// ---------------------------------------------------------- (S4) X/Z clamped to +/- extent
{
  const flat = () => 0;
  const EXT = 800;
  Ship.surfaceReset({ spawn: { pos: [0, 200, 0], yaw: 0 }, gravity: 12, extent: EXT });
  const rng = makeRng(55);
  let inBounds = true;
  for (let i = 0; i < 3000; i++) {
    Ship.surfaceUpdate(0.05, {
      thrust: 1, pitch: rng() - 0.5, yaw: rng() * 2 - 1, roll: rng() * 2 - 1, boost: true,
    }, flat);
    const p = Ship.state.pos;
    if (Math.abs(p[0]) > EXT + 1e-6 || Math.abs(p[2]) > EXT + 1e-6) { inBounds = false; break; }
  }
  check('surface: X/Z stay within +/- extent', inBounds,
    'pos=[' + Ship.state.pos.map(x => x.toFixed(0)).join(',') + ']');
}

// ---------------------------------------------------------- (S5) finite + grounded flag across a long run
{
  const heightAt = (x, z) => 20 * Math.sin(x * 0.02) + 25 * Math.cos(z * 0.017) + 50;
  Ship.surfaceReset({ spawn: { pos: [10, 400, -10], yaw: 0.7 }, gravity: 13, extent: 900 });
  const rng = makeRng(2026);
  let finite = true, sawGrounded = false;
  for (let i = 0; i < 4000; i++) {
    const st = Ship.surfaceUpdate(rng() * 0.06, {
      thrust: rng() * 2 - 1, yaw: rng() * 2 - 1,
      pitch: rng() * 2 - 1, roll: rng() * 2 - 1, boost: rng() > 0.85,
    }, heightAt);
    if (!finite3(st.pos) || !finite3(st.vel) || !isFinite(st.speed) ||
        !isFinite(st.yaw) || !isFinite(st.pitch) || !isFinite(st.roll) ||
        !isFinite(st.altitude)) { finite = false; break; }
    if (st.grounded) sawGrounded = true;
  }
  check('surface: state finite across long run', finite,
    'speed=' + Ship.state.speed.toFixed(1) + ' alt=' + Ship.state.altitude.toFixed(1));
  check('surface: grounded flag set on touchdown at least once', sawGrounded);
}

// ---------------------------------------------------------- (S6) settles on the ground with zero input
{
  const flat = () => 0;
  Ship.surfaceReset({ spawn: { pos: [0, 8, 0], yaw: 0 }, gravity: 12, extent: 1200, clearance: 6 });
  for (let i = 0; i < 120; i++) Ship.surfaceUpdate(0.05, { thrust: 0 }, flat);
  const grounded = Ship.state.grounded;
  const atFloor = Math.abs(Ship.state.pos[1] - 6) < 1e-3;
  check('surface: rests on the ground (grounded + at clearance)', grounded && atFloor,
    'y=' + Ship.state.pos[1].toFixed(3) + ' grounded=' + grounded);
  check('surface: altitude == clearance when landed', Math.abs(Ship.state.altitude - 6) < 1e-3,
    'alt=' + Ship.state.altitude.toFixed(3));
}

// ---------------------------------------------------------- (S7) surfaceCameraGoal finite
{
  const heightAt = (x, z) => 30 * Math.sin(x * 0.01) + 40;
  Ship.surfaceReset({ spawn: { pos: [120, 200, -60], yaw: 0.5 }, gravity: 12, extent: 1000 });
  for (let i = 0; i < 12; i++) Ship.surfaceUpdate(0.05, { yaw: 1, pitch: 1, thrust: 0.5 }, heightAt);

  const goalFinite = (g) => g && ['targetX', 'targetY', 'targetZ', 'dist', 'yaw', 'pitch']
    .every(k => isFinite(g[k]));

  const chase = Ship.surfaceCameraGoal('chase', heightAt);
  const cockpit = Ship.surfaceCameraGoal('cockpit', heightAt);
  const chaseNoHt = Ship.surfaceCameraGoal('chase');
  check('surface: cameraGoal chase finite', goalFinite(chase), 'dist=' + chase.dist.toFixed(1));
  check('surface: cameraGoal cockpit finite', goalFinite(cockpit), 'dist=' + cockpit.dist.toFixed(1));
  check('surface: cameraGoal chase finite without heightAt', goalFinite(chaseNoHt));
  check('surface: cockpit boom tighter than chase', cockpit.dist < chase.dist,
    cockpit.dist.toFixed(1) + ' < ' + chase.dist.toFixed(1));

  // Feed through the REAL Camera3D and confirm the chase view looks along
  // the ship HEADING (yaw), matching the same convention as space cameraGoal.
  Camera3D.setGoal(chase);
  Camera3D.snap();
  const eye = Camera3D.eye();
  const t = Camera3D.target;
  const view = [t.x - eye.x, t.y - eye.y, t.z - eye.z];
  const vm = mag(view) || 1;
  view[0] /= vm; view[1] /= vm; view[2] /= vm;
  const heading = [Math.sin(Ship.state.yaw), 0, Math.cos(Ship.state.yaw)];
  const hm = mag(heading) || 1;
  const cosHeading = (view[0] * heading[0] + view[2] * heading[2]) /
    (Math.hypot(view[0], view[2]) || 1);
  check('surface: chase view points along ship heading', cosHeading > 0.9,
    'cosHeading=' + cosHeading.toFixed(4));
}

console.log('\n' + (failed === 0 ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED') +
  '  (' + passed + '/' + (passed + failed) + ')');
process.exit(failed ? 1 : 0);
