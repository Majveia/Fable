'use strict';
/* ============================================================
   FABLE UNIVERSE v5 — boot chain, engine select, loop, input, UI
   Boot order: WebGPU (compute + WGSL renderer, up to 2M bodies)
   -> WebGL2 hybrid (524k) -> CPU. A canvas claimed by WebGPU can
   never open a WebGL context, so the fallback swaps in a fresh
   canvas element.
   ============================================================ */
(async () => {

let canvas = document.getElementById('space');
let renderer = null, engine = null, modeTag = 'cpu';
let wgpuOK = false, gpuOK = false;
let MAX_BODIES = Bodies.CAP;

// Self-healing: if the WebGPU path ever failed on this device, a flag
// was set and we skip it entirely (the canvas would already be claimed,
// so recovery from a mid-flight failure is a reload into WebGL).
let noWebGPU = false;
try { noWebGPU = sessionStorage.getItem('fable-no-webgpu') === '1'; } catch {}
function bailToWebGL(e) {
  console.warn('WebGPU path failed — reloading into WebGL:', e);
  try { sessionStorage.setItem('fable-no-webgpu', '1'); } catch {}
  location.reload();
}

if (!noWebGPU && globalThis.WGPU && globalThis.PhysicsWGPU && globalThis.RendererWGPU) {
  try {
    const w = await WGPU.boot(canvas);
    if (w) {
      const cap = Math.min(w.maxBodiesCap || (1 << 21), 1 << 21);
      if (PhysicsWGPU.init(w, { maxBodies: cap }) && RendererWGPU.init(w)) {
        renderer = RendererWGPU; engine = PhysicsWGPU;
        wgpuOK = true; modeTag = 'webgpu'; MAX_BODIES = cap;
        Bodies.ensureCap(cap);
      }
    }
  } catch (e) { console.warn('WebGPU boot failed, falling back:', e); }
  if (!wgpuOK) {
    const fresh = canvas.cloneNode(false);
    canvas.replaceWith(fresh);
    canvas = fresh;
  }
}

if (!wgpuOK) {
  const mode = Renderer3D.init(canvas);
  if (!mode) {
    document.getElementById('nogl').style.display = 'flex';
    return;
  }
  renderer = Renderer3D;
  const gl = canvas.getContext('webgl2');
  gpuOK = !!(globalThis.PhysicsGPU && gl &&
             PhysicsGPU.init(gl, { maxBodies: 1 << 19 }));
  engine = gpuOK ? PhysicsGPU : Physics;
  modeTag = gpuOK ? 'gpu' : 'cpu';
  MAX_BODIES = gpuOK ? 1 << 19 : Bodies.CAP;
}

let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  renderer.resize(W, H, DPR);
}
window.addEventListener('resize', resize);

// WebGPU probation: until the new path has survived its first ~3 s of
// real frames on this device, ANY error reloads into the proven WebGL
// path. Unexecuted-driver-combination insurance.
let probation = wgpuOK;
if (probation) {
  window.addEventListener('error', (e) => { if (probation) bailToWebGL(e.error || e.message); });
  window.addEventListener('unhandledrejection', (e) => { if (probation) bailToWebGL(e.reason); });
}
try {
  resize();
} catch (e) {
  if (probation) { bailToWebGL(e); return; }
  throw e;
}

// ------------------------------------------------------------ state
let trails = false;
let lightPos = { x: 0, y: 0, z: 0 };
let scenarioIdx = 0;
let fpsSmooth = 60;
let pulling = false;
let lastSimT = 0;        // evolution clock, in sim-t units
let frameNo = 0;
let followSlot = -1;     // click-to-focus body slot, -1 = free camera

// Shareable state: #s=<scenario>&seed=<n>&dm=<0|1>&ts=<speed>
const boot = {};
for (const kv of location.hash.replace(/^#/, '').split('&')) {
  const [k, v] = kv.split('=');
  if (k) boot[k] = decodeURIComponent(v || '');
}
let hashTimer = 0;
function updateHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const sc = Scenarios.list[scenarioIdx];
    const h = '#s=' + sc.key + '&seed=' + Scenarios.lastSeed +
              '&dm=' + (DarkMatter.on ? 1 : 0) +
              '&ts=' + engine.cfg.timeScale.toFixed(1);
    history.replaceState(null, '', h);
  }, 400);
}

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1800);
}

