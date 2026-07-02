'use strict';
/* ============================================================
   FABLE: DRIFTER v8 — ShipModel geometry tests (pure Node, no DOM).
   Run: node test/shipmodel.test.js   (exit 1 on any failure)

   Loads js/game/shipmodel.js via indirect-eval-to-global (matching
   test/smoke.js / test/ship.test.js) so globalThis.ShipModel exists.
   We verify the wireframe + interior contract: lines are non-empty,
   length divisible by 6, all finite; bounds non-empty; clamp pulls a
   far-outside point into some bound; the seat and every node sit
   inside the walkable bounds; and the geometry is deterministic
   across two build() calls (idempotent cache).
   ============================================================ */

const fs = require('fs');
const path = require('path');

(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js/game/shipmodel.js'), 'utf8'));

const { ShipModel } = globalThis;

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

const finite3 = (v) => isFinite(v[0]) && isFinite(v[1]) && isFinite(v[2]);
function insideAny(p, bounds) {
  for (let i = 0; i < bounds.length; i++) {
    const b = bounds[i];
    if (p[0] >= b.min[0] - 1e-9 && p[0] <= b.max[0] + 1e-9 &&
        p[1] >= b.min[1] - 1e-9 && p[1] <= b.max[1] + 1e-9 &&
        p[2] >= b.min[2] - 1e-9 && p[2] <= b.max[2] + 1e-9) return true;
  }
  return false;
}

ShipModel.build();

// ---------------------------------------------------------- (1) scale & color
{
  check('scale ~16 world units', ShipModel.scale > 10 && ShipModel.scale < 24,
    'scale=' + ShipModel.scale);
  const c = ShipModel.lineColor;
  check('lineColor is [r,g,b] in 0..1', Array.isArray(c) && c.length === 3 &&
    c.every(v => v >= 0 && v <= 1), 'lineColor=[' + c.join(',') + ']');
  // cyan-ish: blue/green dominate red.
  check('lineColor reads cyan-ish (g,b > r)', c[1] > c[0] && c[2] > c[0],
    '[' + c.map(v => v.toFixed(2)).join(',') + ']');
}

// ---------------------------------------------------------- (2) lines: non-empty, %6, finite
{
  const L = ShipModel.lines;
  check('lines is a Float32Array', L instanceof Float32Array);
  check('lines non-empty', L.length > 0, 'len=' + L.length);
  check('lines length divisible by 6 (segment endpoints)', L.length % 6 === 0,
    'len=' + L.length);
  let allFin = true;
  for (let i = 0; i < L.length; i++) if (!isFinite(L[i])) { allFin = false; break; }
  check('all line coordinates finite', allFin);
  // sanity: hull actually spans forward (+Z nose) and aft (-Z engine).
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 2; i < L.length; i += 3) { if (L[i] < zmin) zmin = L[i]; if (L[i] > zmax) zmax = L[i]; }
  check('hull spans a pointed nose at +Z and engine at -Z', zmax > 6 && zmin < -6,
    'z in [' + zmin.toFixed(1) + ',' + zmax.toFixed(1) + ']');
}

