'use strict';
/* ============================================================
   FABLE: DRIFTER v7 — Landmarks tests (pure Node, no DOM)
   Run: node test/landmarks.test.js   (exit 1 on any failure)

   Loads bodies/octree/physics/scenarios/cosmos/landmarks in
   <script>-tag order via indirect-eval-to-global (matching
   test/cosmos.test.js / test/smoke.js) so globalThis.Builders /
   Bodies / Cosmos / Landmarks exist. Asserts the eight sandboxes
   are merged into the one universe as reachable named landmark
   nodes whose populate() reproduces the scenario in local coords.
   ============================================================ */

const fs = require('fs');
const path = require('path');

for (const f of [
  'js/core/bodies.js',
  'js/core/octree.js',
  'js/core/physics.js',
  'js/scenarios.js',
  'js/cosmos/cosmos.js',
  'js/cosmos/landmarks.js',
]) {
  (0, eval)(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
}

const { Bodies, Cosmos, Landmarks } = globalThis;
const BUDGET = { gpu: false, maxBodies: 1 << 17 };

let failed = false;
const assert = (cond, msg) => {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failed = true;
};

// The mapped names the contract requires (>=7 of them; we ship 8).
const REQUIRED_NAMES = ['Sol', 'Antennae', 'Orion Nursery', 'The Maw', 'Omega', 'Cosmic Dawn'];
// scenario -> expected kind (system for solar/binary; galaxy for the rest).
const KIND_FOR_SCENARIO = {
  solar: 'system', binary: 'system',
  collision: 'galaxy', nebula: 'galaxy', cluster: 'galaxy', bigbang: 'galaxy',
};

/* ---------------- (a) list() has the mapped landmarks ---------------- */
{
  Cosmos.create(7);
  Landmarks.inject(Cosmos);
  const list = Landmarks.list();
  assert(list.length >= 7, 'list: at least 7 landmarks (' + list.length + ')');

  const byName = new Map(list.map((l) => [l.name, l]));
  let allMapped = true, missing = [];
  for (const nm of REQUIRED_NAMES) if (!byName.has(nm)) { allMapped = false; missing.push(nm); }
  assert(allMapped, 'list: all mapped names present' + (missing.length ? ' (missing ' + missing.join(', ') + ')' : ''));

  // scenario mapping is exactly the contract's map.
  assert(byName.get('Sol').scenario === 'solar', 'map: Sol -> solar');
  assert(byName.get('Antennae').scenario === 'collision', 'map: Antennae -> collision');
  assert(byName.get('Orion Nursery').scenario === 'nebula', 'map: Orion Nursery -> nebula');
  assert(byName.get('The Maw').scenario === 'binary', 'map: The Maw -> binary');
  assert(byName.get('Omega').scenario === 'cluster', 'map: Omega -> cluster');
  assert(byName.get('Cosmic Dawn').scenario === 'bigbang', 'map: Cosmic Dawn -> bigbang');

  // kinds match the scenario scale.
  let kindsOk = true;
  for (const l of list) if (l.kind !== KIND_FOR_SCENARIO[l.scenario]) kindsOk = false;
  assert(kindsOk, 'map: each kind matches the scenario scale (system/galaxy)');

  // list entries well-formed: id, name, kind, ac[3], scenario.
  let shapeOk = true;
  for (const l of list) {
    if (typeof l.id !== 'string' || !/^u\/lm\//.test(l.id)) shapeOk = false;
    if (typeof l.name !== 'string' || typeof l.kind !== 'string') shapeOk = false;
    if (!Array.isArray(l.ac) || l.ac.length !== 3) shapeOk = false;
    if (typeof l.scenario !== 'string') shapeOk = false;
  }
  assert(shapeOk, 'list: entries are { id, name, kind, ac:[x,y,z], scenario }');

  // at least one original named system beyond the six mapped sandboxes.
  const original = list.filter((l) => !REQUIRED_NAMES.includes(l.name));
  assert(original.length >= 1, 'list: includes >=1 original named system (' +
    original.map((l) => l.name).join(', ') + ')');
}

/* ---------------- (b) ac placed in the universe volume ---------------- */
{
  const list = Landmarks.list();
  let inVolume = true, allFinite = true;
  for (const l of list) {
    const [x, y, z] = l.ac;
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) allFinite = false;
    const r = Math.hypot(x, y, z);
    if (r > 6000) inVolume = false;   // universe radius ~6000
  }
  assert(allFinite, 'placement: all landmark acs finite');
  assert(inVolume, 'placement: all landmark acs within the universe volume (|ac| <= 6000)');
}

/* ---------------- (c) each landmark populate fills Bodies ---------------- */
{
  const nodes = Landmarks.nodes;
  let allFilled = true, allFinite = true, allBounded = true;
  const report = [];
  for (const n of nodes) {
    Bodies.clear();
    const res = n.populate(BUDGET, Bodies);
    if (!(Bodies.n > 0)) { allFilled = false; report.push(n.name + ':EMPTY'); }
    if (Bodies.n > BUDGET.maxBodies) { allBounded = false; report.push(n.name + ':OVERBUDGET'); }
    let maxR = 0;
    for (let i = 0; i < Bodies.n; i++) {
      if (!isFinite(Bodies.px[i]) || !isFinite(Bodies.py[i]) || !isFinite(Bodies.pz[i]) ||
          !isFinite(Bodies.vx[i]) || !isFinite(Bodies.vy[i]) || !isFinite(Bodies.vz[i])) allFinite = false;
      maxR = Math.max(maxR, Math.hypot(Bodies.px[i], Bodies.py[i], Bodies.pz[i]));
    }
    if (maxR > 1e7) allBounded = false;
    // every populate returns scenario { cfg, light } overrides.
    if (!(res && res.cfg && res.light && 'x' in res.light)) { allFilled = false; report.push(n.name + ':NOCFG'); }
  }
  assert(allFilled, 'populate: every landmark fills Bodies and returns { cfg, light }' +
    (report.length ? ' [' + report.join(', ') + ']' : ''));
  assert(allFinite, 'populate: all local coords finite');
  assert(allBounded, 'populate: counts within budget and coords bounded (local frame)');

  // The Sol landmark genuinely reproduces the solar scenario (named star + planets).
  const sol = Landmarks.byId('u/lm/sol');
  Bodies.clear();
  sol.populate(BUDGET, Bodies);
  assert(Bodies.names.indexOf('Sol') >= 0, 'populate: Sol landmark builds the named sun');
  assert(Bodies.names.indexOf('Earth') >= 0 && Bodies.names.indexOf('Jupiter') >= 0,
    'populate: Sol landmark builds named planets (solar scenario reproduced)');
  assert(Bodies.n > 5000, 'populate: Sol landmark fills a full system (n=' + Bodies.n + ')');

  // The Antennae landmark reproduces the collision scenario (two BHs).
  const ant = Landmarks.byId('u/lm/antennae');
  Bodies.clear();
  ant.populate(BUDGET, Bodies);
  let bh = 0;
  for (let i = 0; i < Bodies.n; i++) if (Bodies.type[i] === Bodies.TYPE_BH) bh++;
  assert(bh >= 2, 'populate: Antennae reproduces the collision (>=2 black holes, got ' + bh + ')');
}

/* ---------------- (d) determinism across two injects ---------------- */
{
  Cosmos.create(7);
  const a = Landmarks.inject(Cosmos).map((n) => [n.id, n.ac.slice()]);
  Cosmos.create(7);
  const b = Landmarks.inject(Cosmos).map((n) => [n.id, n.ac.slice()]);
  let idsOk = true, acOk = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0]) idsOk = false;
    const pa = a[i][1], pb = b[i][1];
    if (pa[0] !== pb[0] || pa[1] !== pb[1] || pa[2] !== pb[2]) acOk = false;
  }
  assert(idsOk, 'determinism: same seed -> identical landmark ids');
  assert(acOk, 'determinism: same seed -> identical landmark acs (exact)');

  // populate is deterministic too: same seed -> same Bodies.n + first body.
  const sol1 = Landmarks.byId('u/lm/sol');
  Bodies.clear(); sol1.populate(BUDGET, Bodies);
  const n1 = Bodies.n, p1 = [Bodies.px[1], Bodies.py[1], Bodies.pz[1]];
  Cosmos.create(7); Landmarks.inject(Cosmos);
  const sol2 = Landmarks.byId('u/lm/sol');
  Bodies.clear(); sol2.populate(BUDGET, Bodies);
  const n2 = Bodies.n, p2 = [Bodies.px[1], Bodies.py[1], Bodies.pz[1]];
  assert(n1 === n2 && p1[0] === p2[0] && p1[1] === p2[1] && p1[2] === p2[2],
    'determinism: populate reproducible (n=' + n1 + ')');

  // different seed -> different placement (ids stable, acs differ).
  Cosmos.create(8);
  const c = Landmarks.inject(Cosmos).map((n) => [n.id, n.ac.slice()]);
  let idSchemaStable = true, geomDiffers = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== c[i][0]) idSchemaStable = false;
    const pa = a[i][1], pc = c[i][1];
    if (pa[0] !== pc[0] || pa[1] !== pc[1] || pa[2] !== pc[2]) geomDiffers = true;
  }
  assert(idSchemaStable && geomDiffers, 'determinism: seed changes ac geometry but not id schema');
}

