'use strict';
/* ============================================================
   FABLE UNIVERSE v2 — scenarios
   DOM-free: loadable in Node for tests. Populates the global
   Bodies store and configures Physics per docs/ARCHITECTURE.md.
   G = 1 throughout.
   ============================================================ */
(() => {

const B = () => globalThis.Bodies;
const P = () => globalThis.Physics;

const TYPE_STAR = 0, TYPE_BH = 1, TYPE_PLANET = 2, TYPE_DUST = 3, TYPE_GAS = 4;

// Seedable RNG so a shared URL reproduces the exact same universe.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let _rng = Math.random;
const rand = (a, b) => a + _rng() * (b - a);
const gauss = () => (_rng() + _rng() + _rng() + _rng() - 2) / 2;

// Cool dwarfs dominate real stellar populations.
function starColor() {
  const u = _rng();
  if (u < 0.45) return 6;
  if (u < 0.70) return 5;
  if (u < 0.85) return 4;
  if (u < 0.93) return 3;
  if (u < 0.97) return 2;
  if (u < 0.99) return 1;
  return 0;
}

// Orthonormal basis (u, v) perpendicular to a unit normal n.
function basisFor(nx, ny, nz) {
  let ux, uy, uz;
  if (Math.abs(ny) < 0.9) { ux = nz; uy = 0; uz = -nx; }       // n × ŷ
  else { ux = 0; uy = -nz; uz = ny; }                          // n × x̂
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  return [ux, uy, uz, vx, vy, vz];
}

function unitNormalFromTilt(tiltRad, azimuthRad) {
  // Disk normal tilted from +Y by tilt, rotated about Y by azimuth.
  const s = Math.sin(tiltRad);
  return [s * Math.cos(azimuthRad), Math.cos(tiltRad), s * Math.sin(azimuthRad)];
}

/* ---------------------------------------------------------------
   Disk galaxy: exponential thin disk + bulge + halo + dust lanes
   + molecular gas along the arms, around a central black hole.
   All velocities from the enclosed-mass rotation curve.
   --------------------------------------------------------------- */
function makeGalaxy(opts) {
  const {
    cx, cy, cz, cvx, cvy, cvz,
    stars, dust, gas, radius, bhMass,
    tiltRad = 0, azimuthRad = 0, spinDir = 1, arms = 2,
  } = opts;
  const bodies = B();
  const [nx, ny, nz] = unitNormalFromTilt(tiltRad, azimuthRad);
  const [ux, uy, uz, vx_, vy_, vz_] = basisFor(nx, ny, nz);

  bodies.add(cx, cy, cz, cvx, cvy, cvz, bhMass, 6, 8, TYPE_BH, null);

  const diskMass = bhMass * 0.6;
  const starMass = diskMass / stars;
  const scale = radius / 3;
  const zScale = radius / 28;            // thin-disk thickness
  const innerR = Math.max(radius * 0.06, 40);

  // Dark-matter halo: cored isothermal sphere giving the flat outer
  // rotation curve real galaxies have. Registered for the engines and
  // folded into the circular velocities below.
  const v02 = 3 * bhMass / radius;
  const rc = radius * 0.2;
  if (globalThis.DarkMatter) {
    globalThis.DarkMatter.list.push({
      x: cx, y: cy, z: cz, v02, rc2: rc * rc, rMax2: (radius * 2) ** 2,
    });
  }
  const haloV2 = (r) => (globalThis.DarkMatter && globalThis.DarkMatter.on)
    ? v02 * r * r / (r * r + rc * rc) : 0;

  const enclosed = (r) => {
    const t = r / scale;
    return bhMass + diskMass * (1 - Math.exp(-t) * (1 + t));
  };

  // color: palette index, -1 = stellar population, -2 = nebula hue (per particle)
  const place = (count, mass, radLo, radHi, color, type, armTight, zMul, rMin) => {
    const lo = Math.max(innerR, rMin || 0);
    for (let i = 0; i < count; i++) {
      let r = -Math.log(1 - _rng()) * scale;
      r = Math.max(lo, Math.min(r, radius));
      const arm = (i % arms) * (2 * Math.PI / arms);
      const theta = arm + (r / radius) * 3.2 * spinDir + gauss() * armTight + _rng() * 0.25;
      const z = gauss() * zScale * zMul;
      const ct = Math.cos(theta), st = Math.sin(theta);
      const x = cx + (ux * ct + vx_ * st) * r + nx * z;
      const y = cy + (uy * ct + vy_ * st) * r + ny * z;
      const zz = cz + (uz * ct + vz_ * st) * r + nz * z;
      const v = Math.sqrt(enclosed(r) / r + haloV2(r));
      const tvx = (-ux * st + vx_ * ct) * spinDir * v;
      const tvy = (-uy * st + vy_ * ct) * spinDir * v;
      const tvz = (-uz * st + vz_ * ct) * spinDir * v;
      const c = color === -1 ? starColor()
              : color === -2 ? (_rng() < 0.5 ? 9 : 10)
              : color;
      bodies.add(x, y, zz, cvx + tvx, cvy + tvy, cvz + tvz,
                 mass, rand(radLo, radHi), c, type, null);
    }
  };

  place(stars, starMass, 0.7, 1.9, -1, TYPE_STAR, 0.50, 1.0);
  // Dust lanes hug the arms more tightly than stars do.
  place(dust, 0.001, 0.3, 0.8, 11, TYPE_DUST, 0.28, 0.7);
  // Molecular gas: soft billboards tracing the arms — kept out of the
  // bright core, where additive overlap would blow out the image.
  place(gas, 0.001, 12, 26, -2, TYPE_GAS, 0.22, 0.6, radius * 0.22);

  // Spherical bulge, dispersion-supported.
  const bulgeN = Math.floor(stars * 0.12);
  for (let i = 0; i < bulgeN; i++) {
    const r = innerR + Math.abs(gauss()) * radius * 0.08;
    const th = _rng() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
    const sx = r * Math.sin(ph) * Math.cos(th), sy = r * Math.cos(ph), sz = r * Math.sin(ph) * Math.sin(th);
    const v = Math.sqrt(enclosed(r) / r + haloV2(r)) * rand(0.5, 0.9);
    const dth = _rng() * 2 * Math.PI, dph = Math.acos(rand(-1, 1));
    bodies.add(cx + sx, cy + sy, cz + sz,
      cvx + v * Math.sin(dph) * Math.cos(dth),
      cvy + v * Math.cos(dph),
      cvz + v * Math.sin(dph) * Math.sin(dth),
      starMass, rand(0.7, 1.6), rand(0, 1) < 0.7 ? 5 : 4, TYPE_STAR, null);
  }

  // Sparse old halo stars on randomly inclined orbits.
  const haloN = Math.floor(stars * 0.06);
  for (let i = 0; i < haloN; i++) {
    const r = rand(radius * 0.4, radius * 1.5);
    const th = _rng() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
    const sx = r * Math.sin(ph) * Math.cos(th), sy = r * Math.cos(ph), sz = r * Math.sin(ph) * Math.sin(th);
    // Tangential direction perpendicular to the radial vector.
    const [tx1, ty1, tz1] = basisFor(sx / r, sy / r, sz / r);
    const v = Math.sqrt(enclosed(r) / r + haloV2(r)) * rand(0.7, 1.0);
    bodies.add(cx + sx, cy + sy, cz + sz,
      cvx + tx1 * v, cvy + ty1 * v, cvz + tz1 * v,
      0.001, rand(0.4, 1.0), 6, TYPE_DUST, null);
  }
}

/* --------------------------------------------------------------- */

const Scenarios = { list: [] };
const DEF_BUDGET = { gpu: false, maxBodies: 1 << 17 };
const def = (key, label, fn) => Scenarios.list.push({
  key, label,
  init(budget = DEF_BUDGET, seed) {
    Scenarios.lastSeed = (seed === undefined ? (Math.random() * 2 ** 31) | 0 : seed) >>> 0;
    _rng = mulberry32(Scenarios.lastSeed);
    if (globalThis.DarkMatter) globalThis.DarkMatter.list.length = 0;
    return fn(budget);
  },
});

def('galaxy', 'SPIRAL GALAXY', (budget = DEF_BUDGET) => {
  Object.assign(P().cfg, { dt: 0.22, substeps: 1, softening: 6, captureRadius: 6, myrPerT: 0.5 });
  const g = budget.gpu;
  const X = g && budget.maxBodies > (1 << 20) ? 4 : 1;   // WebGPU tier
  makeGalaxy({ cx: 0, cy: 0, cz: 0, cvx: 0, cvy: 0, cvz: 0,
    stars: g ? 12000 : 4600, dust: g ? 128000 * X : 9000, gas: g ? 5000 * Math.min(X, 2) : 600,
    radius: 900, bhMass: 40000, tiltRad: 0.0, spinDir: 1 });
  return { camDist: 1500, lightPos: { x: 0, y: 0, z: 0 } };
});

def('collision', 'GALAXY COLLISION', (budget = DEF_BUDGET) => {
  Object.assign(P().cfg, { dt: 0.22, substeps: 1, softening: 6, captureRadius: 6, myrPerT: 0.5 });
  const g = budget.gpu;
  const X = g && budget.maxBodies > (1 << 20) ? 4 : 1;
  const stars = g ? 7000 : 2800, dust = g ? 85000 * X : 5600, gas = g ? 2600 * Math.min(X, 2) : 380;
  makeGalaxy({ cx: -750, cy: -80, cz: -260, cvx: 2.4, cvy: 0.2, cvz: 0.9,
    stars, dust, gas, radius: 600, bhMass: 26000,
    tiltRad: 0.15, azimuthRad: 0.4, spinDir: 1 });
  makeGalaxy({ cx: 750, cy: 80, cz: 260, cvx: -2.4, cvy: -0.2, cvz: -0.9,
    stars, dust, gas, radius: 600, bhMass: 26000,
    tiltRad: 0.65, azimuthRad: 2.1, spinDir: -1 });
  return { camDist: 2300, lightPos: { x: 0, y: 0, z: 0 } };
});

def('solar', 'SOLAR SYSTEM', (budget = DEF_BUDGET) => {
  Object.assign(P().cfg, { dt: 0.05, substeps: 3, softening: 1.5, captureRadius: 4, myrPerT: 0.002 });
  const bodies = B();
  const g = budget.gpu;
  const SUN = 50000;
  // The sun glows (star sprite); planets are lit spheres.
  bodies.add(0, 0, 0, 0, 0, 0, SUN, 11, 7, TYPE_STAR, 'Sol');

  // [name, a, mass, radVis, colorIdx, inclination°]
  // Masses of moon hosts are inflated vs their real Sun-relative values:
  // our compressed visual scale would otherwise put every moon outside
  // its parent's Hill sphere (moons sit at 0.2–0.45 Hill radii here).
  const planets = [
    ['Mercury',  60,   1, 2.0, 5, 7.0],
    ['Venus',    95,   2, 3.2, 4, 3.4],
    ['Earth',   130,  40, 3.4, 2, 0.0],
    ['Mars',    175,   1, 2.6, 6, 1.9],
    ['Jupiter', 380, 100, 7.6, 5, 1.3],
    ['Saturn',  540,  60, 6.8, 4, 2.5],
    ['Uranus',  720,  12, 5.0, 2, 0.8],
    ['Neptune', 880,  14, 5.0, 1, 1.8],
  ];
  const orbit = (a, incDeg, node, anom, speedMul = 1, about = null) => {
    // Position + circular velocity on an inclined orbit. `about` = [x,y,z,vx,vy,vz,M]
    const inc = incDeg * Math.PI / 180;
    const [nx, ny, nz] = unitNormalFromTilt(inc, node);
    const [ux, uy, uz, vx, vy, vz] = basisFor(nx, ny, nz);
    const ct = Math.cos(anom), st = Math.sin(anom);
    const M = about ? about[6] : SUN;
    const v = Math.sqrt(M / a) * speedMul;
    const ox = about ? about[0] : 0, oy = about ? about[1] : 0, oz = about ? about[2] : 0;
    const ovx = about ? about[3] : 0, ovy = about ? about[4] : 0, ovz = about ? about[5] : 0;
    return [
      ox + (ux * ct + vx * st) * a, oy + (uy * ct + vy * st) * a, oz + (uz * ct + vz * st) * a,
      ovx + (-ux * st + vx * ct) * v, ovy + (-uy * st + vy * ct) * v, ovz + (-uz * st + vz * ct) * v,
    ];
  };

  const planetState = {};
  for (const [name, a, m, rv, c, inc] of planets) {
    const s = orbit(a, inc, rand(0, 6.28), rand(0, 6.28));
    bodies.add(s[0], s[1], s[2], s[3], s[4], s[5], m, rv, c, TYPE_PLANET, name);
    planetState[name] = [s[0], s[1], s[2], s[3], s[4], s[5], m];
  }

  // Moons: circular orbits about their host planet, well inside the
  // host's Hill sphere. [name, host, a, mass, radVis, colorIdx, inc°]
  const moons = [
    ['Moon',     'Earth',    3.2, 0.05, 0.9,  3, 5.1],
    ['Io',       'Jupiter',  7.0, 0.06, 0.9,  5, 0.9],
    ['Europa',   'Jupiter',  9.0, 0.05, 0.85, 2, 1.2],
    ['Ganymede', 'Jupiter', 11.5, 0.08, 1.1,  3, 0.7],
    ['Callisto', 'Jupiter', 15.0, 0.07, 1.0,  5, 0.6],
    ['Titan',    'Saturn',  16.0, 0.06, 1.0,  5, 1.6],
  ];
  for (const [name, host, a, m, rv, c, inc] of moons) {
    const s = orbit(a, inc, rand(0, 6.28), rand(0, 6.28), 1, planetState[host]);
    bodies.add(s[0], s[1], s[2], s[3], s[4], s[5], m, rv, c, TYPE_PLANET, name);
  }

  // Saturn's rings: dust on tight circular orbits inside its Hill sphere.
  const X = g && budget.maxBodies > (1 << 20) ? 4 : 1;
  for (let i = 0; i < (g ? 5000 * X : 1400); i++) {
    const rr = rand(8.5, 14);
    const s = orbit(rr, 26.7 + gauss() * 0.4, 1.0, rand(0, 6.28), 1, planetState.Saturn);
    bodies.add(s[0], s[1], s[2], s[3], s[4], s[5], 1e-6, rand(0.25, 0.5), 11, TYPE_DUST, null);
  }

  // Main asteroid belt: low inclination scatter.
  for (let i = 0; i < (g ? 20000 * X : 5000); i++) {
    const a = rand(215, 320);
    const s = orbit(a, Math.abs(gauss()) * 8, rand(0, 6.28), rand(0, 6.28), rand(0.97, 1.03));
    bodies.add(s[0], s[1], s[2], s[3], s[4], s[5], 0.001, rand(0.3, 0.7), 5, TYPE_DUST, null);
  }
  // Kuiper belt + scattered disc.
  for (let i = 0; i < (g ? 15000 * X : 3600); i++) {
    const a = rand(960, 1200);
    const s = orbit(a, Math.abs(gauss()) * 15, rand(0, 6.28), rand(0, 6.28), rand(0.97, 1.03));
    bodies.add(s[0], s[1], s[2], s[3], s[4], s[5], 0.001, rand(0.3, 0.7), 2, TYPE_DUST, null);
  }
  for (let i = 0; i < (g ? 3000 * X : 700); i++) {
    const a = rand(1000, 1500);
    const s = orbit(a, Math.abs(gauss()) * 32, rand(0, 6.28), rand(0, 6.28), rand(0.72, 0.92));
    bodies.add(s[0], s[1], s[2], s[3], s[4], s[5], 0.001, rand(0.3, 0.7), 1, TYPE_DUST, null);
  }
  // A few long-period comets on plunging eccentric orbits.
  for (let i = 0; i < 4; i++) {
    const a = rand(1100, 1400);
    const s = orbit(a, rand(20, 70), rand(0, 6.28), rand(0, 6.28), rand(0.25, 0.4));
    bodies.add(s[0], s[1], s[2], s[3], s[4], s[5], 0.001, 1.4, 3, TYPE_STAR, null);
  }
  return { camDist: 1100, lightPos: { x: 0, y: 0, z: 0 } };
});

def('nebula', 'STELLAR NURSERY', (budget = DEF_BUDGET) => {
  Object.assign(P().cfg, { dt: 0.25, substeps: 1, softening: 8, captureRadius: 6, myrPerT: 0.2 });
  const bodies = B();
  // Gaussian-mixture molecular cloud: dense cores seeded with mass so the
  // gas genuinely collapses onto them — star formation in miniature.
  const g = budget.gpu;
  const X = g && budget.maxBodies > (1 << 20) ? 4 : 1;
  const CLUMPS = 7;
  const cores = [];
  for (let k = 0; k < CLUMPS; k++) {
    const th = _rng() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
    const R = rand(60, 420);
    cores.push({
      x: R * Math.sin(ph) * Math.cos(th),
      y: R * Math.cos(ph) * 0.55,
      z: R * Math.sin(ph) * Math.sin(th),
      s: rand(100, 220),
      m: rand(2200, 5200),
    });
  }
  const totalM = cores.reduce((s, c) => s + c.m, 0);
  for (const c of cores) {
    // Invisible-ish gravitating core, rendered as a tight knot of young stars.
    const nStars = Math.round((60 + c.m / 40) * (g ? 4 : 1));
    for (let i = 0; i < nStars; i++) {
      const r = Math.abs(gauss()) * c.s * 0.25 + 2;
      const th = _rng() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
      const v = Math.sqrt(c.m / Math.max(r, 8)) * rand(0.3, 0.7);
      const dth = _rng() * 2 * Math.PI, dph = Math.acos(rand(-1, 1));
      bodies.add(
        c.x + r * Math.sin(ph) * Math.cos(th), c.y + r * Math.cos(ph), c.z + r * Math.sin(ph) * Math.sin(th),
        v * Math.sin(dph) * Math.cos(dth), v * Math.cos(dph), v * Math.sin(dph) * Math.sin(dth),
        c.m / nStars, rand(0.9, 2.2), _rng() < 0.6 ? 0 : 1, TYPE_STAR, null);
    }
  }
  // The cloud: gas billboards + fine dust falling slowly toward the cores.
  const sample = () => {
    const c = cores[(_rng() * CLUMPS) | 0];
    return [c.x + gauss() * c.s * 2.6, c.y + gauss() * c.s * 1.6, c.z + gauss() * c.s * 2.6];
  };
  for (let i = 0; i < (g ? 9000 * Math.min(X, 2) : 1100); i++) {
    const [x, y, z] = sample();
    const d = Math.hypot(x, y, z) + 1;
    const v = Math.sqrt(totalM / Math.max(d, 200)) * 0.25;
    bodies.add(x, y, z,
      -x / d * v + gauss() * 0.4, -y / d * v + gauss() * 0.4, -z / d * v + gauss() * 0.4,
      0.001, rand(10, 26), _rng() < 0.55 ? 9 : 10, TYPE_GAS, null);
  }
  for (let i = 0; i < (g ? 60000 * X : 9000); i++) {
    const [x, y, z] = sample();
    const d = Math.hypot(x, y, z) + 1;
    const v = Math.sqrt(totalM / Math.max(d, 200)) * 0.3;
    bodies.add(x, y, z,
      -x / d * v + gauss() * 0.5, -y / d * v + gauss() * 0.5, -z / d * v + gauss() * 0.5,
      0.001, rand(0.3, 0.8), 11, TYPE_DUST, null);
  }
  return { camDist: 1400, lightPos: { x: 0, y: 0, z: 0 } };
});

def('cluster', 'GLOBULAR CLUSTER', (budget = DEF_BUDGET) => {
  Object.assign(P().cfg, { dt: 0.25, substeps: 1, softening: 6, captureRadius: 6, myrPerT: 0.5 });
  const bodies = B();
  const g = budget.gpu;
  const X = g && budget.maxBodies > (1 << 20) ? 4 : 1;
  const N = g ? 14000 : 6000, a = 220, starM = 1.5, M = N * starM;
  const put = (count, mass, radLo, radHi, type) => {
    for (let i = 0; i < count; i++) {
      const u = _rng();
      let r = a / Math.sqrt(Math.pow(u, -2 / 3) - 1);
      r = Math.min(r, a * 8);
      const th = _rng() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
      const x = r * Math.sin(ph) * Math.cos(th), y = r * Math.cos(ph), z = r * Math.sin(ph) * Math.sin(th);
      const enc = M * Math.pow(r, 3) / Math.pow(r * r + a * a, 1.5);
      const v = Math.sqrt(Math.max(enc, 0.01) / Math.max(r, 1)) * rand(0.6, 1.05);
      const [tx, ty, tz] = basisFor(x / r, y / r, z / r);
      const sgn = _rng() < 0.5 ? 1 : -1;
      bodies.add(x, y, z,
        tx * v * sgn + gauss() * v * 0.3, ty * v * sgn + gauss() * v * 0.3, tz * v * sgn + gauss() * v * 0.3,
        mass, rand(radLo, radHi), type === TYPE_STAR ? starColor() : 6, type, null);
    }
  };
  put(N, starM, 0.7, 1.9, TYPE_STAR);
  put(g ? 72000 * X : 6000, 0.001, 0.3, 0.7, TYPE_DUST);
  return { camDist: 1100, lightPos: { x: 0, y: 0, z: 0 } };
});

def('bigbang', 'BIG BANG', (budget = DEF_BUDGET) => {
  Object.assign(P().cfg, { dt: 0.3, substeps: 1, softening: 5, captureRadius: 6, myrPerT: 1 });
  const bodies = B();
  // Near-critical 3D Hubble flow; primordial noise seeds filaments.
  const g = budget.gpu;
  const X = g && budget.maxBodies > (1 << 20) ? 4 : 1;
  const H0 = 0.42, R = 60;
  const put = (count, mass, radLo, radHi, type, colorFn) => {
    for (let i = 0; i < count; i++) {
      const r = Math.cbrt(_rng()) * R;
      const th = _rng() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
      const x = r * Math.sin(ph) * Math.cos(th), y = r * Math.cos(ph), z = r * Math.sin(ph) * Math.sin(th);
      bodies.add(x, y, z,
        x * H0 + gauss() * 1.3, y * H0 + gauss() * 1.3, z * H0 + gauss() * 1.3,
        mass, rand(radLo, radHi), colorFn(), type, null);
    }
  };
  put(g ? 12000 : 6500, 2.2, 0.6, 1.6, TYPE_STAR, starColor);
  put(g ? 128000 * X : 11000, 0.001, 0.3, 0.7, TYPE_DUST, () => 11);
  put(g ? 5000 * Math.min(X, 2) : 700, 0.001, 14, 30, TYPE_GAS, () => (_rng() < 0.5 ? 9 : 10));
  return { camDist: 900, lightPos: { x: 0, y: 0, z: 0 } };
});

def('supercluster', 'SUPERCLUSTER', (budget = DEF_BUDGET) => {
  Object.assign(P().cfg, { dt: 0.45, substeps: 1, softening: 12, captureRadius: 8, myrPerT: 2 });
  const g = budget.gpu;
  const R = 4500, H = 0.02;
  // Cosmic web: dwarf galaxies strung along a few filaments, expanding
  // with a mild Hubble flow while gravity pulls neighbors into mergers.
  const FIL = 3 + (_rng() < 0.5 ? 1 : 0);
  const NGAL = g ? 52 : 45;
  // Per-galaxy populations sized to the mode's body budget (makeGalaxy
  // adds ~1.18x stars as massive plus the dust/gas/halo tracers).
  const target = g ? budget.maxBodies * 0.92 : 25000;
  const perGal = Math.floor(target / NGAL);
  const stars = g ? 320 : Math.max(120, Math.floor(perGal * 0.40));
  const dust = g ? Math.max(0, perGal - Math.floor(stars * 1.18) - 9) : Math.floor(perGal * 0.52);
  const gas = g ? 8 : 6;

  const fils = [];
  for (let f = 0; f < FIL; f++) {
    const th = _rng() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
    const dir = [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
    const off = [gauss() * R * 0.25, gauss() * R * 0.25, gauss() * R * 0.25];
    fils.push({ dir, off });
  }
  for (let k = 0; k < NGAL; k++) {
    if (B().n + Math.floor(stars * 1.18) + dust + gas + 1 > budget.maxBodies) break;
    const f = fils[k % FIL];
    const t = (_rng() * 2 - 1) * R;
    const cx = f.off[0] + f.dir[0] * t + gauss() * 380;
    const cy = f.off[1] + f.dir[1] * t + gauss() * 380;
    const cz = f.off[2] + f.dir[2] * t + gauss() * 380;
    makeGalaxy({
      cx, cy, cz,
      cvx: cx * H + gauss() * 1.5, cvy: cy * H + gauss() * 1.5, cvz: cz * H + gauss() * 1.5,
      stars, dust, gas,
      radius: rand(120, 260), bhMass: rand(3000, 9000),
      tiltRad: rand(0, Math.PI), azimuthRad: rand(0, 2 * Math.PI),
      spinDir: _rng() < 0.5 ? 1 : -1,
    });
  }
  return { camDist: 9000, lightPos: { x: 0, y: 0, z: 0 } };
});

def('binary', 'BINARY BLACK HOLES', (budget = DEF_BUDGET) => {
  Object.assign(P().cfg, { dt: 0.22, substeps: 1, softening: 5, captureRadius: 6, myrPerT: 0.5 });
  const g = budget.gpu;
  const X = g && budget.maxBodies > (1 << 20) ? 4 : 1;
  const m = 22000, d = 560;
  const st = g ? 5000 : 2600, du = g ? 50000 * X : 5200, ga = g ? 2000 * Math.min(X, 2) : 300;
  const v = Math.sqrt(1.6 * m / (2 * d));   // each side carries its disk (1.6m total)
  makeGalaxy({ cx: -d / 2, cy: 0, cz: 0, cvx: 0, cvy: v * 0.25, cvz: v,
    stars: st, dust: du, gas: ga, radius: 240, bhMass: m,
    tiltRad: 0.44, azimuthRad: 0.0, spinDir: 1 });
  makeGalaxy({ cx: d / 2, cy: 0, cz: 0, cvx: 0, cvy: -v * 0.25, cvz: -v,
    stars: st, dust: du, gas: ga, radius: 240, bhMass: m,
    tiltRad: -0.70, azimuthRad: 1.2, spinDir: -1 });
  return { camDist: 1500, lightPos: { x: 0, y: 0, z: 0 } };
});

globalThis.Scenarios = Scenarios;
})();