// ---------------------------------------------------------- (2b) solid mesh: tris/norms/triColor
{
  const T = ShipModel.tris, N = ShipModel.norms, C = ShipModel.triColor;
  check('tris is a Float32Array', T instanceof Float32Array);
  check('norms is a Float32Array', N instanceof Float32Array);
  check('triColor is a Float32Array', C instanceof Float32Array);
  check('tris non-empty', T.length > 0, 'len=' + T.length);
  check('tris length multiple of 9 (3 verts x xyz)', T.length % 9 === 0, 'len=' + T.length);
  check('norms length matches tris', N.length === T.length, 'tris=' + T.length + ' norms=' + N.length);
  const nTri = T.length / 9;
  check('triColor length is 3 per triangle', C.length === nTri * 3,
    'triColor=' + C.length + ' expected=' + (nTri * 3));
  // all finite
  let allFin = true;
  for (let i = 0; i < T.length; i++) if (!isFinite(T[i]) || !isFinite(N[i])) { allFin = false; break; }
  for (let i = 0; i < C.length; i++) if (!isFinite(C[i])) { allFin = false; break; }
  check('all tri/norm/color values finite', allFin);
  // every per-vertex normal is approximately unit length
  let unitOk = true, worst = 0;
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]);
    const e = Math.abs(l - 1);
    if (e > worst) worst = e;
    if (e > 1e-3) { unitOk = false; }
  }
  check('all normals approximately unit length (<=1e-3)', unitOk, 'worst err=' + worst.toExponential(2));
  // mesh spans nose (+Z) to engine (-Z) like the wireframe.
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 2; i < T.length; i += 3) { if (T[i] < zmin) zmin = T[i]; if (T[i] > zmax) zmax = T[i]; }
  check('solid hull spans nose +Z to engine -Z', zmax > 6 && zmin < -6,
    'z in [' + zmin.toFixed(1) + ',' + zmax.toFixed(1) + ']');

  // detail level: the believable hull is meaningfully detailed (panel
  // greebles, RCS quads, bell nozzles, sensor domes) -> a healthy tri count,
  // but bounded so the overlay upload stays cheap.
  check('mesh is detailed (>= 400 triangles)', nTri >= 400, 'nTri=' + nTri);
  check('mesh stays lean (<= 2500 triangles)', nTri <= 2500, 'nTri=' + nTri);

  // material colours are non-negative and finite; emissive (>1) is allowed
  // ONLY for two deliberate glow families: WARM (engine throat / cabin light
  // strips: R>1, R>=G>=B) and TEAL (console screens / engine readout:
  // B>1, B>=G>=R). Confirm at least one of each exists, and reject any other
  // over-bright material (spurious emissive would look wrong under bloom).
  let colNonNeg = true, warmEmissive = 0, tealEmissive = 0, badEmissive = 0;
  for (let i = 0; i < C.length; i += 3) {
    const r = C[i], g = C[i + 1], b = C[i + 2];
    if (r < 0 || g < 0 || b < 0) colNonNeg = false;
    if (r > 1 || g > 1 || b > 1) {
      if (r > 1 && r >= g && g >= b) warmEmissive++;        // warm glow (engine)
      else if (b > 1 && b >= g && g >= r) tealEmissive++;   // teal screens
      else badEmissive++;                                   // anything else
    }
  }
  check('all triColor channels non-negative', colNonNeg);
  check('has warm emissive glow (engine throat, R>1, R>=G>=B)', warmEmissive > 0,
    'warmEmissive=' + warmEmissive);
  check('has teal emissive screens (console/readout, B>1, B>=G>=R)', tealEmissive > 0,
    'tealEmissive=' + tealEmissive);
  check('no other over-bright emissive material', badEmissive === 0,
    'badEmissive=' + badEmissive);

  // winding vs stored normals: the geometric face normal (from CCW winding)
  // must agree (dot > 0) with the averaged stored vertex normal for EVERY
  // triangle, so the solid hull never shades as an inverted/black face.
  let inverted = 0;
  for (let i = 0; i < T.length; i += 9) {
    const ax = T[i+3]-T[i], ay = T[i+4]-T[i+1], az = T[i+5]-T[i+2];
    const bx = T[i+6]-T[i], by = T[i+7]-T[i+1], bz = T[i+8]-T[i+2];
    const fx = ay*bz-az*by, fy = az*bx-ax*bz, fz = ax*by-ay*bx;
    const sx = N[i]+N[i+3]+N[i+6], sy = N[i+1]+N[i+4]+N[i+7], sz = N[i+2]+N[i+5]+N[i+8];
    if (fx*sx + fy*sy + fz*sz < -1e-6) inverted++;
  }
  check('no inverted faces (winding agrees with stored normals)', inverted === 0,
    'inverted=' + inverted);
}

// ---------------------------------------------------------- (3) bounds non-empty
{
  const bs = ShipModel.bounds;
  check('bounds is a non-empty array', Array.isArray(bs) && bs.length > 0,
    'count=' + (bs && bs.length));
  let ok = true;
  for (const b of bs) {
    if (!finite3(b.min) || !finite3(b.max)) ok = false;
    if (!(b.max[0] > b.min[0] && b.max[1] > b.min[1] && b.max[2] > b.min[2])) ok = false;
  }
  check('every bound has finite min<max (non-degenerate volume)', ok);

  // bounds union is CONTINUOUS in Z: sort by zmin, each next interval must
  // start at or before the running max so there is no unwalkable seam.
  const ranges = bs.map(b => [b.min[2], b.max[2]]).sort((a, b) => a[0] - b[0]);
  let contiguous = true, reach = ranges.length ? ranges[0][1] : 0;
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i][0] > reach + 1e-9) { contiguous = false; break; }
    if (ranges[i][1] > reach) reach = ranges[i][1];
  }
  check('bounds union is continuous in Z (no unwalkable seam)', contiguous,
    'ranges=' + JSON.stringify(ranges));

  // seat sits inside some bound (cockpit).
  check('seat.pos inside a bound', insideAny(ShipModel.seat.pos, bs),
    'seat=[' + ShipModel.seat.pos.map(v => v.toFixed(2)).join(',') + ']');
}

// ---------------------------------------------------------- (4) clamp: far outside -> inside
{
  const far = [
    [1000, 1000, 1000],
    [-1000, -1000, -1000],
    [0, 500, 0],
    [50, 0, -50],
    [-30, 12, 9],
  ];
  let allIn = true, worst = null;
  for (const p of far) {
    const c = ShipModel.clamp(p);
    if (!finite3(c) || !insideAny(c, ShipModel.bounds)) { allIn = false; worst = p; break; }
  }
  check('clamp(point far outside) lands inside some bound', allIn,
    worst ? 'failed at [' + worst.join(',') + ']' : '');
  // clamp is idempotent on an already-inside point.
  const insidePt = ShipModel.nodes[0].pos.slice();
  const c2 = ShipModel.clamp(insidePt);
  check('clamp leaves an inside point unchanged',
    Math.abs(c2[0] - insidePt[0]) < 1e-9 &&
    Math.abs(c2[1] - insidePt[1]) < 1e-9 &&
    Math.abs(c2[2] - insidePt[2]) < 1e-9);
}

