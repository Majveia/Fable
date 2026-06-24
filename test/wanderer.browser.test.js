'use strict';
// WANDERER (v8): walk the ship + fly it, each in first/third person, with the
// wireframe ship overlay, in real Chromium. Run: node test/wanderer.browser.test.js
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/tmp/node_modules/playwright')); }
const path = require('path');

let failed = false;
const check = (c, m, extra) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m + (extra ? '  [' + extra + ']' : '')); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const url = 'file://' + path.resolve(__dirname, '..', 'index.html');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(url);
  await page.waitForTimeout(5000);

  const boot = await page.evaluate(() => ({
    shipModel: !!window.ShipModel, avatar: !!window.Avatar,
    lines: window.ShipModel ? window.ShipModel.lines.length : 0,
    bounds: window.ShipModel ? window.ShipModel.bounds.length : 0,
  }));
  check(boot.shipModel && boot.avatar, 'ship model + avatar present');
  check(boot.lines > 0 && boot.lines % 6 === 0, 'ship wireframe geometry', boot.lines + ' floats');
  check(boot.bounds > 0, 'walkable interior bounds', boot.bounds + '');

  // fly a moment (third person) — the renderer should receive an overlay
  await page.keyboard.down('w'); await sleep(1000); await page.keyboard.up('w');
  // first person
  await page.keyboard.press('v'); await sleep(500);
  const flyView = await page.evaluate(() =>
    (document.getElementById('hud-nav').textContent.match(/FLY (FP|TP)/i) || [''])[0]);
  check(/fly/i.test(flyView), 'first/third person while flying', flyView);

  // X -> on foot; move the avatar; it must change position and stay in bounds
  await page.keyboard.press('x'); await sleep(500);
  const a0 = await page.evaluate(() => window.Avatar.state.pos.slice());
  await page.keyboard.down('w'); await sleep(1200); await page.keyboard.up('w');
  const res = await page.evaluate(() => {
    const pos = window.Avatar.state.pos, bs = window.ShipModel.bounds;
    const inB = bs.some((b) => pos[0] >= b.min[0] - .02 && pos[0] <= b.max[0] + .02 &&
      pos[1] >= b.min[1] - .02 && pos[1] <= b.max[1] + .02 &&
      pos[2] >= b.min[2] - .02 && pos[2] <= b.max[2] + .02);
    return { pos, inB };
  });
  const moved = Math.hypot(res.pos[0] - a0[0], res.pos[1] - a0[1], res.pos[2] - a0[2]);
  check(moved > 0.05, 'walking moves the avatar', moved.toFixed(2) + ' units');
  check(res.inB, 'avatar stays inside the ship', JSON.stringify(res.pos.map((x) => +x.toFixed(1))));

  // toggle walk first/third person
  await page.keyboard.press('v'); await sleep(400);
  const walkView = await page.evaluate(() =>
    (document.getElementById('hud-nav').textContent.match(/WALK (FP|TP)/i) || [''])[0]);
  check(/walk/i.test(walkView), 'first/third person on foot', walkView);

  // back to the helm
  await page.keyboard.press('x'); await sleep(400);
  const backFlying = await page.evaluate(() => /FLY/i.test(document.getElementById('hud-nav').textContent));
  check(backFlying, 'X returns to piloting');

  check(errors.length === 0, 'no page errors across walk + fly', errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log(failed ? '\nFAILED' : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})();
