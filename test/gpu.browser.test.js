'use strict';
// GPU-path test: runs the real engine in headless Chromium.
// (1) dev/gpu-harness.html — analytic orbit accuracy on the GPU.
// (2) index.html — GPU mode boots, all scenarios run without page errors.
// Run: node test/gpu.browser.test.js   (CI installs playwright + chromium)

let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/tmp/node_modules/playwright')); }
const path = require('path');

let failed = false;
const check = (cond, msg, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg + (extra ? `  [${extra}]` : ''));
  if (!cond) failed = true;
};

(async () => {
  const browser = await chromium.launch();
  const root = path.resolve(__dirname, '..');

  // ---- 1. orbit accuracy harness
  {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('file://' + path.join(root, 'dev/gpu-harness.html'));
    await page.waitForFunction(() => window.__result, { timeout: 240000 });
    const r = await page.evaluate(() => window.__result);
    check(!r.error, 'harness ran', r.error || r.log.join(' | '));
    check(r.finite === true, 'GPU orbit finite');
    check(r.radErr < 0.05, 'GPU circular orbit within 5% over 2 periods',
          `err ${(r.radErr * 100).toFixed(2)}%`);
    check(r.burstOk && r.bhSlot >= 0, 'remnant burst + runtime black hole');
    check(errors.length === 0, 'harness: no page errors', errors.join('; '));
    await page.close();
  }

  // ---- 2. full app: every scenario in GPU mode
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('file://' + path.join(root, 'index.html'));
    await page.waitForTimeout(5000);
    const stat = await page.evaluate(() => document.getElementById('stat').textContent);
    check(/gpu/.test(stat), 'GPU engine active', stat);
    const bodies = parseInt(stat.replace(/[^0-9]/g, ''), 10);
    check(bodies > 100000, 'galaxy runs >100k bodies in GPU mode', stat);
    for (let k = 2; k <= 8; k++) {
      await page.keyboard.press(String(k));
      await page.waitForTimeout(2500);
    }
    // interactions: track, drop a BH, toggle dark matter, trails
    await page.mouse.click(480, 300);
    await page.keyboard.press('b');
    await page.keyboard.press('d');
    await page.keyboard.press('t');
    await page.waitForTimeout(2000);
    check(errors.length === 0, 'app: no page errors across all scenarios',
          errors.slice(0, 3).join('; '));
    await page.close();
  }

  await browser.close();
  console.log(failed ? '\nFAILED' : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})();
