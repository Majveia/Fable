'use strict';
/* ============================================================
   FABLE UNIVERSE v2 — core physics tests (pure Node, no DOM)
   Run: node test/core.test.js
   Loads js/core/{bodies,octree,physics}.js in script-tag order;
   they attach via globalThis and never reference window/document.
   ============================================================ */

const path = require('path');
const CORE = path.join(__dirname, '..', 'js', 'core');
require(path.join(CORE, 'bodies.js'));
require(path.join(CORE, 'octree.js'));
require(path.join(CORE, 'physics.js'));

const Bodies = globalThis.Bodies;
const Octree = globalThis.Octree;
const Physics = globalThis.Physics;

// ---------------------------------------------------------------- harness
let passed = 0, failed = 0;
function check(name, cond, detail) {
  const tag = cond ? 'PASS' : 'FAIL';
  if (cond) passed++; else failed++;
  console.log(`${tag}  ${name}${detail ? '  [' + detail + ']' : ''}`);
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

function gauss(rng) {
  return (rng() + rng() + rng() + rng() - 2) / 2;
}

function resetSim(cfgOverrides) {
  Bodies.clear();
  Physics.clearPull();
  Object.assign(Physics.cfg, {
    dt: 0.25, substeps: 1, softening: 4, theta2: 0.81, theta2Base: 0.81,
    captureRadius: 6, massiveMin: 0.01, timeScale: 1, paused: false,
    t: 0, myrPerT: 1,
  }, cfgOverrides || {});
}

function bruteAccel(i, soft2, out) {
  const { px, py, pz, mass, n } = Bodies;
  let ax = 0, ay = 0, az = 0;
  const x = px[i], y = py[i], z = pz[i];
  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    const dx = px[j] - x, dy = py[j] - y, dz = pz[j] - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    const inv = 1 / ((d2 + soft2) * Math.sqrt(d2 + soft2));
    ax += mass[j] * dx * inv;
    ay += mass[j] * dy * inv;
    az += mass[j] * dz * inv;
  }
  out.x = ax; out.y = ay; out.z = az;
}

// ================================================================ 1. octree vs brute force
(function testOctreeCorrectness() {
  const rng = makeRng(12345);
  resetSim();
  const N = 200;
  for (let i = 0; i < N; i++) {
    Bodies.add(
      (rng() - 0.5) * 1000, (rng() - 0.5) * 1000, (rng() - 0.5) * 1000,
      0, 0, 0, 0.5 + rng() * 4.5, 1, 0, Bodies.TYPE_STAR, null);
  }
  const soft2 = 4;
  // Tiny node pool on purpose: exercises the doubling-grow path.
  const tree = new Octree(16);
  tree.build(0);
  check('octree builtCount equals body count', tree.builtCount === N,
        `builtCount=${tree.builtCount}`);

  const ta = { x: 0, y: 0, z: 0 }, ba = { x: 0, y: 0, z: 0 };

  // theta2 = 0: opening test size^2 < 0 never accepts an internal node,
  // so traversal reaches every leaf -> must match brute force.
  let maxRel = 0;
  for (let i = 0; i < N; i++) {
    tree.accel(Bodies.px[i], Bodies.py[i], Bodies.pz[i], 0, soft2, ta);
    bruteAccel(i, soft2, ba);
    const dn = Math.hypot(ta.x - ba.x, ta.y - ba.y, ta.z - ba.z);
    const bn = Math.hypot(ba.x, ba.y, ba.z);
    const rel = dn / (bn + 1e-300);
    if (rel > maxRel) maxRel = rel;
  }
  check('octree exact (theta2=0) matches brute force, rel err < 1e-6',
        maxRel < 1e-6, `max rel err=${maxRel.toExponential(3)}`);

  // theta2 = 0.81: typical (median) relative error < 5%.
  const rels = [];
  for (let i = 0; i < N; i++) {
    tree.accel(Bodies.px[i], Bodies.py[i], Bodies.pz[i], 0.81, soft2, ta);
    bruteAccel(i, soft2, ba);
    const dn = Math.hypot(ta.x - ba.x, ta.y - ba.y, ta.z - ba.z);
    const bn = Math.hypot(ba.x, ba.y, ba.z);
    rels.push(dn / (bn + 1e-300));
  }
  rels.sort((a, b) => a - b);
  const median = rels[N >> 1];
  check('octree approx (theta2=0.81) median rel err < 5%',
        median < 0.05, `median rel err=${(median * 100).toFixed(3)}%`);
})();