function loadScenario(i, seed) {
  scenarioIdx = (i + Scenarios.list.length) % Scenarios.list.length;
  const sc = Scenarios.list[scenarioIdx];
  followSlot = -1;
  $('focus').textContent = '';
  Bodies.clear();
  Physics.cfg.t = 0;
  Physics.cfg.timeScale = engine.cfg.timeScale; // keep user's speed setting
  Physics.cfg.theta2 = Physics.cfg.theta2Base;
  engine.clearPull();
  const ret = sc.init({ gpu: wgpuOK || gpuOK,
                        maxBodies: (wgpuOK || gpuOK) ? MAX_BODIES - 128 : Bodies.CAP }, seed);
  if (wgpuOK) {
    Object.assign(PhysicsWGPU.cfg, Physics.cfg);
    PhysicsWGPU.upload();
    RendererWGPU.setSource({
      posBuf: PhysicsWGPU.posBuf,
      velBuf: PhysicsWGPU.velBuf,
      attribBuf: PhysicsWGPU.attribBuf,
      count: PhysicsWGPU.count,
      massiveCount: PhysicsWGPU.massiveCount,
    });
  } else if (gpuOK) {
    // Scenarios write Physics.cfg; mirror it into the GPU engine.
    Object.assign(PhysicsGPU.cfg, Physics.cfg);
    PhysicsGPU.upload();
    Renderer3D.setSource({
      mode: 'texture',
      posTex: () => PhysicsGPU.posTex,   // ping-pong: identity changes per frame
      count: PhysicsGPU.count,
      massiveCount: PhysicsGPU.massiveCount,
      staticAttribs: PhysicsGPU.staticAttribs,
    });
  } else if (Renderer3D.setSource) {
    Renderer3D.setSource({ mode: 'arrays' });
  }
  if (globalThis.Evolution) Evolution.reset(engine.evolutionView(), 42 + scenarioIdx);
  lastSimT = 0;
  lightPos = ret.lightPos || { x: 0, y: 0, z: 0 };
  Camera3D.setGoal({ targetX: 0, targetY: 0, targetZ: 0,
                     dist: ret.camDist, yaw: -0.7, pitch: 0.42 });
  toast(sc.label);
  updateHash();
  document.querySelectorAll('#dots span').forEach((d, k) =>
    d.classList.toggle('on', k === scenarioIdx));
}

// ------------------------------------------------------------ focal-plane ray
// World point under the cursor at the camera's focal distance —
// where dropped black holes and the gravity well land.
function focalPoint(sx, sy) {
  const eye = Camera3D.eye();
  const t = Camera3D.target;
  let fx = t.x - eye.x, fy = t.y - eye.y, fz = t.z - eye.z;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  let rx = fz, ry = 0, rz = -fx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  const tanF = Math.tan((Camera3D.fov || 0.96) / 2);
  const ndx = (2 * sx / W - 1) * tanF * (W / H);
  const ndy = (1 - 2 * sy / H) * tanF;
  let dx = fx + rx * ndx - ux * ndy;
  let dy = fy + ry * ndx - uy * ndy;
  let dz = fz + rz * ndx - uz * ndy;
  const dl = Math.hypot(dx, dy, dz);
  dx /= dl; dy /= dl; dz /= dl;
  const D = Camera3D.dist;
  return { x: eye.x + dx * D, y: eye.y + dy * D, z: eye.z + dz * D };
}

function dropBlackHole(sx, sy) {
  const p = focalPoint(sx, sy);
  if (engine.addMassive) {
    if (engine.addMassive(p.x, p.y, p.z, 0, 0, 0, 6000, 3, 8, Bodies.TYPE_BH) < 0) {
      toast('NO FREE SLOTS'); return;
    }
  } else {
    Bodies.add(p.x, p.y, p.z, 0, 0, 0, 6000, 3, 8, Bodies.TYPE_BH, null);
  }
  toast('BLACK HOLE');
}

