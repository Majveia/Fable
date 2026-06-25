'use strict';
/* ============================================================
   FABLE: DRIFTER — Surface terrain generator tests (pure Node, no DOM).
   Run: node test/surface.test.js   (exit 1 on any failure)

   Loads js/game/surface.js via indirect-eval-to-global (matching
   test/shipmodel.test.js / test/smoke.js) so globalThis.Surface
   exists. Verifies the shared Surface descriptor contract:
   determinism, mesh layout/normals, heightAt finiteness + match to
   the mesh, sky fields, marker palette indices, archetype variety.
   ============================================================ */

const fs = require('fs');
const path = require('path');

(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js/game/surface.js'), 'utf8'));

const { Surface } = globalThis;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
  if (cond) passed++; else failed++;
}

const ARCHES = ['rocky', 'lava', 'ice', 'desert', 'ocean', 'gas', 'barren'];
const finite = (v) => typeof v === 'number' && isFinite(v);
const finiteArr = (a, n) => Array.isArray(a) && a.length === n && a.every(finite);

// ---------------------------------------------------------- (0) module shape
{
  check('Surface.generate is a function', typeof Surface.generate === 'function');
  check('Surface.archetypes lists the 7 archetypes',
    Array.isArray(Surface.archetypes) && ARCHES.every(a => Surface.archetypes.includes(a)),
    Surface.archetypes.join(','));
}

// per-archetype descriptor checks
for (const arch of ARCHES) {
  const S = Surface.generate({ archetype: arch, seed: 12345, radius: 1, colorIdx: 3 });

  // ---- archetype + extent ----
  check(arch + ': archetype echoed', S.archetype === arch, S.archetype);
  check(arch + ': extent positive ~900..1500', finite(S.extent) && S.extent >= 900 && S.extent <= 1500,
    'extent=' + S.extent);

  // ---- mesh layout ----
  const m = S.mesh;
  check(arch + ': mesh.tris is Float32Array', m.tris instanceof Float32Array);
  check(arch + ': mesh.norms is Float32Array', m.norms instanceof Float32Array);
  check(arch + ': mesh.triColor is Float32Array', m.triColor instanceof Float32Array);
  check(arch + ': tris.length % 9 === 0', m.tris.length % 9 === 0, 'len=' + m.tris.length);
  check(arch + ': norms.length === tris.length', m.norms.length === m.tris.length,
    'tris=' + m.tris.length + ' norms=' + m.norms.length);
  const nTri = m.tris.length / 9;
  check(arch + ': triColor.length === tris.length/3', m.triColor.length === nTri * 3,
    'triColor=' + m.triColor.length + ' expected=' + (nTri * 3));
  check(arch + ': tri count in budget (~8k..18k)', nTri >= 4000 && nTri <= 20000, 'tris=' + nTri);

  // ---- all values finite ----
  let allFin = true;
  for (let i = 0; i < m.tris.length; i++) if (!isFinite(m.tris[i]) || !isFinite(m.norms[i])) { allFin = false; break; }
  for (let i = 0; i < m.triColor.length; i++) if (!isFinite(m.triColor[i])) { allFin = false; break; }
  check(arch + ': all tri/norm/color values finite', allFin);

  // ---- normals approximately unit + up-ish ----
  let unitOk = true, worst = 0, upOk = true;
  for (let i = 0; i < m.norms.length; i += 3) {
    const l = Math.hypot(m.norms[i], m.norms[i + 1], m.norms[i + 2]);
    const e = Math.abs(l - 1);
    if (e > worst) worst = e;
    if (e > 1e-3) unitOk = false;
    if (m.norms[i + 1] < -1e-6) upOk = false; // +Y component never negative
  }
  check(arch + ': all normals ~unit (<=1e-3)', unitOk, 'worst=' + worst.toExponential(2));
  check(arch + ': all normals up-ish (ny>=0)', upOk);

  // ---- vertices stay within the extent square (X/Z) ----
  let inBox = true;
  for (let i = 0; i < m.tris.length; i += 3) {
    if (Math.abs(m.tris[i]) > S.extent + 1e-3 || Math.abs(m.tris[i + 2]) > S.extent + 1e-3) { inBox = false; break; }
  }
  check(arch + ': terrain vertices within the extent square', inBox);

  // ---- heightAt finite across the extent ----
  let hFin = true;
  for (let gx = -1; gx <= 1; gx += 0.25) {
    for (let gz = -1; gz <= 1; gz += 0.25) {
      const h = S.heightAt(gx * S.extent, gz * S.extent);
      if (!isFinite(h)) { hFin = false; break; }
    }
  }
  // also far outside the extent
  if (!isFinite(S.heightAt(99999, -99999))) hFin = false;
  check(arch + ': heightAt finite across & beyond extent', hFin);

  // ---- heightAt roughly matches a mesh vertex near a sample point ----
  // Scan triangle first-vertices for the highest one (for ocean this avoids
  // submerged verts where heightAt legitimately floors at the water level for
  // collision); bilinear at a lattice vertex equals the stored height.
  {
    let bx = m.tris[0], by = m.tris[1], bz = m.tris[2];
    for (let i = 0; i < m.tris.length; i += 9) {
      if (m.tris[i + 1] > by) { bx = m.tris[i]; by = m.tris[i + 1]; bz = m.tris[i + 2]; }
    }
    const h = S.heightAt(bx, bz);
    check(arch + ': heightAt matches mesh vertex height',
      isFinite(h) && Math.abs(h - by) < 1.0,
      'h=' + h.toFixed(2) + ' vy=' + by.toFixed(2));
  }

  // ---- sky fields present + finite ----
  const sk = S.sky;
  const skyOk = finiteArr(sk.horizon, 3) && finiteArr(sk.zenith, 3) && finiteArr(sk.fog, 3) &&
    finite(sk.fogDensity) && finiteArr(sk.sun, 3) && finiteArr(sk.sunColor, 3) && finite(sk.ambient);
  check(arch + ': sky has horizon/zenith/fog/fogDensity/sun/sunColor/ambient', skyOk);
  const sl = Math.hypot(sk.sun[0], sk.sun[1], sk.sun[2]);
  check(arch + ': sky.sun is a unit vector', Math.abs(sl - 1) < 1e-3, 'len=' + sl.toFixed(4));
  check(arch + ': sky.ambient in [0,1]', sk.ambient >= 0 && sk.ambient <= 1, 'ambient=' + sk.ambient);

  // ---- spawn above the surface ----
  check(arch + ': spawn.pos finite, yaw 0', finiteArr(S.spawn.pos, 3) && S.spawn.yaw === 0);
  check(arch + ': spawn above ground at centre', S.spawn.pos[1] > S.heightAt(0, 0),
    'spawnY=' + S.spawn.pos[1].toFixed(1) + ' groundY=' + S.heightAt(0, 0).toFixed(1));

  // ---- markers: colorIdx in [0,17], finite positions ----
  check(arch + ': markers is an array', Array.isArray(S.markers) && S.markers.length > 0,
    'count=' + (S.markers && S.markers.length));
  let mOk = true;
  for (const mk of S.markers) {
    if (!finite(mk.x) || !finite(mk.y) || !finite(mk.z) || !finite(mk.size)) { mOk = false; break; }
    if (!Number.isInteger(mk.colorIdx) || mk.colorIdx < 0 || mk.colorIdx > 17) { mOk = false; break; }
  }
  check(arch + ': every marker has finite pos/size and colorIdx in [0,17]', mOk);
}