// ================================================================ 2. circular orbit sanity
(function testCircularOrbit() {
  resetSim({ softening: 0.001, captureRadius: 0 });
  const M = 10000, r0 = 100;
  const v = Math.sqrt(M / r0);            // analytic circular speed, G=1
  Bodies.add(0, 0, 0, 0, 0, 0, M, 5, 7, Bodies.TYPE_STAR, 'Center');
  const sat = Bodies.add(r0, 0, 0, 0, v, 0, 1e-6, 1, 4, Bodies.TYPE_PLANET, 'Sat');
  const period = 2 * Math.PI * r0 / v;
  const dt = period / 200;
  for (let s = 0; s < 5000; s++) Physics.step(dt);
  const r = Math.hypot(Bodies.px[sat], Bodies.py[sat], Bodies.pz[sat]);
  check('two-body circular orbit radius within 10% after 5000 steps',
        r > r0 * 0.9 && r < r0 * 1.1, `r=${r.toFixed(3)} (r0=${r0})`);
})();

// ================================================================ 3. Plummer cloud stability
(function testPlummerCloud() {
  const rng = makeRng(424242);
  resetSim({ dt: 0.25, softening: 6 });
  const N = 5000, a = 200, starM = 1.5, M = N * starM;
  for (let i = 0; i < N; i++) {
    const u = rng();
    let r = a / Math.sqrt(Math.pow(Math.max(u, 1e-9), -2 / 3) - 1);
    r = Math.min(r, a * 8);
    // Uniform direction on the sphere.
    const cosT = 2 * rng() - 1, sinT = Math.sqrt(1 - cosT * cosT);
    const ph = 2 * Math.PI * rng();
    const ux = sinT * Math.cos(ph), uy = sinT * Math.sin(ph), uz = cosT;
    const x = r * ux, y = r * uy, z = r * uz;
    // Roughly circular speed from the enclosed Plummer mass.
    const enc = M * Math.pow(r, 3) / Math.pow(r * r + a * a, 1.5);
    const vc = Math.sqrt(Math.max(enc, 0.01) / Math.max(r, 1)) * (0.6 + rng() * 0.45);
    // Tangent direction: cross(u, axis) for a non-parallel axis.
    let tx = uy * 1 - uz * 0, ty = uz * 0 - ux * 1, tz = ux * 0 - uy * 0;
    let tl = Math.hypot(tx, ty, tz);
    if (tl < 1e-6) { tx = 1; ty = 0; tz = 0; tl = 1; }
    tx /= tl; ty /= tl; tz /= tl;
    Bodies.add(x, y, z,
      vc * tx + gauss(rng) * vc * 0.3,
      vc * ty + gauss(rng) * vc * 0.3,
      vc * tz + gauss(rng) * vc * 0.3,
      starM, 1, 0, Bodies.TYPE_STAR, null);
  }
  const med0 = medianRadius();
  for (let s = 0; s < 300; s++) Physics.step(Physics.cfg.dt);
  let finite = true;
  for (let i = 0; i < Bodies.n && finite; i++) {
    finite = Number.isFinite(Bodies.px[i]) && Number.isFinite(Bodies.py[i]) &&
             Number.isFinite(Bodies.pz[i]) && Number.isFinite(Bodies.vx[i]) &&
             Number.isFinite(Bodies.vy[i]) && Number.isFinite(Bodies.vz[i]);
  }
  const med = medianRadius();
  check('plummer cloud: all positions/velocities finite after 300 steps', finite);
  check('plummer cloud: median radius bounded (< 4x initial + 100)',
        med < 4 * med0 + 100,
        `median r0=${med0.toFixed(1)} -> r=${med.toFixed(1)}`);

  function medianRadius() {
    const rs = [];
    for (let i = 0; i < Bodies.n; i++) {
      rs.push(Math.hypot(Bodies.px[i], Bodies.py[i], Bodies.pz[i]));
    }
    rs.sort((p, q) => p - q);
    return rs[rs.length >> 1];
  }
})();

// ================================================================ 4. tracer behavior
(function testTracers() {
  const rng = makeRng(777);
  resetSim({ massiveMin: 0.01, softening: 2, captureRadius: 0 });
  Bodies.add(0, 0, 0, 0, 0, 0, 1000, 5, 7, Bodies.TYPE_STAR, null);
  const tracers = [];
  for (let k = 0; k < 5; k++) {
    const cosT = 2 * rng() - 1, sinT = Math.sqrt(1 - cosT * cosT);
    const ph = 2 * Math.PI * rng();
    tracers.push(Bodies.add(
      50 * sinT * Math.cos(ph), 50 * sinT * Math.sin(ph), 50 * cosT,
      0, 0, 0, 1e-6, 0.5, 11, Bodies.TYPE_DUST, null));
  }
  // Two steps: tracers are kicked on alternating steps (subcycling),
  // so a single step only accelerates half of them.
  Physics.step(0.1);
  Physics.step(0.1);
  check('tracers excluded from tree build (builtCount=1 of 6)',
        Physics.tree.builtCount === 1 && Bodies.n === 6,
        `builtCount=${Physics.tree.builtCount}, n=${Bodies.n}`);
  let allMoved = true;
  for (const i of tracers) {
    const sp = Math.hypot(Bodies.vx[i], Bodies.vy[i], Bodies.vz[i]);
    if (!(sp > 1e-6)) allMoved = false;
  }
  check('tracers still accelerate toward massive body', allMoved);
})();

