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

const rand = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() + Math.random() - 2) / 2;

// Cool dwarfs dominate real stellar populations.
function starColor() {
  const u = Math.random();
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

  const enclosed = (r) => {
    const t = r / scale;
    return bhMass + diskMass * (1 - Math.exp(-t) * (1 + t));
  };

  // color: palette index, -1 = stellar population, -2 = nebula hue (per particle)
  const place = (count, mass, radLo, radHi, color, type, armTight, zMul, rMin) => {
    const lo = Math.max(innerR, rMin || 0);
    for (let i = 0; i < count; i++) {
      let r = -Math.log(1 - Math.random()) * scale;
      r = Math.max(lo, Math.min(r, radius));
      const arm = (i % arms) * (2 * Math.PI / arms);
      const theta = arm + (r / radius) * 3.2 * spinDir + gauss() * armTight + Math.random() * 0.25;
      const z = gauss() * zScale * zMul;
      const ct = Math.cos(theta), st = Math.sin(theta);
      const x = cx + (ux * ct + vx_ * st) * r + nx * z;
      const y = cy + (uy * ct + vy_ * st) * r + ny * z;
      const zz = cz + (uz * ct + vz_ * st) * r + nz * z;
      const v = Math.sqrt(enclosed(r) / r);
      const tvx = (-ux * st + vx_ * ct) * spinDir * v;
      const tvy = (-uy * st + vy_ * ct) * spinDir * v;
      const tvz = (-uz * st + vz_ * ct) * spinDir * v;
      const c = color === -1 ? starColor()
              : color === -2 ? (Math.random() < 0.5 ? 9 : 10)
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
    const th = Math.random() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
    const sx = r * Math.sin(ph) * Math.cos(th), sy = r * Math.cos(ph), sz = r * Math.sin(ph) * Math.sin(th);
    const v = Math.sqrt(enclosed(r) / r) * rand(0.5, 0.9);
    const dth = Math.random() * 2 * Math.PI, dph = Math.acos(rand(-1, 1));
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
    const th = Math.random() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
    const sx = r * Math.sin(ph) * Math.cos(th), sy = r * Math.cos(ph), sz = r * Math.sin(ph) * Math.sin(th);
    // Tangential direction perpendicular to the radial vector.
    const [tx1, ty1, tz1] = basisFor(sx / r, sy / r, sz / r);
    const v = Math.sqrt(enclosed(r) / r) * rand(0.7, 1.0);
    bodies.add(cx + sx, cy + sy, cz + sz,
      cvx + tx1 * v, cvy + ty1 * v, cvz + tz1 * v,
      0.001, rand(0.4, 1.0), 6, TYPE_DUST, null);
  }
}

/* --------------------------------------------------------------- */

const Scenarios = { list: [] };
const def = (key, label, init) => Scenarios.list.push({ key, label, init });

def('galaxy', 'SPIRAL GALAXY', () => {
  Object.assign(P().cfg, { dt: 0.22, substeps: 1, softening: 6, captureRadius: 6, myrPerT: 0.5 });
  makeGalaxy({ cx: 0, cy: 0, cz: 0, cvx: 0, cvy: 0, cvz: 0,
    stars: 4600, dust: 9000, gas: 600, radius: 900, bhMass: 40000,
    tiltRad: 0.0, spinDir: 1 });
  return { camDist: 1500, lightPos: { x: 0, y: 0, z: 0 } };
});

def('collision', 'GALAXY COLLISION', () => {
  Object.assign(P().cfg, { dt: 0.22, substeps: 1, softening: 6, captureRadius: 6, myrPerT: 0.5 });
  makeGalaxy({ cx: -750, cy: -80, cz: -260, cvx: 2.4, cvy: 0.2, cvz: 0.9,
    stars: 2800, dust: 5600, gas: 380, radius: 600, bhMass: 26000,
    tiltRad: 0.15, azimuthRad: 0.4, spinDir: 1 });
  makeGalaxy({ cx: 750, cy: 80, cz: 260, cvx: -2.4, cvy: -0.2, cvz: -0.9,
    stars: 2800, dust: 5600, gas: 380, radius: 600, bhMass: 26000,
    tiltRad: 0.65, azimuthRad: 2.1, spinDir: -1 });
  return { camDist: 2300, lightPos: { x: 0, y: 0, z: 0 } };
});

def('solar', 'SOLAR SYSTEM', () => {
  Object.assign(P().cfg, { dt: 0.05, substeps: 3, softening: 1.5, captureRadius: 4, myrPerT: 0.002 });
  const bodies = B();
  const SUN = 50000;
  // The sun glows (star sprite); planets are lit spheres.
  bodies.add(0, 0, 0, 0, 0, 0, SUN, 11, 7, TYPE_STAR, 'Sol');

  // [name, a, mass, radVis, colorIdx, inclination°]
  const planets = [
    ['Mercury',  60,  1, 2.0, 5, 7.0],
    ['Venus',    95,  2, 3.2, 4, 3.4],
    ['Earth',   130,  3, 3.4, 2, 0.0],
    ['Mars',    175,  1, 2.6, 6, 1.9],
    ['Jupiter', 380, 60, 7.6, 5, 1.3],
    ['Saturn',  540, 35, 6.8, 4, 2.5],
    ['Uranus',  720, 12, 5.0, 2, 0.8],
    ['Neptune', 880, 14, 5.0, 1, 1.8],
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

  let saturnState = null;
  for (const [name, a, m, rv, c, inc] of planets) {
    const s = orbit(a, inc, rand(0, 6.28), rand(0, 6.28));
    bodies.add(s[0], s[1], s[2], s[3], s[4], s[5], m, rv, c, TYPE_PLANET, name);
    if (name === 'Saturn') saturnState = [s[0], s[1], s[2], s[3], s[4], s[5], m];
  }

  // Saturn's rings: dust on tight circular orbits inside its Hill sphere.
  for (let i = 0; i < 1400; i++) {
    const rr = rand(8.5, 14);
    const s = orbit(rr, 26.7 + gauss() * 0.4, 1.0, rand(0, 6.28), 1, saturnState);
    bodies.add(s[0], s[1], s[2], s[3], s[4], s[5], 1e-6, rand(0.25, 0.5), 11, TYPE_DUST, null);
  }

  // Main asteroid belt: low inclination scatter.
  for (let i = 0; i < 5000; i++) {
    const a = rand(215, 320);
    const s = orbit(a, Math.abs(gauss()) * 8, rand(0, 6.28), rand(0, 6.28), rand(0.97, 1.03));
    bodies.add(s[0], s[1], s[2], s[3], s[4], s[5], 0.001, rand(0.3, 0.7), 5, TYPE_DUST, null);
  }
  // Kuiper belt + scattered disc.
  for (let i = 0; i < 3600; i++) {
    const a = rand(960, 1200);
    const s = orbit(a, Math.abs(gauss()) * 15, rand(0, 6.28), rand(0, 6.28), rand(0.97, 1.03));
    bodies.add(s[0], s[1], s[2], s[3], s[4], s[5], 0.001, rand(0.3, 0.7), 2, TYPE_DUST, null);
  }
  for (let i = 0; i < 700; i++) {
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

def('nebula', 'STELLAR NURSERY', () => {
  Object.assign(P().cfg, { dt: 0.25, substeps: 1, softening: 8, captureRadius: 6, myrPerT: 0.2 });
  const bodies = B();
  // Gaussian-mixture molecular cloud: dense cores seeded with mass so the
  // gas genuinely collapses onto them — star formation in miniature.
  const CLUMPS = 7;
  const cores = [];
  for (let k = 0; k < CLUMPS; k++) {
    const th = Math.random() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
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
    const nStars = Math.round(60 + c.m / 40);
    for (let i = 0; i < nStars; i++) {
      const r = Math.abs(gauss()) * c.s * 0.25 + 2;
      const th = Math.random() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
      const v = Math.sqrt(c.m / Math.max(r, 8)) * rand(0.3, 0.7);
      const dth = Math.random() * 2 * Math.PI, dph = Math.acos(rand(-1, 1));
      bodies.add(
        c.x + r * Math.sin(ph) * Math.cos(th), c.y + r * Math.cos(ph), c.z + r * Math.sin(ph) * Math.sin(th),
        v * Math.sin(dph) * Math.cos(dth), v * Math.cos(dph), v * Math.sin(dph) * Math.sin(dth),
        c.m / nStars, rand(0.9, 2.2), Math.random() < 0.6 ? 0 : 1, TYPE_STAR, null);
    }
  }
  // The cloud: gas billboards + fine dust falling slowly toward the cores.
  const sample = () => {
    const c = cores[(Math.random() * CLUMPS) | 0];
    return [c.x + gauss() * c.s * 2.6, c.y + gauss() * c.s * 1.6, c.z + gauss() * c.s * 2.6];
  };
  for (let i = 0; i < 1100; i++) {
    const [x, y, z] = sample();
    const d = Math.hypot(x, y, z) + 1;
    const v = Math.sqrt(totalM / Math.max(d, 200)) * 0.25;
    bodies.add(x, y, z,
      -x / d * v + gauss() * 0.4, -y / d * v + gauss() * 0.4, -z / d * v + gauss() * 0.4,
      0.001, rand(10, 26), Math.random() < 0.55 ? 9 : 10, TYPE_GAS, null);
  }
  for (let i = 0; i < 9000; i++) {
    const [x, y, z] = sample();
    const d = Math.hypot(x, y, z) + 1;
    const v = Math.sqrt(totalM / Math.max(d, 200)) * 0.3;
    bodies.add(x, y, z,
      -x / d * v + gauss() * 0.5, -y / d * v + gauss() * 0.5, -z / d * v + gauss() * 0.5,
      0.001, rand(0.3, 0.8), 11, TYPE_DUST, null);
  }
  return { camDist: 1400, lightPos: { x: 0, y: 0, z: 0 } };
});

def('cluster', 'GLOBULAR CLUSTER', () => {
  Object.assign(P().cfg, { dt: 0.25, substeps: 1, softening: 6, captureRadius: 6, myrPerT: 0.5 });
  const bodies = B();
  const N = 6000, a = 220, starM = 1.5, M = N * starM;
  const put = (count, mass, radLo, radHi, type) => {
    for (let i = 0; i < count; i++) {
      const u = Math.random();
      let r = a / Math.sqrt(Math.pow(u, -2 / 3) - 1);
      r = Math.min(r, a * 8);
      const th = Math.random() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
      const x = r * Math.sin(ph) * Math.cos(th), y = r * Math.cos(ph), z = r * Math.sin(ph) * Math.sin(th);
      const enc = M * Math.pow(r, 3) / Math.pow(r * r + a * a, 1.5);
      const v = Math.sqrt(Math.max(enc, 0.01) / Math.max(r, 1)) * rand(0.6, 1.05);
      const [tx, ty, tz] = basisFor(x / r, y / r, z / r);
      const sgn = Math.random() < 0.5 ? 1 : -1;
      bodies.add(x, y, z,
        tx * v * sgn + gauss() * v * 0.3, ty * v * sgn + gauss() * v * 0.3, tz * v * sgn + gauss() * v * 0.3,
        mass, rand(radLo, radHi), type === TYPE_STAR ? starColor() : 6, type, null);
    }
  };
  put(N, starM, 0.7, 1.9, TYPE_STAR);
  put(6000, 0.001, 0.3, 0.7, TYPE_DUST);
  return { camDist: 1100, lightPos: { x: 0, y: 0, z: 0 } };
});

def('bigbang', 'BIG BANG', () => {
  Object.assign(P().cfg, { dt: 0.3, substeps: 1, softening: 5, captureRadius: 6, myrPerT: 1 });
  const bodies = B();
  // Near-critical 3D Hubble flow; primordial noise seeds filaments.
  const H0 = 0.42, R = 60;
  const put = (count, mass, radLo, radHi, type, colorFn) => {
    for (let i = 0; i < count; i++) {
      const r = Math.cbrt(Math.random()) * R;
      const th = Math.random() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
      const x = r * Math.sin(ph) * Math.cos(th), y = r * Math.cos(ph), z = r * Math.sin(ph) * Math.sin(th);
      bodies.add(x, y, z,
        x * H0 + gauss() * 1.3, y * H0 + gauss() * 1.3, z * H0 + gauss() * 1.3,
        mass, rand(radLo, radHi), colorFn(), type, null);
    }
  };
  put(6500, 2.2, 0.6, 1.6, TYPE_STAR, starColor);
  put(11000, 0.001, 0.3, 0.7, TYPE_DUST, () => 11);
  put(700, 0.001, 14, 30, TYPE_GAS, () => (Math.random() < 0.5 ? 9 : 10));
  return { camDist: 900, lightPos: { x: 0, y: 0, z: 0 } };
});

def('binary', 'BINARY BLACK HOLES', () => {
  Object.assign(P().cfg, { dt: 0.22, substeps: 1, softening: 5, captureRadius: 6, myrPerT: 0.5 });
  const m = 22000, d = 560;
  const v = Math.sqrt(1.6 * m / (2 * d));   // each side carries its disk (1.6m total)
  makeGalaxy({ cx: -d / 2, cy: 0, cz: 0, cvx: 0, cvy: v * 0.25, cvz: v,
    stars: 2600, dust: 5200, gas: 300, radius: 240, bhMass: m,
    tiltRad: 0.44, azimuthRad: 0.0, spinDir: 1 });
  makeGalaxy({ cx: d / 2, cy: 0, cz: 0, cvx: 0, cvy: -v * 0.25, cvz: -v,
    stars: 2600, dust: 5200, gas: 300, radius: 240, bhMass: m,
    tiltRad: -0.70, azimuthRad: 1.2, spinDir: -1 });
  return { camDist: 1500, lightPos: { x: 0, y: 0, z: 0 } };
});

globalThis.Scenarios = Scenarios;
})();
