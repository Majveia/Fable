'use strict';
/* ============================================================
   FABLE: DRIFTER v8 — Avatar (on-foot controller) tests.
   Pure Node, no DOM. Run: node test/avatar.test.js (exit 1 on fail).

   Loads js/game/avatar.js via indirect-eval-to-global (matching
   test/smoke.js / test/ship.test.js) so globalThis.Avatar exists.
   The avatar lives entirely in SHIP SPACE (+Z forward, +Y up,
   +X right). We exercise it against a STUB model exposing one big
   axis-aligned box bound + clamp(), so these tests don't depend on
   the real ShipModel.
   ============================================================ */

const fs = require('fs');
const path = require('path');

(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js/game/avatar.js'), 'utf8'));

const { Avatar } = globalThis;

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

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mag = (v) => Math.hypot(v[0], v[1], v[2]);
const finite3 = (v) => Array.isArray(v) && v.length === 3 &&
  isFinite(v[0]) && isFinite(v[1]) && isFinite(v[2]);

// ---- Stub model: one big AABB walkable bound + clamp to nearest inside.
function makeBoxModel(min, max) {
  return {
    bounds: [{ min: min.slice(), max: max.slice() }],
    clamp(p) {
      return [
        Math.max(min[0], Math.min(max[0], p[0])),
        Math.max(min[1], Math.min(max[1], p[1])),
        Math.max(min[2], Math.min(max[2], p[2])),
      ];
    },
  };
}
const BOX = makeBoxModel([-50, -50, -50], [50, 50, 50]);
const inBox = (p, m) => p[0] >= m.bounds[0].min[0] - 1e-6 && p[0] <= m.bounds[0].max[0] + 1e-6 &&
  p[1] >= m.bounds[0].min[1] - 1e-6 && p[1] <= m.bounds[0].max[1] + 1e-6 &&
  p[2] >= m.bounds[0].min[2] - 1e-6 && p[2] <= m.bounds[0].max[2] + 1e-6;

const NONE = { fwd: 0, strafe: 0, turn: 0, lookPitch: 0, run: false };

// ---------------------------------------------------------- (0) reset stands at seat
{
  const seat = { pos: [3, 0, -2], forward: [0, 0, 1], eye: [3, 1.7, -2] };
  Avatar.reset({ seat });
  const s = Avatar.state;
  check('reset stands avatar at seat pos', dist3(s.pos, seat.pos) < 1e-9,
    'pos=[' + s.pos.join(',') + ']');
  check('reset faces seat forward (+Z => yaw 0)', Math.abs(s.yaw) < 1e-9 && s.pitch === 0 && s.moving === false,
    'yaw=' + s.yaw.toFixed(4));
  // seat forward toward +X => yaw ~ +PI/2
  Avatar.reset({ seat: { pos: [0, 0, 0], forward: [1, 0, 0] } });
  check('reset derives heading from seat forward', Math.abs(Avatar.state.yaw - Math.PI / 2) < 1e-6,
    'yaw=' + Avatar.state.yaw.toFixed(4));
}

// ---------------------------------------------------------- (1) fwd>0 moves forward along yaw
{
  Avatar.reset({ seat: { pos: [0, 0, 0], forward: [0, 0, 1] } });   // yaw 0 -> +Z
  const p0 = Avatar.state.pos.slice();
  for (let i = 0; i < 40; i++) Avatar.update(0.05, { ...NONE, fwd: 1 }, BOX);
  const p1 = Avatar.state.pos;
  const moved = dist3(p0, p1);
  // forward at yaw 0 is +Z, so motion is dominated by +Z; X/Y ~ 0.
  check('fwd>0 moves avatar forward', moved > 0.5, 'moved=' + moved.toFixed(2));
  check('fwd at yaw0 moves along +Z', p1[2] > 0.5 && Math.abs(p1[0]) < 1e-6 && Math.abs(p1[1]) < 1e-6,
    'pos=[' + p1.map(x => x.toFixed(2)).join(',') + ']');
  check('fwd movement stays in bounds', inBox(p1, BOX), 'pos=[' + p1.map(x => x.toFixed(1)).join(',') + ']');
  check('moving flag set while walking', Avatar.state.moving === true);
}

// ---------------------------------------------------------- (1b) fwd respects yaw heading
{
  // Yaw to +PI/2 (look toward +X), then walk forward -> +X motion.
  Avatar.reset({ seat: { pos: [0, 0, 0], forward: [1, 0, 0] } });   // yaw +PI/2
  const p0 = Avatar.state.pos.slice();
  for (let i = 0; i < 40; i++) Avatar.update(0.05, { ...NONE, fwd: 1 }, BOX);
  const p1 = Avatar.state.pos;
  check('forward direction tracks yaw (+X heading -> +X motion)',
    p1[0] > 0.5 && Math.abs(p1[2]) < 1e-6, 'pos=[' + p1.map(x => x.toFixed(2)).join(',') + ']');
}

// ---------------------------------------------------------- (2) strafe moves sideways
{
  Avatar.reset({ seat: { pos: [0, 0, 0], forward: [0, 0, 1] } });   // yaw 0 -> +Z, right = +X
  for (let i = 0; i < 40; i++) Avatar.update(0.05, { ...NONE, strafe: 1 }, BOX);
  const p1 = Avatar.state.pos;
  // right(yaw=0) = [cos0, 0, -sin0] = [1,0,0]: strafe+ moves toward +X.
  check('strafe>0 moves sideways (+X at yaw0)',
    p1[0] > 0.5 && Math.abs(p1[2]) < 1e-6 && Math.abs(p1[1]) < 1e-6,
    'pos=[' + p1.map(x => x.toFixed(2)).join(',') + ']');
  check('strafe is perpendicular to forward', inBox(p1, BOX));
}

// ---------------------------------------------------------- (3) turn changes yaw
{
  Avatar.reset({ seat: { pos: [0, 0, 0], forward: [0, 0, 1] } });
  const y0 = Avatar.state.yaw;
  for (let i = 0; i < 20; i++) Avatar.update(0.05, { ...NONE, turn: 1 }, BOX);
  const y1 = Avatar.state.yaw;
  check('turn changes yaw', Math.abs(y1 - y0) > 0.1 && isFinite(y1),
    'yaw ' + y0.toFixed(3) + ' -> ' + y1.toFixed(3));
}

// ---------------------------------------------------------- (4) lookPitch clamps to ~±1.4
{
  Avatar.reset({ seat: { pos: [0, 0, 0], forward: [0, 0, 1] } });
  for (let i = 0; i < 200; i++) Avatar.update(0.05, { ...NONE, lookPitch: 1 }, BOX);
  const up = Avatar.state.pitch;
  for (let i = 0; i < 400; i++) Avatar.update(0.05, { ...NONE, lookPitch: -1 }, BOX);
  const dn = Avatar.state.pitch;
  check('lookPitch clamps near +1.4', up <= 1.4 + 1e-9 && up > 1.3, 'pitch=' + up.toFixed(4));
  check('lookPitch clamps near -1.4', dn >= -1.4 - 1e-9 && dn < -1.3, 'pitch=' + dn.toFixed(4));
}

// ---------------------------------------------------------- (4b) NON-INVERTED look axis
{
  // Mirrors the ship contract: the input mapping (js/main.js) negates drag-down
  // so it feeds a NEGATIVE lookPitch (look down), and the avatar treats +pitch
  // as look UP. Assert that sign convention: lookPitch +1 raises the look (fp
  // forward Y > 0 = up), lookPitch -1 lowers it. A flip here = inverted mouse.
  Avatar.reset({ seat: { pos: [0, 0, 0], forward: [0, 0, 1] } });
  for (let i = 0; i < 8; i++) Avatar.update(0.05, { ...NONE, lookPitch: 1 }, BOX);
  const up = Avatar.cameraMount('fp').forward[1];
  Avatar.reset({ seat: { pos: [0, 0, 0], forward: [0, 0, 1] } });
  for (let i = 0; i < 8; i++) Avatar.update(0.05, { ...NONE, lookPitch: -1 }, BOX);
  const down = Avatar.cameraMount('fp').forward[1];
  check('non-inverted: +lookPitch looks UP, -lookPitch looks DOWN',
    up > 0.05 && down < -0.05, 'up=' + up.toFixed(3) + ' down=' + down.toFixed(3));
}

// ---------------------------------------------------------- (5) fp/tp mounts finite & distinct
{
  Avatar.reset({ seat: { pos: [5, 0, 5], forward: [0, 0, 1] } });
  for (let i = 0; i < 8; i++) Avatar.update(0.05, { ...NONE, turn: 0.5, lookPitch: 0.4 }, BOX);
  const fp = Avatar.cameraMount('fp');
  const tp = Avatar.cameraMount('tp');
  const head = [Avatar.state.pos[0], Avatar.state.pos[1] + 1.7, Avatar.state.pos[2]];

  check('fp mount finite (pos/forward/up)',
    finite3(fp.pos) && finite3(fp.forward) && finite3(fp.up), JSON.stringify(fp));
  check('tp mount finite (pos/forward/up)',
    finite3(tp.pos) && finite3(tp.forward) && finite3(tp.up), JSON.stringify(tp));
  check('fp forward is unit length', Math.abs(mag(fp.forward) - 1) < 1e-6, '|f|=' + mag(fp.forward).toFixed(6));
  check('tp forward is unit length', Math.abs(mag(tp.forward) - 1) < 1e-6, '|f|=' + mag(tp.forward).toFixed(6));
  check('fp/tp mount positions distinct', dist3(fp.pos, tp.pos) > 1e-3,
    'd=' + dist3(fp.pos, tp.pos).toFixed(3));
  // tp camera must be FURTHER from the avatar than the fp camera (which sits at the head).
  check('tp camera further from avatar than fp',
    dist3(tp.pos, head) > dist3(fp.pos, head) + 0.5,
    'tp=' + dist3(tp.pos, head).toFixed(2) + ' fp=' + dist3(fp.pos, head).toFixed(2));
  // tp looks roughly toward the avatar's head (forward dotted with dir-to-head > 0).
  const toHead = [head[0] - tp.pos[0], head[1] - tp.pos[1], head[2] - tp.pos[2]];
  const tl = mag(toHead) || 1;
  const cos = (tp.forward[0] * toHead[0] + tp.forward[1] * toHead[1] + tp.forward[2] * toHead[2]) / tl;
  check('tp camera looks toward the avatar', cos > 0.99, 'cos=' + cos.toFixed(4));
}

// ---------------------------------------------------------- (6) fp eye sits above feet, looks along yaw/pitch
{
  Avatar.reset({ seat: { pos: [1, 2, 3], forward: [0, 0, 1] } });
  const fp = Avatar.cameraMount('fp');
  check('fp eye above feet by eye height', fp.pos[1] > Avatar.state.pos[1] + 1.0 &&
    Math.abs(fp.pos[0] - 1) < 1e-9 && Math.abs(fp.pos[2] - 3) < 1e-9,
    'eye=[' + fp.pos.map(x => x.toFixed(2)).join(',') + ']');
  // yaw 0, pitch 0 -> forward +Z
  check('fp forward at rest is +Z', Math.abs(fp.forward[2] - 1) < 1e-6 &&
    Math.abs(fp.forward[0]) < 1e-9 && Math.abs(fp.forward[1]) < 1e-9,
    'f=[' + fp.forward.map(x => x.toFixed(3)).join(',') + ']');
}

// ---------------------------------------------------------- (7) 1000 random steps: in bounds + finite
{
  Avatar.reset({ seat: { pos: [0, 0, 0], forward: [0, 0, 1] } });
  const rng = makeRng(4242);
  let ok = true, why = '';
  for (let i = 0; i < 1000; i++) {
    Avatar.update(rng() * 0.06, {
      fwd: rng() * 2 - 1,
      strafe: rng() * 2 - 1,
      turn: rng() * 2 - 1,
      lookPitch: rng() * 2 - 1,
      run: rng() > 0.5,
    }, BOX);
    const s = Avatar.state;
    if (!finite3(s.pos) || !isFinite(s.yaw) || !isFinite(s.pitch)) { ok = false; why = 'non-finite state'; break; }
    if (!inBox(s.pos, BOX)) { ok = false; why = 'left bounds at [' + s.pos.map(x => x.toFixed(1)).join(',') + ']'; break; }
    if (Math.abs(s.pitch) > 1.4 + 1e-9) { ok = false; why = 'pitch exceeded clamp ' + s.pitch.toFixed(3); break; }
  }
  check('1000 random steps keep pos in bounds & state finite', ok, why ||
    'final pos=[' + Avatar.state.pos.map(x => x.toFixed(1)).join(',') + ']');
  // mounts must remain finite after the stress run.
  const fp = Avatar.cameraMount('fp'), tp = Avatar.cameraMount('tp');
  check('mounts finite after stress run',
    finite3(fp.pos) && finite3(fp.forward) && finite3(tp.pos) && finite3(tp.forward));
}

// ---------------------------------------------------------- (8) clamp actually contains an escapee
{
  // Tiny box: push hard forward; without clamp we'd blow past +Z=2.
  const TINY = makeBoxModel([-2, -2, -2], [2, 2, 2]);
  Avatar.reset({ seat: { pos: [0, 0, 0], forward: [0, 0, 1] } });
  for (let i = 0; i < 200; i++) Avatar.update(0.05, { ...NONE, fwd: 1, run: true }, TINY);
  check('clamp keeps avatar inside a tight bound', inBox(Avatar.state.pos, TINY),
    'pos=[' + Avatar.state.pos.map(x => x.toFixed(2)).join(',') + ']');
  check('avatar pressed against the +Z wall', Math.abs(Avatar.state.pos[2] - 2) < 1e-6,
    'z=' + Avatar.state.pos[2].toFixed(4));
}

// ---------------------------------------------------------- (9) idle damping brings avatar to rest
{
  Avatar.reset({ seat: { pos: [0, 0, 0], forward: [0, 0, 1] } });
  for (let i = 0; i < 20; i++) Avatar.update(0.05, { ...NONE, fwd: 1 }, BOX);
  check('moving while input held', Avatar.state.moving === true);
  for (let i = 0; i < 80; i++) Avatar.update(0.05, NONE, BOX);
  check('idle damping stops the avatar', Avatar.state.moving === false,
    'moving=' + Avatar.state.moving);
}

console.log('\n' + (failed === 0 ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED') +
  '  (' + passed + '/' + (passed + failed) + ')');
process.exit(failed ? 1 : 0);
