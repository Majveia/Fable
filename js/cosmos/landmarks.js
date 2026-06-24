'use strict';
/* ============================================================
   FABLE: DRIFTER v7 — Landmarks (js/cosmos/landmarks.js)
   globalThis.Landmarks

   MERGE THE SANDBOXES INTO THE ONE UNIVERSE. The eight old standalone
   scenarios (galaxy/collision/solar/nebula/cluster/bigbang/binary)
   become named LANDMARK nodes you can actually fly to. Each landmark is
   a first-class cosmos node — same interface as a Cosmos node
   ({ id, kind, depth, ac, radius, viewRadius, parent, phase, summary,
   children(), populate(budget, out) }) — so the Navigator treats it like
   any other node: descend into it and its populate() fills the GLOBAL
   Bodies store with that set-piece, in LOCAL coordinates centered at the
   landmark's own origin, by REUSING the very same generators the
   scenarios use (globalThis.Builders.makeGalaxy, etc.).

   DOM-free: attaches to globalThis only; loadable in Node via
   indirect-eval (see test/landmarks.test.js). Determinism is anchored to
   the Cosmos seed exactly like the rest of the cosmos: a landmark's id is
   stable ("u/lm/sol") and its ac is placed deterministically in the
   universe volume from mulberry32(hash(id) ^ seed) — so the same Cosmos
   seed always gives the same landmark acs/ids.

   Map (name -> scenario -> kind matching the scenario scale):
     Sol           -> solar      -> system
     Antennae      -> collision  -> galaxy
     Orion Nursery -> nebula     -> galaxy
     The Maw       -> binary     -> system
     Omega         -> cluster    -> galaxy
     Cosmic Dawn   -> bigbang    -> galaxy
     New Cygnus    -> solar      -> system   (original named system)
     Drifter's End -> binary     -> system   (original named set-piece)
   ============================================================ */
