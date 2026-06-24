'use strict';
/* ============================================================
   FABLE: DRIFTER — Lore tests (pure Node, no DOM)
   Run: node test/lore.test.js   (exit 1 on any failure)
   Loads js/game/lore.js via indirect-eval-to-global (matching
   test/smoke.js) so globalThis.Lore exists.
   ============================================================ */

const fs = require('fs');
const path = require('path');

for (const f of ['js/game/lore.js']) {
  (0, eval)(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
}

const { Lore } = globalThis;

let failed = false;
const assert = (cond, msg) => {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failed = true;
};

// ---- leak detector: catches undefined / NaN / [object Object] / null ----
const LEAK = /undefined|NaN|\[object Object\]|\bnull\b/;
function clean(s) {
  return typeof s === 'string' && s.length > 0 && !LEAK.test(s);
}

// 100 distinct keys reused across every variety/leak sweep.
const KEYS = [];
for (let i = 0; i < 100; i++) KEYS.push('u/g' + (i % 13) + '/s' + i + '/k' + (i * 7 + 1));

/* ---------------- module surface ---------------- */
{
  assert(!!Lore, 'Lore attached to globalThis');
  for (const fn of ['systemName', 'poiName', 'poiBlurb', 'bounty', 'discovery', 'shipName', 'narrate']) {
    assert(typeof Lore[fn] === 'function', 'Lore.' + fn + ' is a function');
  }
}

/* ---------------- narrate(kindOrKey): grand narration voice ---------------- */
{
  // determinism: same string -> identical line, forever.
  let narrDet = true, narrClean = true;
  for (const k of KEYS) {
    if (Lore.narrate(k) !== Lore.narrate(k)) narrDet = false;
    if (!clean(Lore.narrate(k))) narrClean = false;
  }
  // bare kinds are deterministic too, and subject-aware.
  for (const kind of ['nursery', 'galaxy', 'black hole', 'planet', 'discovery', 'star']) {
    if (Lore.narrate(kind) !== Lore.narrate(kind)) narrDet = false;
    if (!clean(Lore.narrate(kind))) narrClean = false;
  }
  assert(narrDet, 'narrate deterministic across 100 keys + bare kinds');
  assert(narrClean, 'narrate non-empty, no placeholder leaks');

  // never empty, even for empty / nullish / junk arguments.
  let edgeOk = true;
  for (const arg of ['', undefined, null, 'zzz-unmapped-key', '/', 'u']) {
    const s = Lore.narrate(arg);
    if (!clean(s)) edgeOk = false;
  }
  assert(edgeOk, 'narrate(empty|null|junk) still yields a clean cosmic line');

  // subject inference: a keyword or node-path hint maps to the right
  // subject. The deepest/rightmost hint wins, so a planet leaf path
  // ("u/g7/s3/p2") narrates a planet, not its parent galaxy.
  let subjOk = true;
  const subjChecks = [
    ['nursery', 'nursery'], ['the nebula', 'nursery'], ['a stellar nursery', 'nursery'],
    ['galaxy', 'galaxy'], ['u/g7', 'galaxy'], ['the spiral', 'galaxy'], ['cosmic web', 'galaxy'],
    ['black hole', 'blackhole'], ['u/g7/s3/bh', 'blackhole'], ['event horizon', 'blackhole'],
    ['planet', 'planet'], ['u/g7/s3/p2', 'planet'], ['a frozen world', 'planet'],
    ['star', 'star'], ['u/g7/s3', 'star'], ['the pulsar', 'star'],
    ['discovery', 'discovery'], ['anomaly', 'discovery'], ['beacon', 'discovery'],
    ['', 'cosmos'], ['zzz-nothing', 'cosmos'],
  ];
  for (const [arg, subj] of subjChecks) {
    const got = Lore._narrateSubject(arg);
    if (got !== subj) {
      subjOk = false;
      console.log('   _narrateSubject(' + JSON.stringify(arg) + ') = ' + got + ', want ' + subj);
    }
  }
  assert(subjOk, 'narrate infers subject from kind keyword / node-path hint (deepest wins)');

  // variety: a broad mix of keys across all subjects yields many distinct
  // narrations (each subject composes open x image x close ~= 125 lines).
  const nset = new Set();
  const tags = ['nursery', 'galaxy', 'black hole', 'planet', 'star', 'discovery', ''];
  for (let i = 0; i < 280; i++) nset.add(Lore.narrate('u/g' + (i % 13) + '/s' + i + ':' + tags[i % tags.length]));
  assert(nset.size >= 180, 'narrate variety: ' + nset.size + '/280 distinct across subjects (>=180)');

  // each subject alone is varied (open x image x close composes broadly).
  let perSubjOk = true;
  for (const subj of ['nursery', 'galaxy', 'blackhole', 'planet', 'star', 'discovery', 'cosmos']) {
    const s = new Set();
    for (let i = 0; i < 60; i++) s.add(Lore.narrate('seed' + i + ':' + subj));
    if (s.size < 25) { perSubjOk = false; console.log('   subject ' + subj + ' only ' + s.size + '/60'); }
  }
  assert(perSubjOk, 'narrate varied within each subject (>=25/60 per subject)');

  // narration reads like a sentence: has the em-dash close, decent length.
  let shapeOk = true;
  for (const k of ['nursery', 'galaxy', 'u/g3/s1/p0', 'black hole', 'discovery']) {
    const s = Lore.narrate(k);
    if (s.length < 40 || s.indexOf('—') < 0) shapeOk = false;
  }
  assert(shapeOk, 'narrate composes a full awe-struck line (length + em-dash close)');
}

/* ---------------- determinism (same key -> identical output) ---------------- */
{
  let sysOk = true, nameOk = true, blurbOk = true, bountyOk = true, shipOk = true;
  for (const k of KEYS) {
    if (Lore.systemName(k) !== Lore.systemName(k)) sysOk = false;
    if (Lore.shipName(k) !== Lore.shipName(k)) shipOk = false;
    for (const kind of ['station', 'derelict', 'anomaly', 'portal', 'beacon']) {
      if (Lore.poiName(k, kind) !== Lore.poiName(k, kind)) nameOk = false;
      if (Lore.poiBlurb(k, kind) !== Lore.poiBlurb(k, kind)) blurbOk = false;
    }
    const a = Lore.bounty(k), b = Lore.bounty(k);
    if (JSON.stringify(a) !== JSON.stringify(b)) bountyOk = false;
  }
  assert(sysOk, 'systemName deterministic across 100 keys');
  assert(nameOk, 'poiName deterministic across 100 keys x 5 kinds');
  assert(blurbOk, 'poiBlurb deterministic across 100 keys x 5 kinds');
  assert(bountyOk, 'bounty deterministic across 100 keys');
  assert(shipOk, 'shipName deterministic across 100 keys');
  // cross-process style sanity: a fixed key gives a fixed, known-good string
  assert(typeof Lore.systemName('fixed-key-7') === 'string'
    && Lore.systemName('fixed-key-7') === Lore.systemName('fixed-key-7'),
    'systemName stable for a fixed literal key');
}

/* ---------------- non-empty + no placeholder leaks ---------------- */
{
  let sysClean = true, nameClean = true, blurbClean = true, shipClean = true,
      bcrimeClean = true, bflavClean = true, baliasClean = true, bnameClean = true;
  for (const k of KEYS) {
    if (!clean(Lore.systemName(k))) sysClean = false;
    if (!clean(Lore.shipName(k))) shipClean = false;
    for (const kind of ['station', 'derelict', 'anomaly', 'portal', 'beacon', 'weirdkind']) {
      if (!clean(Lore.poiName(k, kind))) nameClean = false;
      if (!clean(Lore.poiBlurb(k, kind))) blurbClean = false;
    }
    const b = Lore.bounty(k);
    if (!clean(b.name)) bnameClean = false;
    if (!clean(b.alias)) baliasClean = false;
    if (!clean(b.crime)) bcrimeClean = false;
    if (!clean(b.flavor)) bflavClean = false;
  }
  assert(sysClean, 'systemName non-empty, no placeholder leaks');
  assert(shipClean, 'shipName non-empty, no placeholder leaks');
  assert(nameClean, 'poiName non-empty, no placeholder leaks (incl. unknown kind)');
  assert(blurbClean, 'poiBlurb non-empty, no placeholder leaks (incl. unknown kind)');
  assert(bnameClean, 'bounty.name non-empty, no leaks');
  assert(baliasClean, 'bounty.alias non-empty, no leaks');
  assert(bcrimeClean, 'bounty.crime non-empty, no leaks');
  assert(bflavClean, 'bounty.flavor non-empty, no leaks');

  // poiName/poiBlurb with NO kind argument must still resolve cleanly.
  assert(clean(Lore.poiName('k')), 'poiName(key) without kind resolves');
  assert(clean(Lore.poiBlurb('k')), 'poiBlurb(key) without kind resolves');

  // discovery() is nondeterministic by design; assert shape only.
  let discOk = true;
  for (const kind of ['anomaly', 'portal', 'station', 'derelict', 'beacon', 'system', undefined]) {
    const d = Lore.discovery(kind);
    if (!clean(d) || d.indexOf('·') < 0) discOk = false;
  }
  assert(discOk, 'discovery(kind) non-empty toast with separator, no leaks');
}

/* ---------------- variety (100 keys -> mostly-distinct) ---------------- */
{
  function distinct(fn) {
    const set = new Set();
    for (const k of KEYS) set.add(fn(k));
    return set.size;
  }
  const sysD = distinct(Lore.systemName);
  const shipD = distinct(Lore.shipName);
  const poiD = distinct((k) => Lore.poiName(k, 'station'));
  const blurbD = distinct((k) => Lore.poiBlurb(k, 'anomaly'));
  const bountyNameD = distinct((k) => Lore.bounty(k).name + Lore.bounty(k).alias);

  assert(sysD >= 85, 'systemName variety: ' + sysD + '/100 distinct (>=85)');
  assert(shipD >= 70, 'shipName variety: ' + shipD + '/100 distinct (>=70)');
  assert(poiD >= 80, 'poiName variety: ' + poiD + '/100 distinct (>=80)');
  assert(blurbD >= 85, 'poiBlurb variety: ' + blurbD + '/100 distinct (>=85)');
  assert(bountyNameD >= 75, 'bounty name+alias variety: ' + bountyNameD + '/100 distinct (>=75)');

  // different keys should not collapse to one string
  assert(Lore.systemName('a') !== Lore.systemName('b') ||
         Lore.systemName('c') !== Lore.systemName('d'),
    'distinct keys produce distinct system names');
}

/* ---------------- bounty fields well-typed and in range ---------------- */
{
  let typed = true, rewardRange = true, dangerRange = true, rewardInt = true;
  let minR = Infinity, maxR = -Infinity, minD = 9, maxD = 0;
  for (const k of KEYS) {
    const b = Lore.bounty(k);
    if (typeof b.name !== 'string' || typeof b.alias !== 'string'
      || typeof b.crime !== 'string' || typeof b.flavor !== 'string'
      || typeof b.reward !== 'number' || typeof b.danger !== 'number') typed = false;
    if (!Number.isFinite(b.reward) || b.reward < 1000 || b.reward > 9000000) rewardRange = false;
    if (!Number.isInteger(b.reward)) rewardInt = false;
    if (!Number.isInteger(b.danger) || b.danger < 1 || b.danger > 5) dangerRange = false;
    minR = Math.min(minR, b.reward); maxR = Math.max(maxR, b.reward);
    minD = Math.min(minD, b.danger); maxD = Math.max(maxD, b.danger);
  }
  assert(typed, 'bounty fields all well-typed (string/string/string/string/number/number)');
  assert(rewardRange, 'bounty.reward in [1000, 9000000] for all keys (min ' + minR + ', max ' + maxR + ')');
  assert(rewardInt, 'bounty.reward is an integer (snapped, no NaN)');
  assert(dangerRange, 'bounty.danger integer in [1,5] (min ' + minD + ', max ' + maxD + ')');
  // the danger axis should actually be exercised, not constant
  assert(maxD > minD, 'bounty.danger varies across keys (' + minD + '..' + maxD + ')');
  // reward should span a meaningful range, not be pinned
  assert(maxR > minR * 4, 'bounty.reward spans a wide band (' + minR + '..' + maxR + ')');
}

/* ---------------- formatter sanity (no NaN in display) ---------------- */
{
  const w = Lore.formatWoolongs(1234567);
  assert(typeof w === 'string' && w.indexOf('1,234,567') >= 0 && clean(w),
    'formatWoolongs adds separators cleanly: ' + w);
}

/* ---------------- showcase (visual spot-check, not asserted) ---------------- */
{
  console.log('--- sample output ---');
  for (const k of ['u/g7/s3', 'sol', 'sector-bebop', 'C-137', 'haunted-shoal']) {
    console.log('  system   ', JSON.stringify(Lore.systemName(k)));
  }
  for (const kind of ['station', 'derelict', 'anomaly', 'portal', 'beacon']) {
    const k = 'demo/' + kind;
    console.log('  poi/' + kind.padEnd(8), JSON.stringify(Lore.poiName(k, kind)));
    console.log('     blurb ', JSON.stringify(Lore.poiBlurb(k, kind)));
  }
  for (const k of ['mark/1', 'mark/2', 'mark/3']) {
    console.log('  bounty   ', JSON.stringify(Lore.bounty(k)));
  }
  for (const k of ['ship/1', 'ship/2', 'ship/3']) {
    console.log('  ship     ', JSON.stringify(Lore.shipName(k)));
  }
  console.log('  toast    ', JSON.stringify(Lore.discovery('anomaly')));
  console.log('  --- narration ---');
  for (const k of ['nursery', 'galaxy', 'black hole', 'u/g7/s3/p2', 'discovery', 'u/g3/s1']) {
    console.log('  narrate/' + k.padEnd(12), JSON.stringify(Lore.narrate(k)));
  }
}

process.exit(failed ? 1 : 0);
