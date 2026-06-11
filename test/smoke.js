'use strict';
// Scenario-level smoke test for FABLE UNIVERSE v2 (3D).
// Pure Node: core files and scenarios.js are DOM-free by contract.
// Run: node test/smoke.js

const fs = require('fs');
const path = require('path');

for (const f of ['js/core/bodies.js', 'js/core/octree.js', 'js/core/physics.js', 'js/core/evolution.js', 'js/scenarios.js']) {
  // Indirect eval -> global scope, matching <script> tag semantics.
  (0, eval)(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
}

const { Bodies, Physics, Scenarios, Evolution } = globalThis;
const BUDGET = { gpu: false, maxBodies: 1 << 17 };

let failed = false;
const assert = (cond, msg) => {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failed = true;
};

function allFinite() {
  const { px, py, pz, vx, vy, vz, n } = Bodies;
  for (let i = 0; i < n; i++) {
    if (!isFinite(px[i]) || !isFinite(py[i]) || !isFinite(pz[i]) ||
        !isFinite(vx[i]) || !isFinite(vy[i]) || !isFinite(vz[i])) return false;
  }
  return true;
}
function medianRadius() {
  const { px, py, pz, n } = Bodies;
  const r = new Array(n);
  for (let i = 0; i < n; i++) r[i] = Math.hypot(px[i], py[i], pz[i]);
  r.sort((a, b) => a - b);
  return r[n >> 1] || 0;
}
function countTracers() {
  let c = 0;
  for (let i = 0; i < Bodies.n; i++) if (Bodies.mass[i] < Physics.cfg.massiveMin) c++;
  return c;
}

const STEPS = 300;
for (const sc of Scenarios.list) {
  Bodies.clear();
  Physics.cfg.t = 0;
  Physics.cfg.theta2 = Physics.cfg.theta2Base;
  Physics.clearPull();
  sc.init(BUDGET);
  const n0 = Bodies.n, r0 = medianRadius(), tracers = countTracers();
  // Median per-step-pair time: tracer kicks alternate between steps
  // (subcycling), and this box's shared CPU makes means noisy.
  const times = new Array(STEPS >> 1);
  for (let s = 0; s < STEPS >> 1; s++) {
    const t0 = process.hrtime.bigint();
    Physics.step(Physics.cfg.dt / Physics.cfg.substeps);
    Physics.step(Physics.cfg.dt / Physics.cfg.substeps);
    times[s] = Number(process.hrtime.bigint() - t0) / 1e6 / 2;
  }
  times.sort((a, b) => a - b);
  const perStep = times[STEPS >> 2];

  assert(allFinite(), `${sc.key}: finite after ${STEPS} steps`);
  const r1 = medianRadius();
  // bigbang expands enormously by design; the supercluster also has a
  // mild Hubble flow on a huge volume.
  const boundMul = sc.key === 'bigbang' ? 20 : sc.key === 'supercluster' ? 8 : 4;
  assert(r1 < r0 * boundMul + 100, `${sc.key}: bounded (median r ${r0.toFixed(0)} -> ${r1.toFixed(0)})`);
  assert(perStep <= 35, `${sc.key}: perf ${perStep.toFixed(1)} ms/step, ${n0} bodies`);
  if (tracers > 0) {
    assert(Physics.tree.builtCount < n0,
      `${sc.key}: octree built from massive only (${Physics.tree.builtCount}/${n0})`);
  }
  console.log(`     ${sc.key}: bodies ${n0} -> ${Bodies.n}, tracers ${tracers}`);
}

// Black hole dropped into the cluster must feed without breaking anything.
{
  Bodies.clear(); Physics.cfg.t = 0; Physics.clearPull();
  Scenarios.list.find(s => s.key === 'cluster').init(BUDGET);
  const before = Bodies.n;
  Bodies.add(0, 0, 0, 0, 0, 0, 6000, 3, 8, Bodies.TYPE_BH, null);
  for (let s = 0; s < 200; s++) Physics.step(Physics.cfg.dt / Physics.cfg.substeps);
  assert(Bodies.n < before + 1, `accretion: black hole feeds (${before + 1} -> ${Bodies.n})`);
  assert(allFinite(), 'accretion: finite after feeding');
}

// Interactive gravity well must perturb without NaNs.
{
  Bodies.clear(); Physics.cfg.t = 0;
  Scenarios.list.find(s => s.key === 'galaxy').init(BUDGET);
  Physics.setPull(300, 100, 0, 30000);
  for (let s = 0; s < 60; s++) Physics.step(Physics.cfg.dt);
  Physics.clearPull();
  assert(allFinite(), 'gravity well: finite under external pull');
}

// Moons stay bound to their hosts.
{
  Bodies.clear(); Physics.cfg.t = 0; Physics.clearPull();
  Scenarios.list.find(s => s.key === 'solar').init(BUDGET);
  const idx = (name) => Bodies.names.indexOf(name);
  const dist = (a, b) => Math.hypot(
    Bodies.px[a] - Bodies.px[b], Bodies.py[a] - Bodies.py[b], Bodies.pz[a] - Bodies.pz[b]);
  for (let s = 0; s < 300; s++) Physics.step(Physics.cfg.dt / Physics.cfg.substeps);
  assert(dist(idx('Moon'), idx('Earth')) < 12,
    `moons: Moon bound to Earth (d=${dist(idx('Moon'), idx('Earth')).toFixed(1)})`);
  assert(dist(idx('Titan'), idx('Saturn')) < 35,
    `moons: Titan bound to Saturn (d=${dist(idx('Titan'), idx('Saturn')).toFixed(1)})`);
  assert(dist(idx('Ganymede'), idx('Jupiter')) < 30,
    `moons: Ganymede bound to Jupiter (d=${dist(idx('Ganymede'), idx('Jupiter')).toFixed(1)})`);
}

// Stellar evolution interleaved with the galaxy scenario.
{
  Bodies.clear(); Physics.cfg.t = 0; Physics.clearPull();
  Scenarios.list.find(s => s.key === 'galaxy').init(BUDGET);
  Evolution.reset(Physics.evolutionView(), 42);
  const n0 = Bodies.n;
  let fired = 0, lastT = 0;
  for (let s = 0; s < 600; s++) {
    Physics.step(Physics.cfg.dt);
    if (s % 10 === 9) {
      fired += Evolution.step(Physics.evolutionView(), (Physics.cfg.t - lastT) * Physics.cfg.myrPerT);
      lastT = Physics.cfg.t;
    }
  }
  assert(allFinite(), 'evolution: finite after interleaved run');
  assert(fired >= 1, `evolution: supernovae fired (${fired})`);
  assert(Math.abs(Bodies.n - n0) < n0 * 0.05,
    `evolution: does not destroy bodies (${n0} -> ${Bodies.n})`);
}

process.exit(failed ? 1 : 0);