(() => {

const Builders = () => globalThis.Builders;

const TYPE_STAR = 0, TYPE_BH = 1, TYPE_PLANET = 2, TYPE_DUST = 3, TYPE_GAS = 4;

// Universe volume to scatter landmarks across (mirrors cosmos UNIVERSE_RADIUS).
const UNIVERSE_RADIUS = 6000;

// Per-kind framing radii (decoupled DESCEND-capture vs interior view, like
// Cosmos). A landmark sits among the universe's galaxies, so its capture
// radius mirrors a galaxy's; its viewRadius is the populated set-piece extent.
const GALAXY_VIEW = 1500, GALAXY_CAPTURE = 800;
const SYSTEM_VIEW = 1400, SYSTEM_CAPTURE = 200;

/* --------------------------------------------------------------------------
   Same FNV-1a + mulberry32 contract as the cosmos: a landmark's stable id is
   the SOLE layout seed (xor the universe seed). Cosmos exposes hashStringToU32
   and Builders exposes mulberry32, so reuse those to guarantee the landmark
   stream matches the cosmos' determinism model exactly.
   -------------------------------------------------------------------------- */
function hashId(id) {
  if (globalThis.Cosmos && typeof globalThis.Cosmos.hashStringToU32 === 'function') {
    return globalThis.Cosmos.hashStringToU32(id);
  }
  // Fallback FNV-1a (kept in lockstep with cosmos.js) so the module is
  // standalone-testable even if Cosmos didn't export the helper.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Deterministic RNG seeded from id ^ seed (the landmark layout stream).
function lmRng(id, seed) {
  return Builders().mulberry32(hashId(id) ^ (seed >>> 0));
}

/* --------------------------------------------------------------------------
   Deterministic placement in the universe volume. Each landmark gets a point
   sampled uniformly inside a sphere of radius ~UNIVERSE_RADIUS*0.85 from its
   own id-seeded stream, so acs are stable per Cosmos seed and well spread out.
   -------------------------------------------------------------------------- */
function placeAc(id, seed) {
  const r = lmRng(id, seed);
  const rand = (a, b) => a + r() * (b - a);
  // uniform-in-sphere: cube-root radius, random direction.
  const rad = Math.cbrt(r()) * UNIVERSE_RADIUS * 0.85;
  const th = r() * 2 * Math.PI;
  const ph = Math.acos(rand(-1, 1));
  const x = rad * Math.sin(ph) * Math.cos(th);
  const y = rad * Math.cos(ph);
  const z = rad * Math.sin(ph) * Math.sin(th);
  return [x, y, z];
}

/* ==========================================================================
   Scenario builders — each fills `out` (the Bodies store) with the matching
   scenario's bodies in LOCAL coordinates centered at origin, and returns
   { cfg, light }. They are exact restatements of the scenarios.js generators
   (so flying to a landmark loads that set-piece in-world), reusing the SAME
   primitives via globalThis.Builders. The caller has already installed the
   deterministic RNG via Builders.setRng before invoking these.
   ========================================================================== */

// Shared compact inclined-orbit helper (matches the solar/cosmos orbit()).
function orbitFn(B, defaultM) {
  return (a, incDeg, asc, anom, speedMul = 1, about = null) => {
    const inc = incDeg * Math.PI / 180;
    const [nx, ny, nz] = B.unitNormalFromTilt(inc, asc);
    const [ux, uy, uz, vx, vy, vz] = B.basisFor(nx, ny, nz);
    const ct = Math.cos(anom), st = Math.sin(anom);
    const M = about ? about[6] : defaultM;
    const v = Math.sqrt(M / a) * speedMul;
    const ox = about ? about[0] : 0, oy = about ? about[1] : 0, oz = about ? about[2] : 0;
    const ovx = about ? about[3] : 0, ovy = about ? about[4] : 0, ovz = about ? about[5] : 0;
    return [
      ox + (ux * ct + vx * st) * a, oy + (uy * ct + vy * st) * a, oz + (uz * ct + vz * st) * a,
      ovx + (-ux * st + vx * ct) * v, ovy + (-uy * st + vy * ct) * v, ovz + (-uz * st + vz * ct) * v,
    ];
  };
}

// solar — full inner-system set-piece centered at origin (the 'solar' scenario).
function buildSolar(B, budget, out) {
  const rand = B.rand, gauss = B.gauss;
  const g = budget.gpu;
  const SUN = 50000;
  out.add(0, 0, 0, 0, 0, 0, SUN, 11, 7, TYPE_STAR, 'Sol');

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
  const orbit = orbitFn(B, SUN);
  const planetState = {};
  for (const [name, a, m, rv, c, inc] of planets) {
    if (out.n + 1 > budget.maxBodies) break;
    const s = orbit(a, inc, rand(0, 6.28), rand(0, 6.28));
    out.add(s[0], s[1], s[2], s[3], s[4], s[5], m, rv, c, TYPE_PLANET, name);
    planetState[name] = [s[0], s[1], s[2], s[3], s[4], s[5], m];
  }

  const moons = [
    ['Moon',     'Earth',    3.2, 0.05, 0.9,  3, 5.1],
    ['Io',       'Jupiter',  7.0, 0.06, 0.9,  5, 0.9],
    ['Europa',   'Jupiter',  9.0, 0.05, 0.85, 2, 1.2],
    ['Ganymede', 'Jupiter', 11.5, 0.08, 1.1,  3, 0.7],
    ['Callisto', 'Jupiter', 15.0, 0.07, 1.0,  5, 0.6],
    ['Titan',    'Saturn',  16.0, 0.06, 1.0,  5, 1.6],
  ];
  for (const [name, host, a, m, rv, c, inc] of moons) {
    if (!planetState[host]) continue;
    if (out.n + 1 > budget.maxBodies) break;
    const s = orbit(a, inc, rand(0, 6.28), rand(0, 6.28), 1, planetState[host]);
    out.add(s[0], s[1], s[2], s[3], s[4], s[5], m, rv, c, TYPE_PLANET, name);
  }

  const X = g && budget.maxBodies > (1 << 20) ? 4 : 1;
  // Saturn's rings.
  if (planetState.Saturn) {
    for (let i = 0; i < (g ? 5000 * X : 1400); i++) {
      if (out.n + 1 > budget.maxBodies) break;
      const rr = rand(8.5, 14);
      const s = orbit(rr, 26.7 + gauss() * 0.4, 1.0, rand(0, 6.28), 1, planetState.Saturn);
      out.add(s[0], s[1], s[2], s[3], s[4], s[5], 1e-6, rand(0.25, 0.5), 11, TYPE_DUST, null);
    }
  }
  // Main asteroid belt.
  for (let i = 0; i < (g ? 20000 * X : 5000); i++) {
    if (out.n + 1 > budget.maxBodies) break;
    const a = rand(215, 320);
    const s = orbit(a, Math.abs(gauss()) * 8, rand(0, 6.28), rand(0, 6.28), rand(0.97, 1.03));
    out.add(s[0], s[1], s[2], s[3], s[4], s[5], 0.001, rand(0.3, 0.7), 5, TYPE_DUST, null);
  }
  // Kuiper belt + scattered disc.
  for (let i = 0; i < (g ? 15000 * X : 3600); i++) {
    if (out.n + 1 > budget.maxBodies) break;
    const a = rand(960, 1200);
    const s = orbit(a, Math.abs(gauss()) * 15, rand(0, 6.28), rand(0, 6.28), rand(0.97, 1.03));
    out.add(s[0], s[1], s[2], s[3], s[4], s[5], 0.001, rand(0.3, 0.7), 2, TYPE_DUST, null);
  }
  for (let i = 0; i < (g ? 3000 * X : 700); i++) {
    if (out.n + 1 > budget.maxBodies) break;
    const a = rand(1000, 1500);
    const s = orbit(a, Math.abs(gauss()) * 32, rand(0, 6.28), rand(0, 6.28), rand(0.72, 0.92));
    out.add(s[0], s[1], s[2], s[3], s[4], s[5], 0.001, rand(0.3, 0.7), 1, TYPE_DUST, null);
  }
  // A few long-period comets.
  for (let i = 0; i < 4; i++) {
    if (out.n + 1 > budget.maxBodies) break;
    const a = rand(1100, 1400);
    const s = orbit(a, rand(20, 70), rand(0, 6.28), rand(0, 6.28), rand(0.25, 0.4));
    out.add(s[0], s[1], s[2], s[3], s[4], s[5], 0.001, 1.4, 3, TYPE_STAR, null);
  }
  return {
    cfg: { dt: 0.05, substeps: 3, softening: 1.5, captureRadius: 4, myrPerT: 0.002 },
    light: { x: 0, y: 0, z: 0 },
  };
}

// collision — two infalling disk galaxies (the 'collision' scenario).
function buildCollision(B, budget, out) {
  const g = budget.gpu;
  const X = g && budget.maxBodies > (1 << 20) ? 4 : 1;
  const stars = g ? 7000 : 2800, dust = g ? 85000 * X : 5600, gas = g ? 2600 * Math.min(X, 2) : 380;
  B.makeGalaxy({ cx: -750, cy: -80, cz: -260, cvx: 2.4, cvy: 0.2, cvz: 0.9,
    stars, dust, gas, radius: 600, bhMass: 26000,
    tiltRad: 0.15, azimuthRad: 0.4, spinDir: 1 });
  B.makeGalaxy({ cx: 750, cy: 80, cz: 260, cvx: -2.4, cvy: -0.2, cvz: -0.9,
    stars, dust, gas, radius: 600, bhMass: 26000,
    tiltRad: 0.65, azimuthRad: 2.1, spinDir: -1 });
  return {
    cfg: { dt: 0.22, substeps: 1, softening: 6, captureRadius: 6, myrPerT: 0.5 },
    light: { x: 0, y: 0, z: 0 },
  };
}

// nebula — gaussian-mixture molecular cloud collapsing onto cores (the
// 'nebula' / STELLAR NURSERY scenario), centered at origin.
function buildNebula(B, budget, out) {
  const rand = B.rand, gauss = B.gauss;
  const g = budget.gpu;
  const X = g && budget.maxBodies > (1 << 20) ? 4 : 1;
  const _rng = () => rand(0, 1);
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
    const nStars = Math.round((60 + c.m / 40) * (g ? 4 : 1));
    for (let i = 0; i < nStars; i++) {
      if (out.n + 1 > budget.maxBodies) break;
      const r = Math.abs(gauss()) * c.s * 0.25 + 2;
      const th = _rng() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
      const v = Math.sqrt(c.m / Math.max(r, 8)) * rand(0.3, 0.7);
      const dth = _rng() * 2 * Math.PI, dph = Math.acos(rand(-1, 1));
      out.add(
        c.x + r * Math.sin(ph) * Math.cos(th), c.y + r * Math.cos(ph), c.z + r * Math.sin(ph) * Math.sin(th),
        v * Math.sin(dph) * Math.cos(dth), v * Math.cos(dph), v * Math.sin(dph) * Math.sin(dth),
        c.m / nStars, rand(0.9, 2.2), _rng() < 0.6 ? 0 : 1, TYPE_STAR, null);
    }
  }
  const sample = () => {
    const c = cores[(_rng() * CLUMPS) | 0];
    return [c.x + gauss() * c.s * 2.6, c.y + gauss() * c.s * 1.6, c.z + gauss() * c.s * 2.6];
  };
  for (let i = 0; i < (g ? 9000 * Math.min(X, 2) : 1100); i++) {
    if (out.n + 1 > budget.maxBodies) break;
    const [x, y, z] = sample();
    const d = Math.hypot(x, y, z) + 1;
    const v = Math.sqrt(totalM / Math.max(d, 200)) * 0.25;
    out.add(x, y, z,
      -x / d * v + gauss() * 0.4, -y / d * v + gauss() * 0.4, -z / d * v + gauss() * 0.4,
      0.001, rand(10, 26), _rng() < 0.55 ? 9 : 10, TYPE_GAS, null);
  }
  for (let i = 0; i < (g ? 60000 * X : 9000); i++) {
    if (out.n + 1 > budget.maxBodies) break;
    const [x, y, z] = sample();
    const d = Math.hypot(x, y, z) + 1;
    const v = Math.sqrt(totalM / Math.max(d, 200)) * 0.3;
    out.add(x, y, z,
      -x / d * v + gauss() * 0.5, -y / d * v + gauss() * 0.5, -z / d * v + gauss() * 0.5,
      0.001, rand(0.3, 0.8), 11, TYPE_DUST, null);
  }
  return {
    cfg: { dt: 0.25, substeps: 1, softening: 8, captureRadius: 6, myrPerT: 0.2 },
    light: { x: 0, y: 0, z: 0 },
  };
}

// cluster — Plummer-sphere globular cluster (the 'cluster' scenario).
function buildCluster(B, budget, out) {
  const rand = B.rand, gauss = B.gauss;
  const g = budget.gpu;
  const X = g && budget.maxBodies > (1 << 20) ? 4 : 1;
  const _rng = () => rand(0, 1);
  const N = g ? 14000 : 6000, a = 220, starM = 1.5, M = N * starM;
  const put = (count, mass, radLo, radHi, type) => {
    for (let i = 0; i < count; i++) {
      if (out.n + 1 > budget.maxBodies) break;
      const u = _rng();
      let r = a / Math.sqrt(Math.pow(u, -2 / 3) - 1);
      r = Math.min(r, a * 8);
      const th = _rng() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
      const x = r * Math.sin(ph) * Math.cos(th), y = r * Math.cos(ph), z = r * Math.sin(ph) * Math.sin(th);
      const enc = M * Math.pow(r, 3) / Math.pow(r * r + a * a, 1.5);
      const v = Math.sqrt(Math.max(enc, 0.01) / Math.max(r, 1)) * rand(0.6, 1.05);
      const [tx, ty, tz] = B.basisFor(x / r, y / r, z / r);
      const sgn = _rng() < 0.5 ? 1 : -1;
      out.add(x, y, z,
        tx * v * sgn + gauss() * v * 0.3, ty * v * sgn + gauss() * v * 0.3, tz * v * sgn + gauss() * v * 0.3,
        mass, rand(radLo, radHi), type === TYPE_STAR ? B.starColor() : 6, type, null);
    }
  };
  put(N, starM, 0.7, 1.9, TYPE_STAR);
  put(g ? 72000 * X : 6000, 0.001, 0.3, 0.7, TYPE_DUST);
  return {
    cfg: { dt: 0.25, substeps: 1, softening: 6, captureRadius: 6, myrPerT: 0.5 },
    light: { x: 0, y: 0, z: 0 },
  };
}

// bigbang — near-critical 3D Hubble flow (the 'bigbang' scenario).
function buildBigbang(B, budget, out) {
  const rand = B.rand, gauss = B.gauss;
  const g = budget.gpu;
  const X = g && budget.maxBodies > (1 << 20) ? 4 : 1;
  const _rng = () => rand(0, 1);
  const H0 = 0.42, R = 60;
  const put = (count, mass, radLo, radHi, type, colorFn) => {
    for (let i = 0; i < count; i++) {
      if (out.n + 1 > budget.maxBodies) break;
      const r = Math.cbrt(_rng()) * R;
      const th = _rng() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
      const x = r * Math.sin(ph) * Math.cos(th), y = r * Math.cos(ph), z = r * Math.sin(ph) * Math.sin(th);
      out.add(x, y, z,
        x * H0 + gauss() * 1.3, y * H0 + gauss() * 1.3, z * H0 + gauss() * 1.3,
        mass, rand(radLo, radHi), colorFn(), type, null);
    }
  };
  put(g ? 12000 : 6500, 2.2, 0.6, 1.6, TYPE_STAR, B.starColor);
  put(g ? 128000 * X : 11000, 0.001, 0.3, 0.7, TYPE_DUST, () => 11);
  put(g ? 5000 * Math.min(X, 2) : 700, 0.001, 14, 30, TYPE_GAS, () => (_rng() < 0.5 ? 9 : 10));
  return {
    cfg: { dt: 0.3, substeps: 1, softening: 5, captureRadius: 6, myrPerT: 1 },
    light: { x: 0, y: 0, z: 0 },
  };
}

// binary — two inspiralling black-hole disks (the 'binary' scenario).
function buildBinary(B, budget, out) {
  const g = budget.gpu;
  const X = g && budget.maxBodies > (1 << 20) ? 4 : 1;
  const m = 22000, d = 560;
  const st = g ? 5000 : 2600, du = g ? 50000 * X : 5200, ga = g ? 2000 * Math.min(X, 2) : 300;
  const v = Math.sqrt(1.6 * m / (2 * d));
  B.makeGalaxy({ cx: -d / 2, cy: 0, cz: 0, cvx: 0, cvy: v * 0.25, cvz: v,
    stars: st, dust: du, gas: ga, radius: 240, bhMass: m,
    tiltRad: 0.44, azimuthRad: 0.0, spinDir: 1 });
  B.makeGalaxy({ cx: d / 2, cy: 0, cz: 0, cvx: 0, cvy: -v * 0.25, cvz: -v,
    stars: st, dust: du, gas: ga, radius: 240, bhMass: m,
    tiltRad: -0.70, azimuthRad: 1.2, spinDir: -1 });
  return {
    cfg: { dt: 0.22, substeps: 1, softening: 5, captureRadius: 6, myrPerT: 0.5 },
    light: { x: 0, y: 0, z: 0 },
  };
}

const BUILDERS = {
  solar: buildSolar,
  collision: buildCollision,
  nebula: buildNebula,
  cluster: buildCluster,
  bigbang: buildBigbang,
  binary: buildBinary,
};

/* ==========================================================================
   The landmark registry. Each entry maps a name to a scenario + the cosmos
   KIND matching that scenario's scale (system for solar/binary set-pieces,
   galaxy for the collision/nebula/cluster/bigbang large-scale set-pieces).
   `slug` makes the stable id "u/lm/<slug>". `summary` mirrors a cosmos node
   summary (colorIdx/brightness/kind) so HUD/Navigator context works.
   ========================================================================== */
const REGISTRY = [
  { slug: 'sol',      name: 'Sol',            scenario: 'solar',     kind: 'system', colorIdx: 7, brightness: 1.0 },
  { slug: 'antennae', name: 'Antennae',       scenario: 'collision', kind: 'galaxy', colorIdx: 5, brightness: 1.0 },
  { slug: 'orion',    name: 'Orion Nursery',  scenario: 'nebula',    kind: 'galaxy', colorIdx: 9, brightness: 0.9 },
  { slug: 'maw',      name: 'The Maw',        scenario: 'binary',    kind: 'system', colorIdx: 8, brightness: 0.8 },
  { slug: 'omega',    name: 'Omega',          scenario: 'cluster',   kind: 'galaxy', colorIdx: 6, brightness: 0.95 },
  { slug: 'dawn',     name: 'Cosmic Dawn',    scenario: 'bigbang',   kind: 'galaxy', colorIdx: 9, brightness: 1.0 },
  // Original named set-pieces — a second inhabited system and a noir badlands.
  { slug: 'cygnus',   name: 'New Cygnus',     scenario: 'solar',     kind: 'system', colorIdx: 4, brightness: 0.9 },
  { slug: 'end',      name: "Drifter's End",  scenario: 'binary',    kind: 'system', colorIdx: 8, brightness: 0.7 },
];

// Noir one-liners surfaced by HUD/codex when you reach a landmark.
const SUMMARIES = {
  sol:      'Sol — the old home system. Eight planets, one tired sun, a belt full of forgotten claims.',
  antennae: 'The Antennae — two galaxies caught mid-collision, tidal tails flung across the dark.',
  orion:    'Orion Nursery — a molecular cloud lit from within; stars igniting where the gas falls.',
  maw:      'The Maw — twin black holes locked in a death spiral. Nothing escapes its bookkeeping.',
  omega:    'Omega — a globular cluster, a million ancient suns packed tight enough to read by.',
  dawn:     'Cosmic Dawn — the first light, still expanding. You are looking at the beginning.',
  cygnus:   'New Cygnus — a frontier system, freshly surveyed, registry still drying. Bring a thermos.',
  end:      "Drifter's End — where two singularities grind the void to gravel. Last stop, every map.",
};

/* The node prototype: same surface a Cosmos node exposes. children() is empty
   for set-pieces (the scenario IS the live population) and returns the solar
   "planets" as leaf cosmos-like nodes for the solar/system landmarks so the
   solar landmark is descendable like any system (planets are reachable). */
const LandmarkProto = {
  children() {
    if (this._children) return this._children;
    this._children = (typeof this._genChildren === 'function') ? this._genChildren(this) : [];
    return this._children;
  },
  populate(budget, out) {
    const B = Builders();
    // Deterministic, anchored to id ^ seed exactly like a cosmos node.
    B.setRng(lmRng(this.id, this._seed));
    if (globalThis.DarkMatter) globalThis.DarkMatter.list.length = 0;
    const res = this._build(B, budget, out);
    B.resetRng();
    return res;
  },
};

function makeLandmark(entry, seed) {
  const id = 'u/lm/' + entry.slug;
  const ac = placeAc(id, seed);
  const isSystem = entry.kind === 'system';
  const n = Object.create(LandmarkProto);
  n.id = id;
  n.kind = entry.kind;                 // 'system' | 'galaxy' (matches scenario scale)
  n.depth = 1;                         // landmarks hang directly off the universe root
  n.ac = ac;                           // deterministic placement in the universe volume
  n.radius = isSystem ? SYSTEM_CAPTURE : GALAXY_CAPTURE;
  n.viewRadius = isSystem ? SYSTEM_VIEW : GALAXY_VIEW;
  n.parent = null;                     // set by inject() to the cosmos root
  n.phase = 0;
  n.summary = { colorIdx: entry.colorIdx, brightness: entry.brightness, kind: entry.kind };
  n.landmark = true;                   // flag so consumers can recognize a set-piece
  n.name = entry.name;
  n.scenario = entry.scenario;
  n.summaryText = SUMMARIES[entry.slug] || entry.name;
  n._seed = seed >>> 0;
  n._children = null;
  n._build = BUILDERS[entry.scenario];
  // Solar/system landmarks expose their planets as reachable leaf nodes so the
  // landmark is descendable like a real system; galaxy set-pieces are leaves.
  n._genChildren = (entry.scenario === 'solar') ? genSolarPlanets : null;
  return n;
}

// Reachable leaf "planet" nodes for a solar landmark. Positions mirror where
// buildSolar places the 8 planets (same a/inc table, same id-seeded stream),
// so the dot you fly toward is the planet you saw. Leaves (no populate of their
// own bodies needed for the set-piece; they are markers in the system view).
const SOLAR_PLANETS = [
  ['Mercury',  60,  7.0], ['Venus',   95, 3.4], ['Earth', 130, 0.0], ['Mars',    175, 1.9],
  ['Jupiter', 380, 1.3], ['Saturn', 540, 2.5], ['Uranus', 720, 0.8], ['Neptune', 880, 1.8],
];
function genSolarPlanets(sys) {
  const B = Builders();
  const r = lmRng(sys.id, sys._seed);
  const rand = (a, b) => a + r() * (b - a);
  const kids = [];
  for (let k = 0; k < SOLAR_PLANETS.length; k++) {
    const [name, a, incDeg] = SOLAR_PLANETS[k];
    const inc = incDeg * Math.PI / 180;
    const asc = rand(0, 6.28), anom = rand(0, 6.28);
    const [nx, ny, nz] = B.unitNormalFromTilt(inc, asc);
    const [ux, uy, uz, vx, vy, vz] = B.basisFor(nx, ny, nz);
    const ct = Math.cos(anom), st = Math.sin(anom);
    const lx = (ux * ct + vx * st) * a, ly = (uy * ct + vy * st) * a, lz = (uz * ct + vz * st) * a;
    const child = Object.create(LandmarkProto);
    child.id = sys.id + '/p' + k;
    child.kind = 'planet';
    child.depth = 2;
    child.ac = [sys.ac[0] + lx, sys.ac[1] + ly, sys.ac[2] + lz];
    child.radius = 60;
    child.viewRadius = 40;
    child.parent = sys;
    child.phase = 0;
    child.summary = { colorIdx: 1 + (k % 6), brightness: 0.6, kind: 'planet' };
    child.name = name;
    child._seed = sys._seed;
    child._children = null;
    child._genChildren = null;
    // A planet leaf populates a lone lit planet sphere at local origin.
    child._build = (B2, budget, out) => {
      out.add(0, 0, 0, 0, 0, 0, 60, 3.4, child.summary.colorIdx, TYPE_PLANET, 'Planet');
      return { cfg: { dt: 0.02, substeps: 3, softening: 0.6, captureRadius: 2, myrPerT: 0.0005 },
               light: { x: 0, y: 0, z: 0 } };
    };
    kids.push(child);
  }
  return kids;
}

/* ==========================================================================
   Public API.
   ========================================================================== */
const Landmarks = {
  // exposed for tests/tools
  REGISTRY,
  placeAc,

  // The live array of injected landmark nodes for the current cosmos.
  nodes: [],

  /* Inject named landmark nodes into the cosmos so they are discoverable in
     the hierarchy. Builds a landmark node per REGISTRY entry, anchors each to
     the cosmos root (parent + appended to root.children()), and returns the
     nodes. Idempotent for a given root: re-injecting clears prior landmarks
     first (so a second inject() does not duplicate them). Determinism: the
     same Cosmos seed yields identical landmark ids and acs. */
  inject(Cosmos) {
    const root = (Cosmos && Cosmos.root) ? Cosmos.root : (Cosmos && Cosmos.children ? Cosmos : null);
    if (!root) throw new Error('Landmarks.inject: expected Cosmos with a root');
    const seed = (Cosmos.seed !== undefined ? Cosmos.seed : 0) >>> 0;

    const lms = REGISTRY.map((e) => {
      const n = makeLandmark(e, seed);
      n.parent = root;
      return n;
    });
    this.nodes = lms;

    // Force the root's lazy children to generate, then append landmarks once.
    // We strip any previously-injected landmarks so inject() is idempotent.
    const kids = (typeof root.children === 'function') ? root.children() : root._children;
    if (Array.isArray(kids)) {
      for (let i = kids.length - 1; i >= 0; i--) {
        if (kids[i] && kids[i].landmark) kids.splice(i, 1);
      }
      for (const n of lms) kids.push(n);
    }
    return lms;
  },

  /* A flat directory of the landmarks for menus / set-course UI. */
  list() {
    return this.nodes.map((n) => ({
      id: n.id, name: n.name, kind: n.kind, ac: n.ac.slice(), scenario: n.scenario,
    }));
  },

  /* Look a landmark node up by id (e.g. "u/lm/sol"). */
  byId(id) {
    return this.nodes.find((n) => n.id === id) || null;
  },
};

globalThis.Landmarks = Landmarks;
})();
