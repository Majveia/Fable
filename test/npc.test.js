'use strict';
/* ============================================================
   FABLE: DRIFTER — NPC tests (pure Node, no DOM)
   Run: node test/npc.test.js   (exit 1 on any failure)
   Loads js/game/npc.js via indirect-eval-to-global (matching
   test/smoke.js / test/lore.test.js) so globalThis.NPC exists.
   ============================================================ */

const fs = require('fs');
const path = require('path');

for (const f of ['js/game/npc.js']) {
  (0, eval)(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
}

const { NPC } = globalThis;

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

// A spread of landmark names + ids to exercise every venue profile.
const PLACES = [
  'Sol', 'New Cygnus', 'The Maw', "Drifter's End", 'Omega', 'Orion Nursery',
  'Cosmic Dawn', 'Antennae',
  'u/lm/sol', 'u/lm/cygnus', 'u/lm/maw', 'u/lm/end', 'u/lm/omega',
  'The Velvet Sparrow', 'Cold Comfort Station', 'Last Call', 'Halcyon Depot',
  'Sector Bebop-7', 'Bootleg Squanch Gate', 'PSR Kepler-Veil III',
];

/* ---------------- module surface ---------------- */
{
  assert(!!NPC, 'NPC attached to globalThis');
  for (const fn of ['atLandmark', 'greeting', 'farewell', 'bark']) {
    assert(typeof NPC[fn] === 'function', 'NPC.' + fn + ' is a function');
  }
}

/* ---------------- atLandmark determinism (same name -> same roster) -------- */
{
  let detOk = true;
  for (const p of PLACES) {
    const a = NPC.atLandmark(p);
    const b = NPC.atLandmark(p);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      detOk = false;
      console.log('   roster mismatch for ' + JSON.stringify(p));
    }
  }
  assert(detOk, 'atLandmark deterministic: same name -> identical roster across two calls');

  // determinism also holds with an explicit count.
  let detCountOk = true;
  for (const p of PLACES) {
    if (JSON.stringify(NPC.atLandmark(p, 5)) !== JSON.stringify(NPC.atLandmark(p, 5))) detCountOk = false;
  }
  assert(detCountOk, 'atLandmark(name, count) deterministic for fixed count');
}

/* ---------------- rosters non-empty + explicit count honoured -------------- */
{
  let nonEmpty = true;
  for (const p of PLACES) {
    const r = NPC.atLandmark(p);
    if (!Array.isArray(r) || r.length < 1) nonEmpty = false;
  }
  assert(nonEmpty, 'every landmark yields a non-empty roster');

  assert(NPC.atLandmark('Sol', 4).length === 4, 'explicit count honoured (4)');
  assert(NPC.atLandmark('Sol', 1).length === 1, 'explicit count honoured (1)');
  // count is clamped to a sane band, never zero/negative.
  assert(NPC.atLandmark('Sol', 0).length >= 1, 'count 0 clamps up to >=1');
  assert(NPC.atLandmark('Sol', 999).length <= 12, 'huge count clamps to <=12');
}

/* ---------------- each NPC well-formed (name/species/role/lines) ----------- */
{
  let shapeOk = true, linesOk = true, colorOk = true, traitsOk = true;
  let minLines = Infinity, maxLines = 0;
  for (const p of PLACES) {
    for (const npc of NPC.atLandmark(p)) {
      if (!clean(npc.name) || !clean(npc.species) || !clean(npc.role) || !clean(npc.id)) shapeOk = false;
      if (!clean(npc.homeLandmark)) shapeOk = false;

      // lines: 2..4, each non-empty + leak-free.
      if (!Array.isArray(npc.lines) || npc.lines.length < 2) linesOk = false;
      else {
        let good = 0;
        for (const l of npc.lines) if (clean(l)) good++;
        if (good < 2) linesOk = false;
        minLines = Math.min(minLines, npc.lines.length);
        maxLines = Math.max(maxLines, npc.lines.length);
      }

      // portraitColorIdx in [0,17].
      if (!Number.isInteger(npc.portraitColorIdx) || npc.portraitColorIdx < 0 || npc.portraitColorIdx > 17) colorOk = false;

      // traits: a non-empty array of clean strings.
      if (!Array.isArray(npc.traits) || npc.traits.length < 1) traitsOk = false;
      else for (const t of npc.traits) if (!clean(t)) traitsOk = false;
    }
  }
  assert(shapeOk, 'each NPC has clean id/name/species/role/homeLandmark');
  assert(linesOk, 'each NPC has >=2 non-empty, leak-free lines');
  assert(minLines >= 2 && maxLines <= 4, 'line counts stay in [2,4] (min ' + minLines + ', max ' + maxLines + ')');
  assert(colorOk, 'portraitColorIdx is an integer in [0,17] for every NPC');
  assert(traitsOk, 'each NPC has a non-empty traits[] of clean strings');
}

/* ---------------- greeting / farewell / bark non-empty --------------------- */
{
  let gOk = true, fOk = true, bOk = true, detOk = true;
  for (const p of PLACES) {
    for (const npc of NPC.atLandmark(p)) {
      const g = NPC.greeting(npc), f = NPC.farewell(npc), b = NPC.bark(npc);
      if (!clean(g)) gOk = false;
      if (!clean(f)) fOk = false;
      if (!clean(b)) bOk = false;
      // deterministic per-npc.
      if (g !== NPC.greeting(npc) || f !== NPC.farewell(npc) || b !== NPC.bark(npc)) detOk = false;
    }
  }
  assert(gOk, 'greeting(npc) returns a non-empty, leak-free line for every NPC');
  assert(fOk, 'farewell(npc) returns a non-empty, leak-free line for every NPC');
  assert(bOk, 'bark(npc) returns a non-empty, leak-free line for every NPC');
  assert(detOk, 'greeting/farewell/bark deterministic per NPC');

  // graceful on a missing/garbage npc — never empty, never throws.
  assert(clean(NPC.greeting(null)) && clean(NPC.farewell(null)) && clean(NPC.bark(null)),
    'greeting/farewell/bark(null) still yield clean fallback lines');
  assert(clean(NPC.greeting({})) && clean(NPC.farewell({})),
    'greeting/farewell({}) still yield clean fallback lines');
}

