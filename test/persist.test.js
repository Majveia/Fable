'use strict';
// Persistence: aging math + in-memory round-trip (Node has no indexedDB,
// so this exercises the shim path the same code falls back to in locked
// down browsers). Run: node test/persist.test.js

const fs = require('fs');
const path = require('path');
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js/cosmos/persist.js'), 'utf8'));
const { Persist } = globalThis;

let failed = false;
const check = (c, m, extra) => {
  console.log((c ? 'PASS  ' : 'FAIL  ') + m + (extra ? `  [${extra}]` : ''));
  if (!c) failed = true;
};

(async () => {
  check(Persist._useMemory(), 'node uses in-memory shim (no indexedDB)');

  // ageDelta
  check(Persist.ageDelta(0, 0) === 0, 'ageDelta with no timestamps = 0');
  const hourMs = 3600 * 1000;
  const oneHour = Persist.ageDelta(1000, 1000 + hourMs);
  check(Math.abs(oneHour - 200) < 1e-6, '1 real hour ages ~200 Myr', oneHour.toFixed(2));
  const huge = Persist.ageDelta(0 + 1, 1 + hourMs * 1000);
  check(huge === Persist.AGE_CAP_MYR, 'aging is capped', `${huge}`);
  check(Persist.ageDelta(5000, 4000) === 0, 'negative elapsed clamps to 0');

  // round-trip
  const before = await Persist.load();
  check(before === null, 'fresh load returns null');
  await Persist.save({ seed: 12345, clockMyr: 678.5, edits: [{ nodeId: 'u/g1' }] });
  const got = await Persist.load();
  check(got && got.seed === 12345, 'seed round-trips', got && got.seed);
  check(got && Math.abs(got.clockMyr - 678.5) < 1e-9, 'clock round-trips', got && got.clockMyr);
  check(got && got.edits.length === 1, 'edits round-trip', got && got.edits.length);
  check(got && got.lastVisitMs > 0, 'lastVisitMs stamped on save');

  // a simulated "away" gap ages the clock on the next boot
  const aged = got.clockMyr + Persist.ageDelta(got.lastVisitMs - hourMs, got.lastVisitMs);
  check(Math.abs(aged - (678.5 + 200)) < 0.5, 'clock advances by elapsed on reload', aged.toFixed(1));

  await Persist.reset();
  check((await Persist.load()) === null, 'reset clears state');

  console.log(failed ? '\nFAILED' : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})();