// ------------------------------------------------------------ click-to-focus
// Pick the massive body nearest the click in screen space (the CPU
// mirror always holds the massive set, in both engine modes).
function pickBody(sx, sy) {
  const vp = Camera3D.viewProj(W / H);
  let best = -1, bestD = 28 * 28, bestW = Infinity;
  for (let i = 0; i < Bodies.n; i++) {
    if (Bodies.mass[i] <= 0 || Bodies.type[i] === 255) continue;
    const x = Bodies.px[i], y = Bodies.py[i], z = Bodies.pz[i];
    const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (cw < 0.1) continue;
    const cx = (vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw;
    const cy = (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw;
    const dx = (cx * 0.5 + 0.5) * W - sx;
    const dy = (1 - (cy * 0.5 + 0.5)) * H - sy;
    const d = dx * dx + dy * dy;
    if (d < bestD || (d < bestD * 1.2 && cw < bestW)) {
      if (d < bestD) { bestD = Math.max(d, 36); }
      best = i; bestW = cw;
    }
  }
  return best;
}

function focusLabel(i) {
  if (i < 0) { $('focus').textContent = ''; return; }
  const kind = ['star', 'black hole', 'planet', 'dust', 'gas'][Bodies.type[i]] || '';
  const name = Bodies.names[i] || kind;
  $('focus').textContent = '◉ ' + name + ' · m ' + Bodies.mass[i].toFixed(1);
}

// ------------------------------------------------------------ pointer input
const ptr = { down: false, button: 0, x: 0, y: 0, shift: false, downX: 0, downY: 0 };
const touches = new Map();
let pinchDist = 0;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    return;
  }
  ptr.down = true; ptr.button = e.button; ptr.shift = e.shiftKey;
  ptr.x = e.clientX; ptr.y = e.clientY;
  ptr.downX = e.clientX; ptr.downY = e.clientY;
  if (globalThis.Sound) Sound.poke();
});

canvas.addEventListener('pointermove', (e) => {
  wake();
  if (e.pointerType === 'touch') {
    const t = touches.get(e.pointerId);
    if (!t) return;
    if (touches.size === 1) {
      Camera3D.orbit((e.clientX - t.x) * 0.005, (e.clientY - t.y) * 0.005);
    } else if (touches.size === 2) {
      t.x = e.clientX; t.y = e.clientY;
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) Camera3D.dolly(pinchDist / d);
      pinchDist = d;
      return;
    }
    t.x = e.clientX; t.y = e.clientY;
    return;
  }
  const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
  ptr.x = e.clientX; ptr.y = e.clientY;
  if (!ptr.down) return;
  if (ptr.button === 2 || ptr.shift) Camera3D.pan(dx, dy, H);
  else Camera3D.orbit(dx * 0.005, dy * 0.005);
});

const endPointer = (e) => {
  touches.delete(e.pointerId);
  if (touches.size < 2) pinchDist = 0;
  // A click (not a drag) selects and tracks a body.
  if (ptr.down && e.pointerType !== 'touch' && e.button === 0 &&
      Math.hypot(e.clientX - ptr.downX, e.clientY - ptr.downY) < 6) {
    followSlot = pickBody(e.clientX, e.clientY);
    focusLabel(followSlot);
    if (followSlot >= 0) toast('TRACKING');
  }
  ptr.down = false;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  wake();
  Camera3D.dolly(Math.exp(e.deltaY * 0.0011));
}, { passive: false });

// ------------------------------------------------------------ keys
window.addEventListener('keydown', (e) => {
  wake();
  if (e.repeat && e.key !== '[' && e.key !== ']') return;
  switch (e.key) {
    case ' ': e.preventDefault(); engine.cfg.paused = !engine.cfg.paused;
      toast(engine.cfg.paused ? 'PAUSED' : 'RESUMED'); break;
    case 't': trails = !trails; toast(trails ? 'TRAILS ON' : 'TRAILS OFF'); break;
    case 'r': loadScenario(scenarioIdx); break;
    case '[': engine.cfg.timeScale = Math.max(0, +(engine.cfg.timeScale - 0.1).toFixed(1));
      toast('TIME ' + engine.cfg.timeScale.toFixed(1) + 'x'); break;
    case ']': engine.cfg.timeScale = Math.min(3, +(engine.cfg.timeScale + 0.1).toFixed(1));
      toast('TIME ' + engine.cfg.timeScale.toFixed(1) + 'x'); updateHash(); break;
    case 'b':
      dropBlackHole(ptr.x || W / 2, ptr.y || H / 2);
      if (globalThis.Sound) Sound.thud();
      break;
    case 'g': pulling = true; break;
    case 'd':
      DarkMatter.on = !DarkMatter.on;
      toast(DarkMatter.on ? 'DARK MATTER ON' : 'DARK MATTER OFF');
      updateHash();
      break;
    case 'm':
      if (globalThis.Sound) { Sound.poke(); toast(Sound.toggleMute() ? 'MUTED' : 'SOUND ON'); }
      break;
    case 'Escape':
      followSlot = -1; focusLabel(-1);
      break;
    case 'h': case '?': $('help').classList.toggle('show'); break;
    case 'f':
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
      break;
    case 'ArrowRight': loadScenario(scenarioIdx + 1); break;
    case 'ArrowLeft': loadScenario(scenarioIdx - 1); break;
    default: {
      const k = parseInt(e.key, 10);
      if (k >= 1 && k <= Scenarios.list.length) loadScenario(k - 1);
    }
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'g') { pulling = false; engine.clearPull(); }
});

