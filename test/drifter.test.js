'use strict';
// Drifter game-state: bounties, scan→discovery, serialize/load.
// Runs without Lore/POI (degraded paths). Run: node test/drifter.test.js
const fs = require('fs');
const path = require('path');
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js/game/drifter.js'), 'utf8'));
const { Drifter } = globalThis;

let failed = false;
const check = (c, m, extra) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m + (extra ? '  [' + extra + ']' : '')); if (!c) failed = true; };

// bounties (degraded, no Lore)
const b = Drifter.refreshBounties(42, ['u/lm/sol', 'u/g0/s1']);
check(b.length === 6, 'refreshBounties makes a board', b.length + '');
check(b.every((x) => x.targetId && x.systemHint && typeof x.reward === 'number'), 'bounties well-formed');
const b2 = Drifter.refreshBounties(42, ['u/lm/sol', 'u/g0/s1']);
check(JSON.stringify(b2.map((x) => x.targetId)) === JSON.stringify(b.map((x) => x.targetId)), 'bounty targets deterministic');

Drifter.acceptBounty(b[0]);
check(Drifter.activeBounty === b[0], 'accept sets active bounty');
check(Drifter.completeBountyIfAt('nope') === null, 'wrong system does not complete');
const done = Drifter.completeBountyIfAt(b[0].targetId);
check(done === b[0] && b[0].done, 'reaching target completes bounty');

// scan -> discovery
const poi = { id: 'p1', kind: 'derelict', name: 'The Bebop', blurb: 'rusting, beautiful', nodeId: 'u/g0/s1' };
let disc = null;
for (let i = 0; i < 20 && !disc; i++) disc = Drifter.tickScan(0.1, poi, true);
check(disc && disc.first === true, 'sustained scan logs a first discovery', disc && disc.name);
check(Drifter.discoveries.length === 1, 'discovery recorded');
const again = Drifter.logDiscovery(poi, 'u/g0/s1');
check(again.first === false, 'rescanning the same POI is not first');
check(Drifter.tickScan(0.1, null, true) === null && Drifter.scanProgress === 0, 'scan resets with no POI');

// serialize / load round-trip
const blob = Drifter.serialize();
check(blob.discoveries.length === 1, 'serialize captures discoveries');
const D2 = (0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js/game/drifter.js'), 'utf8'), globalThis.Drifter);
globalThis.Drifter.discoveries = []; globalThis.Drifter._scanned = {};
globalThis.Drifter.load(blob);
check(globalThis.Drifter.discoveries.length === 1, 'load restores discoveries');

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
