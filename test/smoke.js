'use strict';
// Scenario-level smoke test for FABLE UNIVERSE v2 (3D).
// Pure Node: core files and scenarios.js are DOM-free by contract.
// Run: node test/smoke.js

const fs = require('fs');
const path = require('path');

for (const f of ['js/core/bodies.js', 'js/core/octree.js', 'js/core/physics.js', 'js/scenarios.js']) {
  // Indirect eval -> global scope, matching <script> tag semantics.
  (0, eval)(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
}

const { Bodies, Physics, Scenarios } = globalThis;

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
  sc.init();
  const n0 = Bodies.n, r0 = medianRadius(), tracers = countTracers();
  const t0 = process.hrtime.bigint();
  for (let s = 0; s < STEPS; s++) Physics.step(Physics.cfg.dt / Physics.cfg.substeps);
  const perStep = Number(process.hrtime.bigint() - t0) / 1e6 / STEPS;

  assert(allFinite(), `${sc.key}: finite after ${STEPS} steps`);
  const r1 = medianRadius();
  assert(r1 < r0 * 4 + 100, `${sc.key}: bounded (median r ${r0.toFixed(0)} -> ${r1.toFixed(0)})`);
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
  Scenarios.list.find(s => s.key === 'cluster').init();
  const before = Bodies.n;
  Bodies.add(0, 0, 0, 0, 0, 0, 6000, 3, 8, Bodies.TYPE_BH, null);
  for (let s = 0; s < 200; s++) Physics.step(Physics.cfg.dt / Physics.cfg.substeps);
  assert(Bodies.n < before + 1, `accretion: black hole feeds (${before + 1} -> ${Bodies.n})`);
  assert(allFinite(), 'accretion: finite after feeding');
}

// Interactive gravity well must perturb without NaNs.
{
  Bodies.clear(); Physics.cfg.t = 0;
  Scenarios.list.find(s => s.key === 'galaxy').init();
  Physics.setPull(300, 100, 0, 30000);
  for (let s = 0; s < 60; s++) Physics.step(Physics.cfg.dt);
  Physics.clearPull();
  assert(allFinite(), 'gravity well: finite under external pull');
}

process.exit(failed ? 1 : 0);
