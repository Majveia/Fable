'use strict';
/* ============================================================
   FABLE: DRIFTER — POI tests (pure Node, no DOM)
   Run: node test/poi.test.js   (exit 1 on any failure)

   Loads js/game/poi.js via indirect-eval-to-global (matching
   test/smoke.js / test/cosmos.test.js) so globalThis.POI exists.
   MUST pass with globalThis.Lore ABSENT — we use a tiny stub node
   and never require cosmos.js.
   ============================================================ */

const fs = require('fs');
const path = require('path');

// Ensure Lore is absent: the module must degrade to plain strings.
delete globalThis.Lore;

(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js/game/poi.js'), 'utf8'));

const { POI } = globalThis;

let failed = false;
const assert = (cond, msg) => {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failed = true;
};

// Tiny stub node — no cosmos.js. { id, kind, viewRadius } is all POI needs.
function stub(id, kind, viewRadius) {
  return { id: id, kind: kind, viewRadius: viewRadius };
}

const VR = 1000;

/* ---------------- (a) determinism + caching ---------------- */
{
  const n1 = stub('u/g7/s3', 'system', VR);
  const a = POI.forNode(n1);
  // Same call returns the SAME cached array identity.
  assert(POI.forNode(n1) === a, 'caching: forNode returns same array identity (node._pois)');
  assert(n1._pois === a, 'caching: result cached on node._pois');

  // A FRESH node with the same id produces an identical (deep-equal) set.
  const n2 = stub('u/g7/s3', 'system', VR);
  const b = POI.forNode(n2);
  assert(b.length === a.length, 'determinism: same id -> same POI count');
  let same = b.length === a.length;
  for (let i = 0; i < a.length && same; i++) {
    const p = a[i], q = b[i];
    if (p.id !== q.id || p.kind !== q.kind || p.name !== q.name ||
        p.blurb !== q.blurb || p.radius !== q.radius) same = false;
    for (let k = 0; k < 3; k++) if (p.localPos[k] !== q.localPos[k]) same = false;
  }
  assert(same, 'determinism: same id -> byte-identical POIs (pos/kind/name/blurb/radius)');

  // Different id -> generally different layout.
  const c = POI.forNode(stub('u/g8/s1', 'system', VR));
  let differs = c.length !== a.length;
  if (!differs) {
    for (let i = 0; i < a.length; i++) {
      if (c[i].localPos[0] !== a[i].localPos[0]) { differs = true; break; }
    }
  }
  assert(differs, 'determinism: different node.id -> different POIs');
}

/* ---------------- (b) shape, finiteness, bounded by viewRadius ---------------- */
{
  const KINDS = { station: 1, derelict: 1, anomaly: 1, portal: 1, beacon: 1 };
  let shapeOk = true, finiteOk = true, boundedOk = true, kindOk = true;
  // Sweep many systems/planets/galaxies.
  const samples = [];
  for (let i = 0; i < 200; i++) samples.push(stub('u/g' + i + '/s0', 'system', VR));
  for (let i = 0; i < 100; i++) samples.push(stub('u/g0/s' + i + '/p0', 'planet', 250));
  for (let i = 0; i < 100; i++) samples.push(stub('u/g' + i, 'galaxy', 5000));

  for (const node of samples) {
    for (const p of POI.forNode(node)) {
      const okShape =
        typeof p.id === 'string' && p.id.length > 0 &&
        typeof p.kind === 'string' && (p.kind in KINDS) &&
        Array.isArray(p.localPos) && p.localPos.length === 3 &&
        typeof p.radius === 'number' &&
        typeof p.name === 'string' && p.name.length > 0 &&
        typeof p.blurb === 'string' && p.blurb.length > 0 &&
        p.scanned === false;
      if (!okShape) shapeOk = false;
      if (!(p.kind in KINDS)) kindOk = false;

      const [x, y, z] = p.localPos;
      if (!isFinite(x) || !isFinite(y) || !isFinite(z) || !isFinite(p.radius)) finiteOk = false;
      const mag = Math.hypot(x, y, z);
      // magnitude must be within the node's viewRadius (finite, bounded).
      if (mag > node.viewRadius + 1e-6) boundedOk = false;
    }
  }
  assert(shapeOk, 'shape: every POI has {id,kind,localPos[3],radius,name,blurb,scanned:false}');
  assert(kindOk, 'shape: kind is one of station|derelict|anomaly|portal|beacon');
  assert(finiteOk, 'positions: all localPos and radius finite');
  assert(boundedOk, 'positions: |localPos| <= node.viewRadius for every POI');
}

/* ---------------- (c) universe has none, count ranges sane ---------------- */
{
  assert(POI.forNode(stub('u', 'universe', 1e6)).length === 0,
    'counts: universe node has zero POIs');

  // Count ranges per the contract: systems 3-7, planets/galaxies a few.
  let sysMin = Infinity, sysMax = 0, galMin = Infinity, galMax = 0;
  let sysTotal = 0, galTotal = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const s = POI.forNode(stub('u/g0/s' + i, 'system', VR)).length;
    sysMin = Math.min(sysMin, s); sysMax = Math.max(sysMax, s); sysTotal += s;
    const g = POI.forNode(stub('u/galx' + i, 'galaxy', 5000)).length;
    galMin = Math.min(galMin, g); galMax = Math.max(galMax, g); galTotal += g;
  }
  assert(sysMin >= 3 && sysMax <= 7, `counts: systems in [3,7] (saw ${sysMin}..${sysMax})`);
  const sysAvg = sysTotal / N, galAvg = galTotal / N;
  assert(sysAvg > galAvg, `kind-weight: systems richer than galaxies (sys avg ${sysAvg.toFixed(2)} > gal avg ${galAvg.toFixed(2)})`);
}