// ================================================================ 5. BH capture conservation
(function testBlackHoleCapture() {
  const rng = makeRng(31337);
  resetSim({ captureRadius: 10 });
  Bodies.add(0, 0, 0, 0.5, -0.2, 0.1, 5000, 6, 8, Bodies.TYPE_BH, null);
  // 50 bodies inside the capture radius, 100 well outside.
  for (let i = 0; i < 150; i++) {
    const inside = i < 50;
    const r = inside ? rng() * 8 : 50 + rng() * 50;
    const cosT = 2 * rng() - 1, sinT = Math.sqrt(1 - cosT * cosT);
    const ph = 2 * Math.PI * rng();
    Bodies.add(
      r * sinT * Math.cos(ph), r * sinT * Math.sin(ph), r * cosT,
      gauss(rng) * 2, gauss(rng) * 2, gauss(rng) * 2,
      2, 1, 0, Bodies.TYPE_STAR, null);
  }
  const before = totalMomentum();
  const nBefore = Bodies.n;
  // dt = 0 -> no velocity/position change from gravity; the only state
  // change in this step is the capture pass itself.
  Physics.step(0);
  const after = totalMomentum();
  const nAfter = Bodies.n;
  check('BH capture removes bodies', nAfter < nBefore,
        `n ${nBefore} -> ${nAfter}`);
  const scale = momentumScale() + 1e-300;
  const drift = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) / scale;
  check('BH capture conserves total momentum', drift < 1e-9,
        `rel drift=${drift.toExponential(3)}`);
  const totalMassOk = Math.abs(systemMass() - (5000 + 150 * 2)) < 1e-9;
  check('BH capture conserves total mass', totalMassOk,
        `mass=${systemMass()}`);

  function totalMomentum() {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < Bodies.n; i++) {
      x += Bodies.mass[i] * Bodies.vx[i];
      y += Bodies.mass[i] * Bodies.vy[i];
      z += Bodies.mass[i] * Bodies.vz[i];
    }
    return { x, y, z };
  }
  function momentumScale() {
    let s = 0;
    for (let i = 0; i < Bodies.n; i++) {
      s += Bodies.mass[i] *
        Math.hypot(Bodies.vx[i], Bodies.vy[i], Bodies.vz[i]);
    }
    return s;
  }
  function systemMass() {
    let s = 0;
    for (let i = 0; i < Bodies.n; i++) s += Bodies.mass[i];
    return s;
  }
})();

// ================================================================ 6. performance budget
(function testPerformance() {
  const rng = makeRng(99);
  resetSim({ dt: 0.1, softening: 6, theta2: 0.81 });
  const addSphere = (count, mass) => {
    for (let i = 0; i < count; i++) {
      const r = Math.cbrt(rng()) * 1000;
      const cosT = 2 * rng() - 1, sinT = Math.sqrt(1 - cosT * cosT);
      const ph = 2 * Math.PI * rng();
      Bodies.add(
        r * sinT * Math.cos(ph), r * sinT * Math.sin(ph), r * cosT,
        gauss(rng) * 0.5, gauss(rng) * 0.5, gauss(rng) * 0.5,
        mass, 1, 0, mass >= 0.01 ? Bodies.TYPE_STAR : Bodies.TYPE_DUST, null);
    }
  };
  addSphere(8000, 1);       // massive
  addSphere(22000, 1e-4);   // tracers
  // Warm up the JIT before timing.
  for (let s = 0; s < 5; s++) Physics.step(Physics.cfg.dt);
  const PAIRS = 25;
  const times = new Array(PAIRS);
  const tAll = process.hrtime.bigint();
  for (let s = 0; s < PAIRS; s++) {
    // Tracer kicks alternate between steps (subcycling), so a step pair
    // is the natural unit of cost.
    const t0 = process.hrtime.bigint();
    Physics.step(Physics.cfg.dt);
    Physics.step(Physics.cfg.dt);
    times[s] = Number(process.hrtime.bigint() - t0) / 1e6 / 2;
  }
  const mean = Number(process.hrtime.bigint() - tAll) / 1e6 / (PAIRS * 2);
  times.sort((a, b) => a - b);
  const median = times[PAIRS >> 1];
  // Median per-step-pair time: immune to one-off scheduler/GC hiccups that
  // do not reflect the simulator's actual step cost.
  // Regression tripwire, not a product guarantee — leave headroom for
  // slow/shared CI runners (browser builds adapt theta at runtime anyway).
  check('performance: 8000 massive + 22000 tracers <= 40 ms/step',
        median <= 40,
        `median ${median.toFixed(2)} ms/step, mean ${mean.toFixed(2)} ms/step`);
})();

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
