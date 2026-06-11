'use strict';
// WebGPU-path test: adapter-tolerant. Headless environments often lack
// WebGPU entirely (navigator.gpu absent) — in that case this SKIPS
// (exit 0 with a notice) and additionally verifies the FALLBACK: the
// app must still boot into the WebGL path with zero page errors.
// Run: node test/wgpu.browser.test.js

let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/tmp/node_modules/playwright')); }
const path = require('path');
const fs = require('fs');

let failed = false;
const check = (cond, msg, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg + (extra ? `  [${extra}]` : ''));
  if (!cond) failed = true;
};

const FLAG_COMBOS = [
  ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
  ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'],
];

async function findAdapter() {
  for (const args of FLAG_COMBOS) {
    let browser;
    try {
      browser = await chromium.launch({ args });
      const page = await browser.newPage();
      const ok = await page.evaluate(async () => {
        if (!navigator.gpu) return false;
        const a = await navigator.gpu.requestAdapter().catch(() => null);
        if (!a) return false;
        return !!(await a.requestDevice().catch(() => null));
      });
      if (ok) return { browser, args };
      await browser.close();
    } catch { if (browser) await browser.close().catch(() => {}); }
  }
  return null;
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const found = await findAdapter();

  if (!found) {
    console.log('SKIP  no WebGPU adapter in this environment — verifying fallback instead');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('file://' + path.join(root, 'index.html'));
    await page.waitForTimeout(6000);
    const stat = await page.evaluate(() => document.getElementById('stat').textContent);
    check(/gpu|cpu/.test(stat), 'fallback boots without WebGPU', stat);
    check(errors.length === 0, 'fallback: no page errors', errors.slice(0, 3).join('; '));
    await browser.close();
    console.log(failed ? '\nFAILED' : '\nALL PASS (webgpu skipped)');
    process.exit(failed ? 1 : 0);
  }

  console.log('WebGPU adapter found with flags:', JSON.stringify(found.args));
  const browser = found.browser;

  // ---- 1. compute harness: analytic orbit on the WebGPU engine
  {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('file://' + path.join(root, 'dev/wgpu-harness.html'));
    await page.waitForFunction(() => window.__result, { timeout: 300000 });
    const r = await page.evaluate(() => window.__result);
    if (r.skipped) {
      check(false, 'harness skipped despite adapter', r.reason);
    } else {
      check(!r.error, 'harness ran', r.error || (r.log || []).join(' | '));
      check(r.finite === true, 'WebGPU orbit finite');
      check(r.radErr < 0.05, 'WebGPU circular orbit within 5% over 2 periods',
            `err ${(r.radErr * 100).toFixed(2)}%`);
      check(r.burstOk && r.bhSlot >= 0, 'remnant burst + runtime black hole');
    }
    check(errors.length === 0, 'harness: no page errors', errors.join('; '));
    await page.close();
  }

  // ---- 2. full app boots into webgpu mode, scenarios run clean
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('file://' + path.join(root, 'index.html'));
    await page.waitForTimeout(8000);
    const stat = await page.evaluate(() => document.getElementById('stat').textContent);
    check(/webgpu/.test(stat), 'WebGPU engine active', stat);
    const bodies = parseInt(stat.replace(/[^0-9]/g, ''), 10);
    check(bodies > 400000, 'galaxy runs >400k bodies in WebGPU mode', stat);
    for (let k = 2; k <= 8; k++) {
      await page.keyboard.press(String(k));
      await page.waitForTimeout(3000);
    }
    check(errors.length === 0, 'app: no page errors across all scenarios',
          errors.slice(0, 3).join('; '));
    await page.close();
  }

  await browser.close();
  console.log(failed ? '\nFAILED' : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})();