// ------------------------------------------------------------ idle fade
let idleTimer = null;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
}
wake();

// ------------------------------------------------------------ scenario dots
const dots = $('dots');
Scenarios.list.forEach((sc, i) => {
  const d = document.createElement('span');
  d.title = sc.label;
  d.addEventListener('click', () => loadScenario(i));
  dots.appendChild(d);
});

// ------------------------------------------------------------ loop
let last = performance.now();
function frame(now) {
  const dtMs = Math.min(now - last, 50);
  last = now;
  fpsSmooth += (1000 / Math.max(dtMs, 1) - fpsSmooth) * 0.05;
  frameNo++;

  if (pulling) {
    const p = focalPoint(ptr.x || W / 2, ptr.y || H / 2);
    engine.setPull(p.x, p.y, p.z, 30000);
  }

  if (probation) {
    try {
      engine.frame();
      renderer.render({
        viewProj: Camera3D.viewProj(W / H),
        eye: Camera3D.eye(),
        lightPos, trails, timeMs: now,
        blackHoles: engine.blackHoleList(),
        attribsVersion: engine.attribsVersion || 0,
      });
      if (frameNo > 180) probation = false;       // survived: trust it
    } catch (e) { bailToWebGL(e); return; }
    Camera3D.update(dtMs);
    engine.adaptQuality(fpsSmooth);
    requestAnimationFrame(frame);
    return;
  }

  engine.frame();
  engine.adaptQuality(fpsSmooth);

  // Stellar evolution: every 10 frames, advance by accumulated sim-Myr.
  if (globalThis.Evolution && frameNo % 10 === 0 && !engine.cfg.paused) {
    const t = engine.cfg.t;
    const dtMyr = (t - lastSimT) * engine.cfg.myrPerT;
    lastSimT = t;
    if (dtMyr > 0) {
      Evolution.step(engine.evolutionView(), dtMyr);
      // Supernovae leave expanding remnant shells (and a chime).
      const ev = Evolution.lastEvents;
      for (let k = 0; k < Math.min(ev.length, 4); k++) {
        const i = ev[k];
        engine.addBurst(Bodies.px[i], Bodies.py[i], Bodies.pz[i],
                        Bodies.vx[i], Bodies.vy[i], Bodies.vz[i], 90);
        if (globalThis.Sound && k < 2) Sound.supernova();
      }
    }
  }

  // Click-to-focus: glue the camera target to the tracked body.
  if (followSlot >= 0) {
    if (followSlot < Bodies.n && Bodies.mass[followSlot] > 0 &&
        Bodies.type[followSlot] !== 255) {
      Camera3D.setGoal({
        targetX: Bodies.px[followSlot],
        targetY: Bodies.py[followSlot],
        targetZ: Bodies.pz[followSlot],
      });
    } else {
      followSlot = -1; focusLabel(-1);   // tracked body died
    }
  }

  Camera3D.update(dtMs);
  renderer.render({
    viewProj: Camera3D.viewProj(W / H),
    eye: Camera3D.eye(),
    lightPos, trails, timeMs: now,
    blackHoles: engine.blackHoleList(),
    attribsVersion: engine.attribsVersion || 0,
  });
  requestAnimationFrame(frame);
}

setInterval(() => {
  if (globalThis.Sound) Sound.setScale(Camera3D.dist);
  if (followSlot >= 0) focusLabel(followSlot);
  $('stat').textContent =
    engine.bodyCount().toLocaleString() + ' bodies · ' +
    engine.simTimeMyr().toFixed(1) + ' Myr · ' +
    Math.round(fpsSmooth) + ' fps · ' + modeTag;
}, 400);

if (boot.dm !== undefined) DarkMatter.on = boot.dm !== '0';
if (boot.ts !== undefined) engine.cfg.timeScale = Math.max(0, Math.min(3, +boot.ts || 1));
const bootIdx = Math.max(0, Scenarios.list.findIndex(sc => sc.key === boot.s));
try {
  loadScenario(bootIdx, boot.seed !== undefined ? (+boot.seed >>> 0) : undefined);
} catch (e) {
  if (probation) { bailToWebGL(e); return; }
  throw e;
}
requestAnimationFrame(frame);
})();
