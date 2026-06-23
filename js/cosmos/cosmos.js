'use strict';
/* ============================================================
   FABLE UNIVERSE v6 — Cosmos (js/cosmos/cosmos.js)  owner: Agent A
   Deterministic, lazy procedural hierarchy from one seed, plus
   analytic aging. DOM-free: attaches to globalThis only and is
   Node-testable. See docs/ARCHITECTURE-PERSISTENT.md — the binding
   v6 contract, section "Cosmos".

   ONE seed -> a whole universe. Nodes are generated lazily on first
   children() access and cached (stable identity). Each node's id is a
   stable path string ("u", "u/g7", "u/g7/s3", "u/g7/s3/p2") and is the
   sole RNG seed source: node RNG = mulberry32(hash(id) ^ seed). So the
   tree is reproducible across runs, reloads and machines.

   populate(budget, out) fills the GLOBAL Bodies store with a node's full
   LIVE population in LOCAL coordinates (relative to node.ac) by REUSING
   the scenario generators (globalThis.Builders). Only ever ONE node is
   live at a time (the caller clears Bodies; we do not).

   ageTo(myr) advances every cached node's analytic `phase` (galaxies
   slow, planets fast — Keplerian-ish). It allocates no bodies and is
   idempotent: phase is always recomputed from the absolute clock, never
   integrated, so ageTo(t) twice == ageTo(t) once.
   ============================================================ */