// ---------------------------------------------------------- determinism
{
  const a = Surface.generate({ archetype: 'rocky', seed: 777, radius: 1 });
  const b = Surface.generate({ archetype: 'rocky', seed: 777, radius: 1 });
  check('same seed -> identical tri count', a.mesh.tris.length === b.mesh.tris.length,
    a.mesh.tris.length + ' vs ' + b.mesh.tris.length);
  let same30 = true;
  for (let i = 0; i < 30; i++) if (a.mesh.tris[i] !== b.mesh.tris[i]) { same30 = false; break; }
  check('same seed -> identical first 30 mesh floats', same30);
  let sameAll = a.mesh.tris.length === b.mesh.tris.length;
  if (sameAll) for (let i = 0; i < a.mesh.tris.length; i++) if (a.mesh.tris[i] !== b.mesh.tris[i]) { sameAll = false; break; }
  check('same seed -> byte-for-byte identical mesh', sameAll);
  // heightAt deterministic too
  check('same seed -> identical heightAt(123,-45)',
    a.heightAt(123, -45) === b.heightAt(123, -45));
}

// ---------------------------------------------------------- different seeds differ
{
  const a = Surface.generate({ archetype: 'rocky', seed: 1 });
  const b = Surface.generate({ archetype: 'rocky', seed: 2 });
  let diff = false;
  for (let i = 0; i < a.mesh.tris.length; i++) if (a.mesh.tris[i] !== b.mesh.tris[i]) { diff = true; break; }
  check('different seed -> different terrain', diff);
}

// ---------------------------------------------------------- different archetypes differ
{
  const rocky = Surface.generate({ archetype: 'rocky', seed: 5 });
  const ice = Surface.generate({ archetype: 'ice', seed: 5 });
  // different height field
  let geoDiff = false;
  const nn = Math.min(rocky.mesh.tris.length, ice.mesh.tris.length);
  for (let i = 1; i < nn; i += 3) if (Math.abs(rocky.mesh.tris[i] - ice.mesh.tris[i]) > 1e-6) { geoDiff = true; break; }
  check('rocky vs ice: terrain geometry differs', geoDiff);
  // different sky
  check('rocky vs ice: sky differs',
    JSON.stringify(rocky.sky.zenith) !== JSON.stringify(ice.sky.zenith));
}

// ---------------------------------------------------------- lava emissive cracks
{
  const lava = Surface.generate({ archetype: 'lava', seed: 9 });
  let maxC = 0;
  const c = lava.mesh.triColor;
  for (let i = 0; i < c.length; i++) if (c[i] > maxC) maxC = c[i];
  check('lava has emissive (>1) crack colours', maxC > 1, 'maxChannel=' + maxC.toFixed(2));
}

// ---------------------------------------------------------- unknown archetype falls back
{
  const u = Surface.generate({ archetype: 'banana', seed: 1 });
  check('unknown archetype falls back to a valid one',
    Surface.archetypes.includes(u.archetype), u.archetype);
}

console.log('\n' + (failed === 0 ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED') +
  '  (' + passed + '/' + (passed + failed) + ')');
process.exit(failed ? 1 : 0);
