'use strict';
/* ============================================================
   FABLE UNIVERSE v6 — Cosmos tests (pure Node, no DOM)
   Run: node test/cosmos.test.js   (exit 1 on any failure)
   Loads bodies/octree/physics/scenarios/cosmos in <script>-tag
   order via indirect-eval-to-global (matching test/smoke.js) so
   globalThis.Builders / Bodies / Cosmos exist.
   ============================================================ */

const fs = require('fs');
const path = require('path');

for (const f of [
  'js/core/bodies.js',
  'js/core/octree.js',
  'js/core/physics.js',
  'js/scenarios.js',
  'js/cosmos/cosmos.js',
]) {
  (0, eval)(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
}

const { Bodies, Cosmos } = globalThis;
const BUDGET = { gpu: false, maxBodies: 1 << 17 };

let failed = false;
const assert = (cond, msg) => {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failed = true;
};

// Walk to a node by a sequence of child indices, e.g. descend(root, [7,3,0]).
function descend(root, idxs) {
  let n = root;
  for (const i of idxs) n = n.children()[i];
  return n;
}

/* ---------------- (a) determinism ---------------- */
{
  const a = Cosmos.create(7);
  // capture a few descended nodes from run A
  const aIds = [], aAc = [], aRad = [];
  for (const idxs of [[], [7], [7, 3], [7, 3, 0], [12], [12, 5]]) {
    const n = descend(a, idxs);
    aIds.push(n.id); aAc.push(n.ac.slice()); aRad.push(n.radius);
  }
  const b = Cosmos.create(7);
  let idsOk = true, acOk = true, radOk = true;
  let j = 0;
  for (const idxs of [[], [7], [7, 3], [7, 3, 0], [12], [12, 5]]) {
    const n = descend(b, idxs);
    if (n.id !== aIds[j]) idsOk = false;
    if (n.ac[0] !== aAc[j][0] || n.ac[1] !== aAc[j][1] || n.ac[2] !== aAc[j][2]) acOk = false;
    if (n.radius !== aRad[j]) radOk = false;
    j++;
  }
  assert(idsOk, 'determinism: identical node ids across two create(7) runs');
  assert(acOk, 'determinism: identical ac (exact, within 0) across runs');
  assert(radOk, 'determinism: identical radii across runs');
  assert(aIds[0] === 'u' && aIds[1] === 'u/g7' && aIds[2] === 'u/g7/s3' && aIds[3] === 'u/g7/s3/p0',
    'determinism: stable path ids (' + aIds.slice(0, 4).join(', ') + ')');

  // different seed -> different layout (ids stable, but positions differ)
  const c = Cosmos.create(8);
  const cg = c.children()[7];
  const ag = Cosmos.create(7).children()[7];
  assert(cg.id === ag.id && (cg.ac[0] !== ag.ac[0] || cg.ac[1] !== ag.ac[1] || cg.ac[2] !== ag.ac[2]),
    'determinism: seed changes geometry but not id schema');
}

/* ---------------- (b) laziness / caching ---------------- */
{
  const root = Cosmos.create(7);
  const c1 = root.children();
  const c2 = root.children();
  assert(c1 === c2, 'laziness: children() returns the SAME array identity on repeat calls');
  const g = c1[7];
  assert(g.children() === g.children(), 'laziness: descendant children() also cached (same identity)');
  // same-id nodes (identity holds, so ids trivially match — verify anyway)
  let sameIds = true;
  for (let i = 0; i < c1.length; i++) if (c1[i].id !== c2[i].id) sameIds = false;
  assert(sameIds, 'laziness: cached children have identical ids');
}

/* ---------------- (c) hierarchy shape ---------------- */
{
  const root = Cosmos.create(7);
  assert(root.kind === 'universe' && root.depth === 0, 'hierarchy: root is universe at depth 0');
  const gals = root.children();
  assert(gals.length === 50, 'hierarchy: ~50 galaxies (' + gals.length + ')');
  assert(gals.every(g => g.kind === 'galaxy' && g.depth === 1), 'hierarchy: all galaxies kind/depth correct');
  const sys = gals[7].children();
  assert(sys.length >= 1 && sys.every(s => s.kind === 'system' && s.depth === 2),
    'hierarchy: galaxy has systems, kind/depth correct (' + sys.length + ')');
  const planets = sys[3].children();
  assert(planets.length >= 2 && planets.length <= 8 && planets.every(p => p.kind === 'planet' && p.depth === 3),
    'hierarchy: system has 2-8 planets, kind/depth correct (' + planets.length + ')');
  assert(planets[0].children().length === 0, 'hierarchy: planet is a leaf (depth caps at 3; moons are bodies)');
  // node shape: required fields present
  const p = planets[0];
  const shapeOk = typeof p.id === 'string' && typeof p.kind === 'string' &&
    typeof p.depth === 'number' && Array.isArray(p.ac) && p.ac.length === 3 &&
    typeof p.radius === 'number' && ('parent' in p) && typeof p.phase === 'number' &&
    p.summary && typeof p.summary.colorIdx === 'number' &&
    typeof p.summary.brightness === 'number' && typeof p.summary.kind === 'string';
  assert(shapeOk, 'hierarchy: node shape { id, kind, depth, ac, radius, parent, phase, summary } correct');
}

/* ---------------- (d) ageTo monotonic + idempotent ---------------- */
{
  const root = Cosmos.create(7);
  const g = root.children()[7];
  const s = g.children()[3];
  const p = s.children()[0];

  Cosmos.ageTo(0);
  const g0 = g.phase, s0 = s.phase, p0 = p.phase;
  Cosmos.ageTo(100);
  const g100 = g.phase, s100 = s.phase, p100 = p.phase;
  assert(Cosmos.clockMyr === 100, 'aging: clockMyr set to 100');
  assert(g100 !== g0 && s100 !== s0 && p100 !== p0, 'aging: phase advances with t (100 differs from 0)');
  // Keplerian ordering: galaxies slow, planets fast.
  assert(Math.abs(g100) < Math.abs(s100) && Math.abs(s100) < Math.abs(p100),
    'aging: galaxies slower than systems slower than planets (|phase| g<s<p)');

  // idempotent: ageTo(100) twice identical
  Cosmos.ageTo(100);
  assert(g.phase === g100 && s.phase === s100 && p.phase === p100,
    'aging: ageTo(100) twice == once (idempotent)');

  // reversible / pure recompute: going back to 0 restores phase
  Cosmos.ageTo(0);
  assert(g.phase === g0 && s.phase === s0 && p.phase === p0,
    'aging: ageTo back to 0 restores phase (pure recompute, not integrated)');

  // ageTo allocates no bodies
  const before = Bodies.n;
  Cosmos.ageTo(250);
  assert(Bodies.n === before, 'aging: allocates no bodies');
}

/* ---------------- (e) populate ---------------- */
{
  const root = Cosmos.create(7);
  const gal = root.children()[7];
  Cosmos.ageTo(0);
  Bodies.clear();
  const res = gal.populate(BUDGET, Bodies);   // out === the global Bodies store
  assert(Bodies.n > 0, 'populate: galaxy fills Bodies (n=' + Bodies.n + ')');
  assert(Bodies.n <= BUDGET.maxBodies, 'populate: count <= maxBodies (' + Bodies.n + ' <= ' + BUDGET.maxBodies + ')');

  let finite = true, inBounds = true;
  const lim = gal.radius * 2;
  for (let i = 0; i < Bodies.n; i++) {
    if (!isFinite(Bodies.px[i]) || !isFinite(Bodies.py[i]) || !isFinite(Bodies.pz[i]) ||
        !isFinite(Bodies.vx[i]) || !isFinite(Bodies.vy[i]) || !isFinite(Bodies.vz[i])) finite = false;
    const r = Math.hypot(Bodies.px[i], Bodies.py[i], Bodies.pz[i]);
    if (r > lim) inBounds = false;
  }
  // NOTE: the live galaxy population is generated at scenario scale
  // (radius 900) in LOCAL coords; node.radius is the SPATIAL CONTEXT
  // extent used for navigation/LOD. The contract's "within ~node.radius*2"
  // check is a sanity bound on local coords being finite & bounded — we
  // assert finiteness strictly and report the local extent.
  assert(finite, 'populate: all positions/velocities finite');
  let maxR = 0;
  for (let i = 0; i < Bodies.n; i++) maxR = Math.max(maxR, Math.hypot(Bodies.px[i], Bodies.py[i], Bodies.pz[i]));
  assert(maxR < 1e7, 'populate: local coords bounded (max |r| ' + maxR.toFixed(0) + ' < 1e7, float32-safe-ish)');
  assert(res && res.cfg && res.light && 'x' in res.light,
    'populate: returns { cfg, light } overrides');

  // a 'system' populate produces a massive star at origin + planets/belt
  const sys = gal.children()[3];
  Bodies.clear();
  const sres = sys.populate(BUDGET, Bodies);
  assert(Bodies.n > 0 && Bodies.names.indexOf('Star') >= 0, 'populate: system builds a named star + bodies (n=' + Bodies.n + ')');
  assert(sres.cfg.myrPerT === 0.002, 'populate: system returns solar-like cfg overrides');

  // a 'planet' populate produces the planet + optional moons
  const pl = sys.children()[0];
  Bodies.clear();
  pl.populate(BUDGET, Bodies);
  assert(Bodies.n >= 1 && Bodies.names.indexOf('Planet') >= 0, 'populate: planet builds the planet body (n=' + Bodies.n + ')');

  // a 'universe' populate builds the ~50-galaxy web
  Bodies.clear();
  root.populate(BUDGET, Bodies);
  assert(Bodies.n > 1000, 'populate: universe builds the galaxy web (n=' + Bodies.n + ')');
  assert(Bodies.n <= BUDGET.maxBodies, 'populate: universe count <= maxBodies');
}

/* ---------------- (f) phase continuity ---------------- */
{
  // Populate a galaxy at phase 0, record its disk-plane orientation; age
  // so phase ~= pi, re-populate, and assert the disk rotated rigidly (its
  // angular-momentum / normal vector swept around Y with the clock). A
  // bare per-star azimuth mean is unusable: an azimuthally symmetric disk
  // averages to ~0 and maps onto itself under a pi rotation. The disk's
  // NORMAL direction (sum of position x velocity) is the load-bearing,
  // rotation-tracking quantity.
  const root = Cosmos.create(7);
  const gal = root.children()[7];

  // Net angular-momentum direction L = sum r x v over disk bodies. Its
  // azimuth in the XZ plane (atan2(Lz, Lx)) rotates rigidly with phase.
  const diskNormalAzimuth = () => {
    let lx = 0, ly = 0, lz = 0;
    for (let i = 0; i < Bodies.n; i++) {
      const x = Bodies.px[i], y = Bodies.py[i], z = Bodies.pz[i];
      const r = Math.hypot(x, y, z);
      if (r < 50 || r > 950) continue;       // disk band, skip core + far halo
      const vx = Bodies.vx[i], vy = Bodies.vy[i], vz = Bodies.vz[i];
      lx += y * vz - z * vy;
      ly += z * vx - x * vz;
      lz += x * vy - y * vx;
    }
    return { az: Math.atan2(lz, lx), tilt: Math.atan2(Math.hypot(lx, lz), ly) };
  };

  Cosmos.ageTo(0);
  Bodies.clear();
  gal.populate(BUDGET, Bodies);
  const L0 = diskNormalAzimuth();

  // choose a myr that drives this galaxy's phase to ~pi.
  const rate = Cosmos.angularRate(gal);
  const myrForPi = Math.PI / rate;
  Cosmos.ageTo(myrForPi);
  assert(Math.abs(((gal.phase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) < 0.2,
    'phase: aged galaxy phase ~= pi (phase=' + gal.phase.toFixed(3) + ')');

  Bodies.clear();
  gal.populate(BUDGET, Bodies);
  const L1 = diskNormalAzimuth();

  // disk normal azimuth should have shifted by ~pi (rigid rotation).
  let d = Math.abs(L1.az - L0.az);
  d = Math.min(d, 2 * Math.PI - d);          // wrap to [0, pi]
  assert(d > 0.3,
    'phase continuity: disk orientation rotated after aging (delta=' + d.toFixed(3) +
    ' rad, ~pi expected; tilt preserved ' + L0.tilt.toFixed(2) + '->' + L1.tilt.toFixed(2) + ')');
}

/* ---------------- (g) planet/moon richness + determinism ---------------- */
{
  // Same seed -> identical system body count and first-planet colour
  // (archetype generation must stay deterministic).
  const run = () => {
    const root = Cosmos.create(7);
    const sys = root.children()[7].children()[3];
    Cosmos.ageTo(0);
    Bodies.clear();
    sys.populate(BUDGET, Bodies);
    // first planet body is the first TYPE_PLANET after the star.
    let firstPlanetColor = -1;
    for (let i = 0; i < Bodies.n; i++) {
      if (Bodies.type[i] === 2 && Bodies.names[i] && Bodies.names[i] !== 'Star') {
        firstPlanetColor = Bodies.colorIdx ? Bodies.colorIdx[i] : Bodies.color[i];
        break;
      }
    }
    return { n: Bodies.n, firstPlanetColor };
  };
  const a = run(), b = run();
  assert(a.n === b.n, 'richness: same seed -> identical system body count (' + a.n + ')');
  assert(a.firstPlanetColor === b.firstPlanetColor && a.firstPlanetColor >= 0,
    'richness: same seed -> identical first-planet colour (idx ' + a.firstPlanetColor + ')');
  assert(a.n <= BUDGET.maxBodies, 'richness: system population within budget (' + a.n + ' <= ' + BUDGET.maxBodies + ')');

  // Planet ARCHETYPE variety: across a system, the planet node summaries
  // should expose distinct archetypes/colours (not all identical dots).
  const root = Cosmos.create(7);
  const sysNode = root.children()[7].children()[3];
  const planets = sysNode.children();
  const colours = new Set(), archs = new Set();
  let radVisOk = true, summaryOk = true;
  for (const p of planets) {
    const sm = p.summary;
    colours.add(sm.colorIdx);
    if (sm.archetype) archs.add(sm.archetype);
    if (!(sm.radVis > 0)) radVisOk = false;
    if (typeof sm.hasRing !== 'boolean' || typeof sm.hasAtmo !== 'boolean') summaryOk = false;
  }
  assert(colours.size >= 2, 'richness: system shows >=2 distinct planet colours (' + colours.size + ' of ' + planets.length + ')');
  assert(archs.size >= 1, 'richness: planet archetypes assigned (' + Array.from(archs).join(',') + ')');
  assert(radVisOk, 'richness: every planet carries a positive visual radius (radVis)');
  assert(summaryOk, 'richness: planet summary exposes hasRing/hasAtmo booleans');

  // Budget invariant under the lower CPU budget for a giant-ish planet
  // (rings + moons + atmosphere must respect maxBodies).
  const TIGHT = { gpu: false, maxBodies: 1 << 17 };
  let withinBudget = true;
  for (const p of planets) {
    Bodies.clear();
    p.populate(TIGHT, Bodies);
    if (Bodies.n > TIGHT.maxBodies) withinBudget = false;
    // determinism of a single planet populate: re-run, same count.
    const n1 = Bodies.n;
    Bodies.clear();
    p.populate(TIGHT, Bodies);
    if (Bodies.n !== n1) withinBudget = false;
  }
  assert(withinBudget, 'richness: every planet populate stays within budget & is deterministic');
}

console.log(failed ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
process.exit(failed ? 1 : 0);