(() => {

const Builders = () => globalThis.Builders;
const Physics = () => globalThis.Physics;

const KIND_UNIVERSE = 'universe', KIND_GALAXY = 'galaxy',
      KIND_SYSTEM = 'system', KIND_PLANET = 'planet';

// ---- fan-out (tuned per contract; visitable counts kept modest) ----
const N_GALAXIES = 50;     // universe -> ~50 galaxies along 3-4 filaments
const N_SYSTEMS  = 12;     // galaxy   -> ~12 visitable systems
// system -> star + [2..8] planets; planet -> [0..4] moons (bodies, not nodes)
const PLANETS_MIN = 2, PLANETS_MAX = 8;
const MOONS_MIN = 0, MOONS_MAX = 4;

// ---- spatial scales (absolute, universe frame; same units throughout) ----
const UNIVERSE_RADIUS = 6000;   // ~6000-radius cosmic-web volume
const N_FILAMENTS_MIN = 3;      // 3-4 filaments through the volume
const GALAXY_RADIUS_MIN = 120, GALAXY_RADIUS_MAX = 260; // mirrors supercluster
const SYSTEM_RADIUS = 1.6;      // a system's spatial extent (orbital reach)
const PLANET_RADIUS = 0.08;     // a planet's spatial extent (moon reach)

/* ---------------------------------------------------------------
   FNV-1a 32-bit string hash. Deterministic, fast, well-mixed —
   used to turn a node's stable path id into an RNG seed.
   --------------------------------------------------------------- */
function hashStringToU32(s) {
  let h = 0x811c9dc5;                 // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);     // FNV prime, 32-bit wrap via imul
  }
  return h >>> 0;
}

/* ---------------------------------------------------------------
   Angular rate (radians per Myr) for analytic aging. Keplerian-ish:
   bigger / heavier structures turn slower. We key off the node's
   spatial scale so the ordering is galaxies << systems << planets
   (a galaxy makes a faint fraction of a turn while a planet spins
   many times over the same Myr). Pure constants, documented here:

     rate = BASE[kind] / sqrt(radius)

   The 1/sqrt(radius) is the Keplerian flavour (Omega ~ r^-3/2 for a
   point mass; we soften to r^-1/2 so even galaxies visibly drift over
   the 100s-of-Myr the universe ages while you are away). BASE is the
   per-kind tuning so the families are well separated.
   --------------------------------------------------------------- */
const RATE_BASE = {
  [KIND_UNIVERSE]: 0,        // the web itself does not "rotate"
  [KIND_GALAXY]:   0.02,     // ~0.02/sqrt(200) ~ 1.4e-3 rad/Myr (slow)
  [KIND_SYSTEM]:   2.0,      // ~2.0/sqrt(1.6)  ~ 1.6 rad/Myr
  [KIND_PLANET]:   8.0,      // ~8.0/sqrt(0.08) ~ 28 rad/Myr (fast)
};
function angularRate(node) {
  const base = RATE_BASE[node.kind] || 0;
  return base / Math.sqrt(Math.max(node.radius, 1e-3));
}

/* ---------------------------------------------------------------
   Node prototype. Nodes are plain objects with these methods on the
   prototype; the per-node state (id, ac, radius, phase, _children…)
   lives on the instance.
   --------------------------------------------------------------- */
const NodeProto = {
  // Deterministic RNG for THIS node: seeded only from the node id and
  // the universe seed. Same id + seed -> same stream, always.
  rng() {
    return Builders().mulberry32(hashStringToU32(this.id) ^ (this._seed >>> 0));
  },

  // Lazy + cached + stable-identity children. First call generates and
  // caches the array; later calls return the SAME array (same node
  // objects, same ids/ac/radii). depth caps at 3 (planet has none).
  children() {
    if (this._children) return this._children;
    let kids;
    switch (this.kind) {
      case KIND_UNIVERSE: kids = genGalaxies(this); break;
      case KIND_GALAXY:   kids = genSystems(this);  break;
      case KIND_SYSTEM:   kids = genPlanets(this);  break;
      default:            kids = [];                 break; // planet: leaf
    }
    this._children = kids;
    return kids;
  },

  // Fill the GLOBAL Bodies store with this node's full live population in
  // LOCAL coordinates (relative to this.ac) and return Physics.cfg
  // overrides + light position. The caller clears Bodies; we never do.
  // Populations scale to `budget` (gpu/maxBodies) exactly as the
  // scenarios do. node.phase offsets the initial azimuth of every disk /
  // orbit population so re-entry after aging is continuous.
  populate(budget, out) {
    return populateNode(this, budget, out);
  },
};

function makeNode(id, kind, depth, ac, radius, parent, summary, seed) {
  const n = Object.create(NodeProto);
  n.id = id;
  n.kind = kind;
  n.depth = depth;
  n.ac = ac;                 // [x,y,z] absolute float64 center
  n.radius = radius;
  n.parent = parent;
  n.phase = 0;               // analytic state at Cosmos.clockMyr (set by ageTo)
  n.summary = summary;       // { colorIdx, brightness, kind }
  n._seed = seed >>> 0;      // the universe seed (shared by every node)
  n._children = null;        // lazy cache
  n._baseline = 0;           // phase baseline captured at create (per node)
  return n;
}

/* =====================  hierarchy generators  ===================== */

// universe -> ~50 galaxies, centers strung along 3-4 filaments through a
// ~6000-radius volume. Mirrors the supercluster filament sampling in
// scenarios.js (random filament direction + offset, sample t along it,
// gaussian scatter off the line).
function genGalaxies(root) {
  const B = Builders();
  const r = root.rng();
  const rand = (a, b) => a + r() * (b - a);
  const gauss = () => (r() + r() + r() + r() - 2) / 2;
  const R = UNIVERSE_RADIUS;

  const FIL = N_FILAMENTS_MIN + (r() < 0.5 ? 1 : 0);   // 3 or 4 filaments
  const fils = [];
  for (let f = 0; f < FIL; f++) {
    const th = r() * 2 * Math.PI, ph = Math.acos(rand(-1, 1));
    const dir = [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
    const off = [gauss() * R * 0.25, gauss() * R * 0.25, gauss() * R * 0.25];
    fils.push({ dir, off });
  }

  const kids = new Array(N_GALAXIES);
  for (let k = 0; k < N_GALAXIES; k++) {
    const f = fils[k % FIL];
    const t = (r() * 2 - 1) * R;
    const cx = root.ac[0] + f.off[0] + f.dir[0] * t + gauss() * 380;
    const cy = root.ac[1] + f.off[1] + f.dir[1] * t + gauss() * 380;
    const cz = root.ac[2] + f.off[2] + f.dir[2] * t + gauss() * 380;
    const radius = rand(GALAXY_RADIUS_MIN, GALAXY_RADIUS_MAX);
    const id = root.id + '/g' + k;
    const summary = {
      colorIdx: B.starColor ? starColorIdx(r) : 5,
      brightness: rand(0.5, 1.0),
      kind: KIND_GALAXY,
    };
    kids[k] = makeNode(id, KIND_GALAXY, 1, [cx, cy, cz], radius, root, summary, root._seed);
  }
  return kids;
}

// galaxy -> ~12 'system' nodes, centers on the galaxy disk plane at their
// orbital radius from the galaxy center, within the galaxy radius. The
// disk plane is the galaxy's own (derived deterministically from its rng).
function genSystems(gal) {
  const B = Builders();
  const r = gal.rng();
  const rand = (a, b) => a + r() * (b - a);

  // The galaxy disk orientation: a tilt + azimuth, like makeGalaxy uses.
  const tilt = rand(0, Math.PI);
  const az = rand(0, 2 * Math.PI);
  const [nx, ny, nz] = B.unitNormalFromTilt(tilt, az);
  const [ux, uy, uz, vx, vy, vz] = B.basisFor(nx, ny, nz);

  const kids = new Array(N_SYSTEMS);
  for (let k = 0; k < N_SYSTEMS; k++) {
    // orbital radius within the disk (avoid the bright core, stay in radius)
    const orad = rand(gal.radius * 0.12, gal.radius * 0.92);
    const theta = rand(0, 2 * Math.PI);
    const ct = Math.cos(theta), st = Math.sin(theta);
    const cx = gal.ac[0] + (ux * ct + vx * st) * orad;
    const cy = gal.ac[1] + (uy * ct + vy * st) * orad;
    const cz = gal.ac[2] + (uz * ct + vz * st) * orad;
    const id = gal.id + '/s' + k;
    const summary = {
      colorIdx: starColorIdx(r),
      brightness: rand(0.6, 1.0),
      kind: KIND_SYSTEM,
    };
    kids[k] = makeNode(id, KIND_SYSTEM, 2, [cx, cy, cz], SYSTEM_RADIUS, gal, summary, gal._seed);
  }
  return kids;
}

// system -> star + [2..8] 'planet' nodes, centers at orbital radii around
// the star (the system center). Planets ride a shared (slightly tilted)
// ecliptic, deterministically per system.
function genPlanets(sys) {
  const B = Builders();
  const r = sys.rng();
  const rand = (a, b) => a + r() * (b - a);

  const nPlanets = PLANETS_MIN + ((r() * (PLANETS_MAX - PLANETS_MIN + 1)) | 0);
  const tilt = rand(0, 0.25);                 // gentle ecliptic tilt
  const az = rand(0, 2 * Math.PI);
  const [nx, ny, nz] = B.unitNormalFromTilt(tilt, az);
  const [ux, uy, uz, vx, vy, vz] = B.basisFor(nx, ny, nz);

  const kids = new Array(nPlanets);
  // Planets spaced out from the star within the system radius.
  for (let k = 0; k < nPlanets; k++) {
    const frac = (k + 1) / (nPlanets + 1);
    const orad = SYSTEM_RADIUS * (0.18 + frac * 0.74) * rand(0.92, 1.08);
    const theta = rand(0, 2 * Math.PI);
    const ct = Math.cos(theta), st = Math.sin(theta);
    const cx = sys.ac[0] + (ux * ct + vx * st) * orad;
    const cy = sys.ac[1] + (uy * ct + vy * st) * orad;
    const cz = sys.ac[2] + (uz * ct + vz * st) * orad;
    const id = sys.id + '/p' + k;
    const summary = {
      colorIdx: (1 + ((r() * 6) | 0)),         // planetary palette range
      brightness: rand(0.3, 0.8),
      kind: KIND_PLANET,
    };
    kids[k] = makeNode(id, KIND_PLANET, 3, [cx, cy, cz], PLANET_RADIUS, sys, summary, sys._seed);
  }
  return kids;
}

// A star-like palette index draw (mirrors scenarios' starColor weighting,
// but takes an explicit rng so node generation is deterministic).
function starColorIdx(r) {
  const u = r();
  if (u < 0.45) return 6;
  if (u < 0.70) return 5;
  if (u < 0.85) return 4;
  if (u < 0.93) return 3;
  if (u < 0.97) return 2;
  if (u < 0.99) return 1;
  return 0;
}

/* =====================  populate (live bodies)  ===================== */

const TYPE_STAR = 0, TYPE_BH = 1, TYPE_PLANET = 2, TYPE_DUST = 3, TYPE_GAS = 4;

function populateNode(node, budget, out) {
  const B = Builders();
  // Deterministic per-node RNG drives makeGalaxy / rand / gauss.
  B.setRng(node.rng());
  // Each node owns its own dark-matter halo set when live.
  if (globalThis.DarkMatter) globalThis.DarkMatter.list.length = 0;

  let result;
  switch (node.kind) {
    case KIND_UNIVERSE: result = popUniverse(node, budget, out); break;
    case KIND_GALAXY:   result = popGalaxy(node, budget, out);   break;
    case KIND_SYSTEM:   result = popSystem(node, budget, out);   break;
    case KIND_PLANET:   result = popPlanet(node, budget, out);   break;
    default:            result = { cfg: {}, light: { x: 0, y: 0, z: 0 } };
  }
  B.resetRng();
  return result;
}

// 'universe' -> the ~50-galaxy cosmic web, centered at origin (LOCAL),
// like the supercluster scenario. budget scales per-galaxy populations.
function popUniverse(node, budget, out) {
  const B = Builders();
  const r = node.rng();                 // a fresh stream for layout (setRng already set the module rng)
  const rand = B.rand, gauss = B.gauss;
  const g = budget.gpu;
  const R = UNIVERSE_RADIUS, H = 0.02;

  const FIL = N_FILAMENTS_MIN + (B.rand(0, 1) < 0.5 ? 1 : 0);
  const NGAL = N_GALAXIES;
  const target = g ? budget.maxBodies * 0.92 : Math.min(budget.maxBodies * 0.4, 25000);
  const perGal = Math.floor(target / NGAL);
  const stars = g ? 320 : Math.max(120, Math.floor(perGal * 0.40));
  const dust = g ? Math.max(0, perGal - Math.floor(stars * 1.18) - 9) : Math.floor(perGal * 0.52);
  const gas = g ? 8 : 6;

  // Phase continuity: rotating the whole web's azimuth by node.phase keeps
  // re-entry continuous (the web "drifts" with the clock).
  const phaseAz = node.phase;
  const cph = Math.cos(phaseAz), sph = Math.sin(phaseAz);

  const fils = [];
  for (let f = 0; f < FIL; f++) {
    const th = rand(0, 2 * Math.PI), ph = Math.acos(rand(-1, 1));
    const dir = [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
    const off = [gauss() * R * 0.25, gauss() * R * 0.25, gauss() * R * 0.25];
    fils.push({ dir, off });
  }
  for (let k = 0; k < NGAL; k++) {
    const galStars = stars, galDust = dust, galGas = gas;
    if (out.n + Math.floor(galStars * 1.18) + galDust + galGas + 1 > budget.maxBodies) break;
    const f = fils[k % FIL];
    const t = (rand(0, 1) * 2 - 1) * R;
    let cx = f.off[0] + f.dir[0] * t + gauss() * 380;
    let cy = f.off[1] + f.dir[1] * t + gauss() * 380;
    let cz = f.off[2] + f.dir[2] * t + gauss() * 380;
    // rotate web about Y by node.phase (analytic drift)
    const rx = cx * cph - cz * sph, rz = cx * sph + cz * cph;
    cx = rx; cz = rz;
    B.makeGalaxy({
      cx, cy, cz,
      cvx: cx * H + gauss() * 1.5, cvy: cy * H + gauss() * 1.5, cvz: cz * H + gauss() * 1.5,
      stars: galStars, dust: galDust, gas: galGas,
      radius: rand(120, 260), bhMass: rand(3000, 9000),
      tiltRad: rand(0, Math.PI), azimuthRad: rand(0, 2 * Math.PI),
      spinDir: rand(0, 1) < 0.5 ? 1 : -1,
    });
  }
  return {
    cfg: { dt: 0.45, substeps: 1, softening: 12, captureRadius: 8, myrPerT: 2 },
    light: { x: 0, y: 0, z: 0 },
  };
}

// 'galaxy' -> a single disk/bulge/halo galaxy centered at origin (LOCAL),
// scaled to budget like the spiral scenario. node.phase rotates the disk
// azimuth so a galaxy re-entered at phase=pi is half a turn around.
function popGalaxy(node, budget, out) {
  const B = Builders();
  const g = budget.gpu;
  const X = g && budget.maxBodies > (1 << 20) ? 4 : 1;
  // PHASE CONTINUITY: node.phase rotates the disk rigidly about the Y axis.
  // makeGalaxy orients the disk via unitNormalFromTilt(tilt, azimuth):
  // with a NONZERO tilt, sweeping `azimuth` rotates the disk's normal (its
  // angular-momentum vector) about Y — i.e. a rigid rotation of the whole
  // disk. So azimuthRad = GAL_TILT_AZ_BASE + node.phase makes a galaxy
  // re-entered at phase=pi land half a turn around vs phase=0, keeping
  // re-entry after analytic aging continuous. (A face-on tilt=0 disk would
  // be azimuth-invariant, so we use a fixed small tilt.)
  B.makeGalaxy({
    cx: 0, cy: 0, cz: 0, cvx: 0, cvy: 0, cvz: 0,
    stars: g ? 12000 : 4600,
    dust: g ? 128000 * X : 9000,
    gas: g ? 5000 * Math.min(X, 2) : 600,
    radius: 900, bhMass: 40000,
    tiltRad: 0.35, azimuthRad: node.phase, spinDir: 1,
  });
  return {
    cfg: { dt: 0.22, substeps: 1, softening: 6, captureRadius: 6, myrPerT: 0.5 },
    light: { x: 0, y: 0, z: 0 },
  };
}

// 'system' -> a star (massive, at origin) + planets on inclined circular
// orbits + an asteroid belt, like the solar scenario (inlined compact
// orbit() math). node.phase offsets every planet/belt anomaly so re-entry
// after aging is continuous.
function popSystem(node, budget, out) {
  const B = Builders();
  const rand = B.rand, gauss = B.gauss;
  const g = budget.gpu;
  const SUN = 50000;
  const phase = node.phase;

  out.add(0, 0, 0, 0, 0, 0, SUN, 11, 7, TYPE_STAR, 'Star');

  // Compact inlined orbit() from the solar scenario.
  const orbit = (a, incDeg, asc, anom, speedMul = 1, about = null) => {
    const inc = incDeg * Math.PI / 180;
    const [nx, ny, nz] = B.unitNormalFromTilt(inc, asc);
    const [ux, uy, uz, vx, vy, vz] = B.basisFor(nx, ny, nz);
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

  // Planet count from the node's own children() so the visitable nodes
  // line up with what we draw live (same per-system rng).
  const planetNodes = node.children();
  const planetState = [];
  for (let k = 0; k < planetNodes.length; k++) {
    const a = 60 + k * 105 + rand(-8, 8);
    const m = rand(1, 90);
    const rv = rand(2.0, 7.6);
    const c = (1 + ((rand(0, 6))) | 0);
    const inc = rand(0, 6);
    // anomaly carries node.phase so the system rotates with the clock
    const anom = (rand(0, 2 * Math.PI) + phase) % (2 * Math.PI);
    const s = orbit(a, inc, rand(0, 6.28), anom);
    out.add(s[0], s[1], s[2], s[3], s[4], s[5], m, rv, c, TYPE_PLANET, 'Planet' + k);
    planetState.push([s[0], s[1], s[2], s[3], s[4], s[5], m]);
  }

  // Asteroid belt: low-inclination scatter, scaled to budget like solar.
  const X = g && budget.maxBodies > (1 << 20) ? 4 : 1;
  const beltN = g ? 20000 * X : 5000;
  const beltLo = 60 + planetNodes.length * 105 + 30;
  for (let i = 0; i < beltN; i++) {
    if (out.n + 1 > budget.maxBodies) break;
    const a = rand(beltLo, beltLo + 90);
    const anom = (rand(0, 2 * Math.PI) + phase) % (2 * Math.PI);
    const s = orbit(a, Math.abs(gauss()) * 8, rand(0, 6.28), anom, rand(0.97, 1.03));
    out.add(s[0], s[1], s[2], s[3], s[4], s[5], 0.001, rand(0.3, 0.7), 5, TYPE_DUST, null);
  }
  return {
    cfg: { dt: 0.05, substeps: 3, softening: 1.5, captureRadius: 4, myrPerT: 0.002 },
    light: { x: 0, y: 0, z: 0 },
  };
}

// 'planet' -> the planet at origin + [0..4] moons on circular orbits + a
// faint ring sometimes. node.phase offsets each moon's anomaly.
function popPlanet(node, budget, out) {
  const B = Builders();
  const rand = B.rand, gauss = B.gauss;
  const g = budget.gpu;
  const phase = node.phase;
  const PM = 60;     // planet mass (heavy enough to hold moons at this scale)

  out.add(0, 0, 0, 0, 0, 0, PM, rand(3.0, 6.0), node.summary.colorIdx, TYPE_PLANET, 'Planet');

  const orbit = (a, incDeg, asc, anom, speedMul = 1) => {
    const inc = incDeg * Math.PI / 180;
    const [nx, ny, nz] = B.unitNormalFromTilt(inc, asc);
    const [ux, uy, uz, vx, vy, vz] = B.basisFor(nx, ny, nz);
    const ct = Math.cos(anom), st = Math.sin(anom);
    const v = Math.sqrt(PM / a) * speedMul;
    return [
      (ux * ct + vx * st) * a, (uy * ct + vy * st) * a, (uz * ct + vz * st) * a,
      (-ux * st + vx * ct) * v, (-uy * st + vy * ct) * v, (-uz * st + vz * ct) * v,
    ];
  };

  const nMoons = MOONS_MIN + ((rand(0, 1) * (MOONS_MAX - MOONS_MIN + 1)) | 0);
  for (let k = 0; k < nMoons; k++) {
    const a = 4 + k * 3.5 + rand(-0.5, 0.5);
    const anom = (rand(0, 2 * Math.PI) + phase) % (2 * Math.PI);
    const s = orbit(a, rand(0, 8), rand(0, 6.28), anom);
    out.add(s[0], s[1], s[2], s[3], s[4], s[5], 0.05, rand(0.7, 1.1), 3, TYPE_PLANET, 'Moon' + k);
  }

  // A faint ring sometimes: dust on tight circular orbits.
  if (rand(0, 1) < 0.4) {
    const X = g && budget.maxBodies > (1 << 20) ? 4 : 1;
    const ringN = g ? 4000 * X : 900;
    for (let i = 0; i < ringN; i++) {
      if (out.n + 1 > budget.maxBodies) break;
      const rr = rand(2.0, 3.4);
      const anom = (rand(0, 2 * Math.PI) + phase) % (2 * Math.PI);
      const s = orbit(rr, 5 + gauss() * 0.4, 1.0, anom);
      out.add(s[0], s[1], s[2], s[3], s[4], s[5], 1e-6, rand(0.2, 0.45), 11, TYPE_DUST, null);
    }
  }
  return {
    cfg: { dt: 0.02, substeps: 3, softening: 0.6, captureRadius: 2, myrPerT: 0.0005 },
    light: { x: 0, y: 0, z: 0 },
  };
}

/* =====================  Cosmos API  ===================== */

const Cosmos = {
  root: null,
  clockMyr: 0,
  seed: 0,

  // exposed for tests/tools (read-only outside this file)
  hashStringToU32,
  angularRate,
  N_GALAXIES, N_SYSTEMS,

  // Build the root 'universe' node from one seed. Sets Cosmos.root and
  // Cosmos.clockMyr = 0, returns root.
  create(seed) {
    const s = (seed >>> 0);
    this.seed = s;
    this.clockMyr = 0;
    const summary = { colorIdx: 5, brightness: 1.0, kind: KIND_UNIVERSE };
    const root = makeNode('u', KIND_UNIVERSE, 0, [0, 0, 0], UNIVERSE_RADIUS, null, summary, s);
    this.root = root;
    return root;
  },

  // Analytic aging: for every CACHED node (walk the cached tree), set
  //   node.phase = baseline + angularRate(node) * myr
  // baseline is each node's phase at create time (0). Because phase is
  // RECOMPUTED from the absolute clock (not integrated), ageTo is pure,
  // allocates no bodies, and is idempotent: ageTo(t) twice == once. Sets
  // Cosmos.clockMyr = myr.
  ageTo(myr) {
    const visit = (node) => {
      node.phase = node._baseline + angularRate(node) * myr;
      // Only walk ALREADY-CACHED children: aging must not force-generate
      // (that would defeat laziness and be O(whole universe)).
      if (node._children) {
        for (let i = 0; i < node._children.length; i++) visit(node._children[i]);
      }
    };
    if (this.root) visit(this.root);
    this.clockMyr = myr;
  },
};

globalThis.Cosmos = Cosmos;
})();
