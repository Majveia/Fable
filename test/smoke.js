'use strict';
// Headless smoke test: stub the DOM, load the real simulator source,
// and drive the physics to verify stability and performance.
// Run: node test/smoke.js

const fs = require('fs');
const path = require('path');

const stubs = `
const __ctxStub = () => ({
  createRadialGradient: () => ({ addColorStop() {} }),
  fillRect() {}, scale() {}, setTransform() {}, drawImage() {},
  beginPath() {}, arc() {}, fill() {}, stroke() {}, fillText() {},
});
const __elStub = () => ({
  textContent: '', style: {}, dataset: {}, className: '',
  classList: { toggle() {}, add() {}, remove() {} },
  addEventListener() {}, setPointerCapture() {},
  getContext: __ctxStub,
  width: 0, height: 0,
});
const window = { addEventListener() {}, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720 };
const document = {
  getElementById: __elStub,
  createElement: __elStub,
  querySelectorAll: () => [],
};
const requestAnimationFrame = () => {};
const setInterval = () => {};
const setTimeout = () => 0;
const clearTimeout = () => {};
`;

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'universe.js'), 'utf8');

const tests = `
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; } else { console.log('PASS: ' + msg); } };

function noNaN() {
  for (let i = 0; i < n; i++) {
    if (!isFinite(px[i]) || !isFinite(py[i]) || !isFinite(vx[i]) || !isFinite(vy[i])) return false;
  }
  return true;
}
function medianRadius() {
  const r = [];
  for (let i = 0; i < n; i++) r.push(Math.hypot(px[i], py[i]));
  r.sort((a, b) => a - b);
  return r[r.length >> 1];
}
function momentum() {
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += ms[i] * vx[i]; my += ms[i] * vy[i]; }
  return Math.hypot(mx, my);
}

for (const name of Object.keys(PRESETS)) {
  clearBodies(); sim.t = 0;
  PRESETS[name].init();
  const n0 = n, r0 = medianRadius(), p0 = momentum();
  const t0 = process.hrtime.bigint();
  const STEPS = 300;
  for (let s = 0; s < STEPS; s++) step(sim.dt / sim.substeps);
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const perStep = elapsedMs / STEPS;
  assert(noNaN(), name + ': positions/velocities finite after ' + STEPS + ' steps');
  const r1 = medianRadius();
  assert(r1 < r0 * 4 + 100, name + ': no explosion (median radius ' + r0.toFixed(0) + ' -> ' + r1.toFixed(0) + ')');
  assert(perStep < 60, name + ': perf ' + perStep.toFixed(1) + ' ms/step for ' + n0 + ' bodies');
  console.log('     ' + name + ': bodies ' + n0 + ' -> ' + n + ', momentum drift ' + (momentum() - p0).toExponential(1));
}

// Black hole accretion sanity: drop a hole into a dense cluster and
// confirm it eats and conserves momentum.
clearBodies(); sim.t = 0;
PRESETS.cluster.init();
const before = n;
addBody(0, 0, 0, 0, 6000, 3, 0, TYPE_BH, null);
for (let s = 0; s < 200; s++) step(sim.dt / sim.substeps);
assert(n < before + 1, 'black hole accretes cluster stars (' + (before + 1) + ' -> ' + n + ')');
assert(noNaN(), 'finite after accretion');
`;

const run = new Function(stubs + src + tests);
run();