/* ---------------- (d) kind weights: portals/anomalies RARE ---------------- */
{
  // Across many systems, count POIs by kind. Portals + anomalies should be
  // a small minority; stations/derelicts/beacons dominate.
  const tally = { station: 0, derelict: 0, anomaly: 0, portal: 0, beacon: 0 };
  let total = 0;
  const N = 1500;
  for (let i = 0; i < N; i++) {
    for (const p of POI.forNode(stub('u/g5/sysw' + i, 'system', VR))) {
      tally[p.kind]++; total++;
    }
  }
  const rare = tally.portal + tally.anomaly;
  const common = tally.station + tally.derelict + tally.beacon;
  assert(total > 0, 'kind-weight: produced POIs to tally (' + total + ')');
  assert(rare / total < 0.25, `kind-weight: portals+anomalies rare (${((rare / total) * 100).toFixed(1)}% of ${total})`);
  assert(common > rare * 3, `kind-weight: common kinds dominate (common ${common} vs rare ${rare})`);
  assert(tally.portal > 0 && tally.portal < tally.station,
    `kind-weight: portals exist but are scarcer than stations (portal ${tally.portal}, station ${tally.station})`);
  console.log('     tally:', JSON.stringify(tally));
}

/* ---------------- (e) scan idempotent, first true exactly once ---------------- */
{
  const node = stub('u/g1/s9', 'system', VR);
  const pois = POI.forNode(node);
  assert(pois.length > 0, 'scan: node has POIs to scan');
  const poi = pois[0];

  const r1 = POI.scan(poi);
  assert(r1.first === true, 'scan: first scan returns first=true');
  assert(poi.scanned === true, 'scan: marks poi.scanned = true');
  assert(r1.kind === poi.kind && r1.name === poi.name && r1.blurb === poi.blurb,
    'scan: returns {kind,name,blurb} matching the POI');

  // Idempotent: scanning again never reports first again.
  let firstCount = r1.first ? 1 : 0;
  for (let i = 0; i < 10; i++) {
    const r = POI.scan(poi);
    if (r.first) firstCount++;
    assert(poi.scanned === true, 'scan: stays scanned on repeat (iter ' + i + ')');
  }
  assert(firstCount === 1, 'scan: first=true returned exactly once across repeated scans');

  // A different POI on the same node scans independently.
  if (pois.length > 1) {
    const r2 = POI.scan(pois[1]);
    assert(r2.first === true, 'scan: a second, untouched POI reports first=true independently');
  }
}

/* ---------------- (f) robustness: missing/zero viewRadius ---------------- */
{
  // No viewRadius at all -> still finite, bounded by the fallback (radius=1).
  const node = { id: 'u/g2/s2', kind: 'system' };
  const pois = POI.forNode(node);
  let ok = true;
  for (const p of pois) {
    const mag = Math.hypot(p.localPos[0], p.localPos[1], p.localPos[2]);
    if (!isFinite(mag) || mag > 1 + 1e-6) ok = false;
  }
  assert(ok, 'robustness: missing viewRadius -> positions finite and bounded by fallback');

  // null node -> empty array, no throw.
  assert(Array.isArray(POI.forNode(null)) && POI.forNode(null).length === 0,
    'robustness: forNode(null) -> [] (no throw)');
  // scan(null) -> safe shape.
  const rn = POI.scan(null);
  assert(rn && rn.first === false, 'robustness: scan(null) -> { first:false } (no throw)');
}

console.log(failed ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
process.exit(failed ? 1 : 0);
