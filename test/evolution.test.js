'use strict';
// Stellar evolution: determinism, class ordering, remnants, mass loss.
// Run: node test/evolution.test.js

const fs = require('fs');
const path = require('path');
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js/core/evolution.js'), 'utf8'));
const { Evolution } = globalThis;

const TYPE_STAR = 0, TYPE_BH = 1;
let failed = false;
const check = (cond, msg, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg + (extra ? `  [${extra}]` : ''));
  if (!cond) failed = true;
};

function makeView(n) {
  // Mix of classes: indices 0..6 cycled, weighted toward cool dwarfs.
  const view = {
    n,
    mass: new Float64Array(n),
    rad: new Float32Array(n),
    colorIdx: new Uint8Array(n),
    type: new Uint8Array(n),
    dirtyCalls: 0,
    setDirty() { this.dirtyCalls++; },
  };
  let s = 999;
  const rng = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < n; i++) {
    const u = rng();
    view.colorIdx[i] = u < 0.08 ? 0 : u < 0.16 ? 1 : u < 0.25 ? 2
                     : u < 0.45 ? 3 : u < 0.65 ? 4 : u < 0.85 ? 5 : 6;
    view.mass[i] = 1 + rng() * 2;
    view.rad[i] = 1 + rng();
    view.type[i] = TYPE_STAR;
  }
  return view;
}

function runTo(view, myr, stepMyr) {
  let fired = 0;
  for (let t = 0; t < myr; t += stepMyr) fired += Evolution.step(view, stepMyr);
  return fired;
}

// (a) determinism
{
  const v1 = makeView(2000), v2 = makeView(2000);
  Evolution.reset(v1, 42); runTo(v1, 500, 5);
  Evolution.reset(v2, 42); runTo(v2, 500, 5);
  let same = true;
  for (let i = 0; i < 2000; i++) {
    if (v1.colorIdx[i] !== v2.colorIdx[i] || v1.rad[i] !== v2.rad[i] ||
        v1.mass[i] !== v2.mass[i] || v1.type[i] !== v2.type[i]) same = false;
  }
  check(same, 'deterministic given seed');
}

// (b)-(f) on one long run
{
  const v = makeView(2000);
  const origColor = Uint8Array.from(v.colorIdx);
  const origRad = Float32Array.from(v.rad);
  Evolution.reset(v, 42);

  const starMass = () => {
    let m = 0;
    for (let i = 0; i < v.n; i++) if (v.type[i] === TYPE_STAR) m += v.mass[i];
    return m;
  };

  let lastMass = starMass();
  let monotonic = true;
  let giantsSeen = false;
  let firedBy300 = 0;

  for (let t = 0; t < 1000; t += 5) {
    const f = Evolution.step(v, 5);
    if (t < 300) firedBy300 += f;
    const m = starMass();
    if (m > lastMass + 1e-9) monotonic = false;
    lastMass = m;
    if (!giantsSeen) {
      for (let i = 0; i < v.n; i++) {
        if (v.type[i] === TYPE_STAR && origColor[i] <= 2 &&
            v.rad[i] > origRad[i] * 1.05 && v.rad[i] < origRad[i] * 3) {
          giantsSeen = true; break;
        }
      }
    }
    if (t === 295) {
      // hot stars die first: some O/B gone supernova, no K/M left main seq.
      let hotDied = false, coolMoved = false;
      for (let i = 0; i < v.n; i++) {
        if (origColor[i] <= 1 && (v.rad[i] !== origRad[i])) hotDied = true;
        if (origColor[i] >= 5 && (v.rad[i] !== origRad[i] || v.colorIdx[i] !== origColor[i]))
          coolMoved = true;
      }
      check(hotDied && !coolMoved, 'hot stars die first; K/M untouched by 300 Myr');
    }
  }
  check(firedBy300 > 0, 'supernovae fired by 300 Myr', `${firedBy300}`);

  let bhRemnants = 0;
  for (let i = 0; i < v.n; i++) if (v.type[i] === TYPE_BH) bhRemnants++;
  check(bhRemnants >= 1, 'black hole remnant exists by 1000 Myr', `${bhRemnants}`);
  check(monotonic, 'total stellar mass decreases monotonically');
  check(v.dirtyCalls > 0, 'setDirty called', `${v.dirtyCalls} calls`);
  check(giantsSeen, 'red giants observed mid-run');
}

// growth tolerance: view.n grows between steps
{
  const v = makeView(100);
  Evolution.reset(v, 7);
  Evolution.step(v, 10);
  const grown = makeView(150);
  grown.colorIdx.set(v.colorIdx.subarray(0, 100));
  Evolution.step(grown, 10);     // must not throw, slots 100..149 init on demand
  check(true, 'tolerates view growth');
}

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