/* ---------------- different landmarks give different rosters --------------- */
{
  // Roster "fingerprint" = ordered names. Distinct places should mostly differ.
  const fp = (p) => NPC.atLandmark(p).map((n) => n.name).join('|');
  const seen = new Set();
  let distinct = 0;
  for (const p of PLACES) {
    const f = fp(p);
    if (!seen.has(f)) { seen.add(f); distinct++; }
  }
  assert(distinct >= PLACES.length - 1, 'distinct landmarks give distinct rosters (' + distinct + '/' + PLACES.length + ')');

  // a couple of explicit pairwise differences.
  assert(fp('Sol') !== fp('The Maw'), 'Sol and The Maw have different crowds');
  assert(fp('u/lm/omega') !== fp('u/lm/cygnus'), 'Omega and New Cygnus have different crowds');
}

/* ---------------- species + role variety across a big sweep ---------------- */
{
  const species = new Set(), roles = new Set();
  let total = 0;
  for (let i = 0; i < 60; i++) {
    for (const npc of NPC.atLandmark('venue/' + i, 6)) {
      species.add(npc.species);
      roles.add(npc.role);
      total++;
    }
  }
  // every declared role and most species should appear over 360 NPCs.
  assert(roles.size >= 6, 'at least 6 distinct roles surface across the sweep (' + roles.size + ')');
  assert(species.size >= 4, 'at least 4 distinct species surface across the sweep (' + species.size + ')');
  // names shouldn't collapse to one string.
  const names = new Set();
  for (let i = 0; i < 60; i++) for (const npc of NPC.atLandmark('crowd/' + i, 6)) names.add(npc.name);
  assert(names.size >= 100, 'NPC names are richly varied (' + names.size + ' distinct over 360)');
}

/* ---------------- showcase (visual spot-check, not asserted) --------------- */
{
  console.log('--- sample rosters ---');
  for (const p of ['Sol', 'The Velvet Sparrow', 'Omega']) {
    console.log('  @ ' + p + ':');
    for (const npc of NPC.atLandmark(p)) {
      console.log('    [' + String(npc.portraitColorIdx).padStart(2) + '] ' + npc.name
        + ' — ' + npc.species + ' ' + npc.role);
      console.log('         traits: ' + npc.traits.join(', '));
      console.log('         greet : ' + NPC.greeting(npc));
      console.log('         line  : ' + JSON.stringify(npc.lines[0]));
      console.log('         bye   : ' + NPC.farewell(npc));
    }
  }
}

/* ---------------- v13 outpost crews ---------------- */
{
  assert(typeof NPC.atOutpost === 'function', 'NPC.atOutpost exists');
  const KINDS = ['homestead', 'relay', 'prospector camp', 'crashed ship'];
  const NAMES = ['Pale Hold', 'Dust Chapel', 'The Long Static', 'Marrow Flats'];
  let allDet = true, allShaped = true, allClean = true;
  for (const name of NAMES) {
    for (const kind of KINDS) {
      const a = NPC.atOutpost(name, kind);
      const b = NPC.atOutpost(name, kind);
      if (JSON.stringify(a) !== JSON.stringify(b)) allDet = false;
      if (!Array.isArray(a) || a.length < 1) allShaped = false;
      for (const npc of a) {
        if (!clean(npc.name) || !clean(npc.species) || !clean(npc.role)) allShaped = false;
        const good = Array.isArray(npc.lines) && npc.lines.filter(clean).length >= 2;
        if (!good) allShaped = false;
        if (!(npc.portraitColorIdx >= 0 && npc.portraitColorIdx <= 17)) allShaped = false;
        if (!clean(NPC.greeting(npc)) || !clean(NPC.farewell(npc))) allClean = false;
      }
    }
  }
  assert(allDet, 'atOutpost is deterministic per (name, kind)');
  assert(allShaped, 'outpost NPCs are well-shaped (name/species/role/>=2 lines/color 0-17)');
  assert(allClean, 'outpost greeting/farewell are clean non-empty strings');
  // different kind at the same name yields a different crew
  assert(JSON.stringify(NPC.atOutpost('Pale Hold', 'relay')) !==
         JSON.stringify(NPC.atOutpost('Pale Hold', 'crashed ship')),
    'outpost crew differs by kind');
  // the station API is untouched
  assert(Array.isArray(NPC.atLandmark('Sol')) && NPC.atLandmark('Sol').length > 0,
    'station atLandmark still works');

  console.log('\n  sample outpost — Pale Hold (crashed ship):');
  for (const npc of NPC.atOutpost('Pale Hold', 'crashed ship')) {
    console.log('    [' + String(npc.portraitColorIdx).padStart(2) + '] ' + npc.name +
      ' — ' + npc.species + ' ' + npc.role);
    console.log('         greet : ' + NPC.greeting(npc));
  }
}

if (!failed) console.log('ALL TESTS PASSED');
process.exit(failed ? 1 : 0);