/* ---------------- (e) reachable via the cosmos ---------------- */
{
  Cosmos.create(7);
  const root = Cosmos.root;
  const lms = Landmarks.inject(Cosmos);
  const rootKids = root.children();
  // every landmark is among the universe root's children (reachable by descent).
  let allReachable = true;
  for (const lm of lms) if (rootKids.indexOf(lm) < 0) allReachable = false;
  assert(allReachable, 'reachability: every landmark is a child of the universe root');

  // a landmark has a proper parent pointer back to the root (Navigator ascend).
  const sol = Landmarks.byId('u/lm/sol');
  assert(sol.parent === root, 'reachability: landmark.parent === cosmos root');

  // node shape matches a cosmos node (Navigator treats it like any node).
  const shapeOk = typeof sol.id === 'string' && typeof sol.kind === 'string' &&
    typeof sol.depth === 'number' && Array.isArray(sol.ac) && sol.ac.length === 3 &&
    typeof sol.radius === 'number' && typeof sol.viewRadius === 'number' &&
    ('parent' in sol) && typeof sol.phase === 'number' &&
    sol.summary && typeof sol.summary.colorIdx === 'number' &&
    typeof sol.children === 'function' && typeof sol.populate === 'function';
  assert(shapeOk, 'reachability: landmark node shape matches a cosmos node');

  // the solar landmark is descendable: its children are reachable planet nodes.
  const planets = sol.children();
  assert(planets.length >= 2 && planets.every((p) => p.kind === 'planet' && p.parent === sol),
    'reachability: Sol landmark descends to reachable planet nodes (' + planets.length + ')');

  // injecting twice does not duplicate landmarks in the root's children.
  const before = root.children().length;
  Landmarks.inject(Cosmos);
  const after = root.children().length;
  assert(before === after, 'reachability: re-inject is idempotent (no duplicate landmarks: ' +
    before + ' -> ' + after + ')');

  // galaxy landmark (no solar planets) is a leaf set-piece.
  const omega = Landmarks.byId('u/lm/omega');
  assert(omega.children().length === 0, 'reachability: galaxy set-piece landmark is a leaf');
}

console.log(failed ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
process.exit(failed ? 1 : 0);
