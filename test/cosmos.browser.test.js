'use strict';
// The persistent universe in real Chromium: boots into UNIVERSE mode,
// flies inward through galaxy -> system -> planet (driving the real
// Camera3D and letting the app's own loop navigate), then reloads and
// confirms the seed persisted. Run: node test/cosmos.browser.test.js

let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/tmp/node_modules/playwright')); }
const path = require('path');

let failed = false;
const check = (c, m, extra) => {
  console.log((c ? 'PASS  ' : 'FAIL  ') + m + (extra ? `  [${extra}]` : ''));
  if (!c) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const url = 'file://' + path.resolve(__dirname, '..', 'index.html');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(url);
  await page.waitForTimeout(5000);   // boot + first populate

  const bc0 = await page.evaluate(() => document.getElementById('hud-nav').textContent);
  check(/Universe/.test(bc0), 'boots into the persistent universe', bc0);
  const stat0 = await page.evaluate(() => document.getElementById('hud-nav').textContent);
  check(/Myr/.test(stat0), 'HUD shows the universe age', stat0);
  const bodies0 = await page.evaluate(() => window.Bodies ? window.Bodies.n : 0);
  check(bodies0 > 0, 'universe root populated', bodies0 + ' bodies');

  // Guided descent: each step aim the real camera at the active node's
  // first child and shrink dist; the app's rAF loop runs Navigator.update
  // and descends. Poll the breadcrumb depth.
  // Descend the LOD hierarchy by focusing the first non-landmark child at
  // each level (DRIFTER drives the camera from the ship, so we navigate via
  // the Navigator the way the in-game fast-travel / jump does). The app's
  // rAF loop repopulates on the active-node change.
  const depth = (s) => (s.match(/›/g) || []).length;
  let maxDepth = depth(bc0);
  const reached = [bc0];
  for (let level = 0; level < 3; level++) {
    const ok = await page.evaluate(() => {
      const a = window.Navigator && window.Navigator.active;
      if (!a || typeof a.children !== 'function') return false;
      const kids = a.children().filter((c) => !c.landmark);
      if (!kids.length) return false;
      window.Navigator.focusNode(kids[0]);
      return true;
    });
    if (!ok) break;
    await sleep(900);   // let the loop repopulate + HUD update
    const bc = await page.evaluate(() => document.getElementById('hud-nav').textContent);
    if (depth(bc) > maxDepth) { maxDepth = depth(bc); reached.push(bc); }
    const bodiesNow = await page.evaluate(() => window.Bodies ? window.Bodies.n : 0);
    check(bodiesNow > 0, `level ${level + 1}: populated after descent`, bodiesNow + ' bodies');
  }
  check(maxDepth >= 3, 'flew Universe -> Galaxy -> System -> Planet (4 levels)',
        reached[reached.length - 1]);

  // Persistence: the saved seed survives a reload.
  const seedBefore = await page.evaluate(async () => {
    if (window.Persist) await window.Persist.save(
      { seed: window.Cosmos.seed, clockMyr: window.Cosmos.clockMyr, edits: [] });
    return window.Cosmos.seed;
  });
  await page.reload();
  await page.waitForTimeout(5000);
  const seedAfter = await page.evaluate(() => window.Cosmos ? window.Cosmos.seed : -1);
  check(seedAfter === seedBefore, 'same universe restored after reload (seed persists)',
        seedBefore + ' -> ' + seedAfter);
  const bcReload = await page.evaluate(() => document.getElementById('hud-nav').textContent);
  check(/Universe/.test(bcReload), 'reload returns to the universe', bcReload);

  check(errors.length === 0, 'no page errors across the whole flight',
        errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log(failed ? '\nFAILED' : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})();
