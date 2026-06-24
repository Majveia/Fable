'use strict';
// FABLE: DRIFTER — the playable loop in real Chromium: boot, fly, fast-
// travel to a merged-sandbox landmark, scan a POI (discovery logged),
// accept a bounty, open the codex, and confirm discoveries persist a
// reload. Run: node test/drifter.browser.test.js
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(url);
  await page.waitForTimeout(5000);

  // boot
  const boot = await page.evaluate(() => ({
    hud: !!document.getElementById('hud'),
    landmarks: window.Landmarks ? window.Landmarks.list().length : -1,
    ship: !!window.Ship, bodies: window.Bodies ? window.Bodies.n : -1,
    nav: !!(window.Navigator && window.Navigator.active),
  }));
  check(boot.hud, 'cockpit HUD present');
  check(boot.landmarks >= 7, 'sandboxes merged in as landmarks', boot.landmarks + '');
  check(boot.ship && boot.nav && boot.bodies > 0, 'ship + universe live', boot.bodies + ' bodies');

  // fly
  await page.keyboard.down('w'); await sleep(1200); await page.keyboard.up('w');
  const sp = await page.evaluate(() => window.Ship.state.speed);
  check(sp > 1, 'thrust accelerates the ship', sp.toFixed(1) + ' u/s');

  // fast-travel to a named landmark (a merged sandbox) and confirm we're there
  const lm = await page.evaluate(async () => {
    const list = window.Landmarks.list();
    const sys = list.find((l) => l.kind === 'system') || list[0];
    const node = window.Cosmos.root.children().find((c) => c.id === sys.id);
    window.Navigator.focusNode(node);
    return { name: sys.name, id: sys.id };
  });
  await sleep(700);
  const atLm = await page.evaluate(() => window.Navigator.active.id);
  check(atLm === lm.id, 'fast-travel jumps to the landmark', lm.name + ' (' + atLm + ')');

  // scan a POI: orbit-cam, aim at it, hold F
  await page.keyboard.press('c'); await page.keyboard.press('c'); // chase->cockpit->orbit
  await sleep(200);
  const poiName = await page.evaluate(() => {
    const ps = window.POI.forNode(window.Navigator.active);
    if (!ps.length) return null;
    const p = ps[0];
    window.Camera3D.setGoal({ targetX: p.localPos[0], targetY: p.localPos[1],
      targetZ: p.localPos[2], dist: Math.max(p.radius * 5, 30) });
    return p.name;
  });
  check(!!poiName, 'active landmark has scannable POIs', poiName || 'none');
  // wait for the orbit camera to ease onto the POI (reticle within range)
  const onTarget = () => page.evaluate(() => {
    const W = innerWidth, H = innerHeight, vp = Camera3D.viewProj(W / H);
    const ps = POI.forNode(Navigator.active); let bd = 1e9;
    for (const q of ps) { const lp = q.localPos;
      const cw = vp[3]*lp[0]+vp[7]*lp[1]+vp[11]*lp[2]+vp[15]; if (cw <= 0.05) continue;
      const sx = ((vp[0]*lp[0]+vp[4]*lp[1]+vp[8]*lp[2]+vp[12])/cw*0.5+0.5)*W;
      const sy = (1-((vp[1]*lp[0]+vp[5]*lp[1]+vp[9]*lp[2]+vp[13])/cw*0.5+0.5))*H;
      bd = Math.min(bd, Math.hypot(sx-W/2, sy-H/2)); }
    return bd < Math.min(W, H) * 0.15;
  });
  for (let i = 0; i < 12 && !(await onTarget()); i++) await sleep(250);
  const before = await page.evaluate(() => window.Drifter.discoveries.length);
  await page.keyboard.down('f');
  let after = before;
  for (let i = 0; i < 24 && after <= before; i++) { await sleep(250);
    after = await page.evaluate(() => window.Drifter.discoveries.length); }
  await page.keyboard.up('f');
  check(after > before, 'sustained scan logs a discovery', before + ' -> ' + after);

  // bounty + codex
  await page.keyboard.press('j'); await sleep(150);
  const bounty = await page.evaluate(() => window.Drifter.activeBounty && window.Drifter.activeBounty.name);
  check(!!bounty, 'accept a bounty', bounty || 'none');
  await page.keyboard.press('Tab'); await sleep(300);
  const codexOpen = await page.evaluate(() => document.getElementById('hud-codex').classList.contains('open'));
  check(codexOpen, 'codex opens');

  // persist discoveries across reload
  await page.evaluate(() => window.Drifter && window.Persist.save({
    seed: window.Cosmos.seed, clockMyr: window.Cosmos.clockMyr, edits: [],
    game: window.Drifter.serialize() }));
  await page.reload();
  await page.waitForTimeout(5000);
  const restored = await page.evaluate(() => window.Drifter ? window.Drifter.discoveries.length : -1);
  check(restored >= after, 'discoveries persist across reload', restored + '');

  check(errors.length === 0, 'no page errors across the whole session', errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log(failed ? '\nFAILED' : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})();