// ---------------------------------------------------------- (4b) clamp: random far points
{
  const rng = makeRng(1337);
  let allIn = true;
  for (let i = 0; i < 500; i++) {
    const p = [(rng() - 0.5) * 400, (rng() - 0.5) * 400, (rng() - 0.5) * 400];
    const c = ShipModel.clamp(p);
    if (!finite3(c) || !insideAny(c, ShipModel.bounds)) { allIn = false; break; }
  }
  check('clamp lands inside for 500 random far points', allIn);
}

// ---------------------------------------------------------- (5) seat & nodes inside bounds
{
  const seat = ShipModel.seat;
  check('seat has pos/forward/eye', seat && finite3(seat.pos) &&
    finite3(seat.forward) && finite3(seat.eye));
  check('seat.forward is +Z (looks forward)',
    Math.abs(seat.forward[0]) < 1e-9 && Math.abs(seat.forward[1]) < 1e-9 &&
    seat.forward[2] > 0, 'forward=[' + seat.forward.join(',') + ']');
  check('seat.pos inside bounds', insideAny(seat.pos, ShipModel.bounds),
    'pos=[' + seat.pos.map(v => v.toFixed(2)).join(',') + ']');
  check('seat.eye above seat.pos', seat.eye[1] > seat.pos[1],
    'eyeY=' + seat.eye[1].toFixed(2) + ' seatY=' + seat.pos[1].toFixed(2));
  check('seat.eye inside bounds', insideAny(seat.eye, ShipModel.bounds),
    'eye=[' + seat.eye.map(v => v.toFixed(2)).join(',') + ']');

  const nodes = ShipModel.nodes;
  check('nodes is a non-empty array', Array.isArray(nodes) && nodes.length > 0,
    'count=' + (nodes && nodes.length));
  let allInside = true, badLabel = null;
  for (const nd of nodes) {
    if (!finite3(nd.pos) || typeof nd.label !== 'string' ||
        !Number.isInteger(nd.colorIdx)) { allInside = false; badLabel = nd.label; break; }
    if (!insideAny(nd.pos, ShipModel.bounds)) { allInside = false; badLabel = nd.label; break; }
  }
  check('every node has {pos,colorIdx,label} and pos inside bounds', allInside,
    badLabel ? 'offending node: ' + badLabel : '');
  // the expected interior markers exist.
  const labels = nodes.map(n => n.label).join('|');
  check('nodes include seat/console/engine/cargo markers',
    /seat/i.test(labels) && /console/i.test(labels) &&
    /engine/i.test(labels) && /cargo/i.test(labels), labels);
}

// ---------------------------------------------------------- (6) determinism across build() calls
{
  // capture, force a rebuild with the same default seed, compare byte-for-byte.
  const a = ShipModel.lines.slice();
  const at = ShipModel.tris.slice();
  ShipModel._seed = null;             // bust the cache to force a real rebuild
  ShipModel.build();
  const b = ShipModel.lines;
  let same = a.length === b.length;
  if (same) for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; break; }
  check('two build() calls produce identical lines (deterministic)', same,
    'len ' + a.length + ' vs ' + b.length);
  const bt = ShipModel.tris;
  let tsame = at.length === bt.length;
  if (tsame) for (let i = 0; i < at.length; i++) if (at[i] !== bt[i]) { tsame = false; break; }
  check('two build() calls produce identical tris (deterministic)', tsame,
    'len ' + at.length + ' vs ' + bt.length);

  // same seed -> identical; different seed -> still valid (finite, %6).
  ShipModel.build(7); const s7 = ShipModel.lines.slice();
  ShipModel.build(7); const s7b = ShipModel.lines;
  let seedSame = s7.length === s7b.length;
  if (seedSame) for (let i = 0; i < s7.length; i++) if (s7[i] !== s7b[i]) { seedSame = false; break; }
  check('same seed -> identical geometry', seedSame);

  ShipModel.build(42);
  let fin42 = ShipModel.lines.length % 6 === 0 && ShipModel.lines.length > 0;
  for (let i = 0; i < ShipModel.lines.length; i++) if (!isFinite(ShipModel.lines[i])) { fin42 = false; break; }
  check('a different seed still yields finite %6 geometry', fin42,
    'len=' + ShipModel.lines.length);

  // restore default build so the module is in a clean state.
  ShipModel.build();
}

console.log('\n' + (failed === 0 ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED') +
  '  (' + passed + '/' + (passed + failed) + ')');
process.exit(failed ? 1 : 0);
