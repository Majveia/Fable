'use strict';
/* ============================================================
   FABLE UNIVERSE v3 — boot, engine select, loop, input, UI
   ============================================================ */
(() => {

const canvas = document.getElementById('space');
const mode = Renderer3D.init(canvas);
if (!mode) {
  document.getElementById('nogl').style.display = 'flex';
  return;
}

// GPU compute engine if float-texture rendering is available; the same
// canvas context is shared (getContext returns the existing context).
const MAX_GPU_BODIES = 1 << 19;
const gl = canvas.getContext('webgl2');
const gpuOK = !!(globalThis.PhysicsGPU && gl &&
                 PhysicsGPU.init(gl, { maxBodies: MAX_GPU_BODIES }));
const engine = gpuOK ? PhysicsGPU : Physics;

let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  Renderer3D.resize(W, H, DPR);
}
window.addEventListener('resize', resize);
resize();

// ------------------------------------------------------------ state
let trails = false;
let lightPos = { x: 0, y: 0, z: 0 };
let scenarioIdx = 0;
let fpsSmooth = 60;
let pulling = false;
let lastSimT = 0;        // evolution clock, in sim-t units
let frameNo = 0;

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1800);
}

function loadScenario(i) {
  scenarioIdx = (i + Scenarios.list.length) % Scenarios.list.length;
  const sc = Scenarios.list[scenarioIdx];
  Bodies.clear();
  Physics.cfg.t = 0;
  Physics.cfg.timeScale = engine.cfg.timeScale; // keep user's speed setting
  Physics.cfg.theta2 = Physics.cfg.theta2Base;
  engine.clearPull();
  const ret = sc.init({ gpu: gpuOK, maxBodies: gpuOK ? MAX_GPU_BODIES - 128 : Bodies.CAP });
  if (gpuOK) {
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
  } else if (Renderer3D.setSource) {  // absent on pre-v3 renderers
    Renderer3D.setSource({ mode: 'arrays' });
  }
  if (globalThis.Evolution) Evolution.reset(engine.evolutionView(), 42 + scenarioIdx);
  lastSimT = 0;
  lightPos = ret.lightPos || { x: 0, y: 0, z: 0 };
  Camera3D.setGoal({ targetX: 0, targetY: 0, targetZ: 0,
                     dist: ret.camDist, yaw: -0.7, pitch: 0.42 });
  toast(sc.label);
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
  if (gpuOK) {
    if (PhysicsGPU.addMassive(p.x, p.y, p.z, 0, 0, 0, 6000, 3, 8, Bodies.TYPE_BH) < 0) {
      toast('NO FREE SLOTS'); return;
    }
  } else {
    Bodies.add(p.x, p.y, p.z, 0, 0, 0, 6000, 3, 8, Bodies.TYPE_BH, null);
  }
  toast('BLACK HOLE');
}

// ------------------------------------------------------------ pointer input
const ptr = { down: false, button: 0, x: 0, y: 0, shift: false };
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
      toast('TIME ' + engine.cfg.timeScale.toFixed(1) + 'x'); break;
    case 'b': dropBlackHole(ptr.x || W / 2, ptr.y || H / 2); break;
    case 'g': pulling = true; break;
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

  engine.frame();
  engine.adaptQuality(fpsSmooth);

  // Stellar evolution: every 10 frames, advance by accumulated sim-Myr.
  if (globalThis.Evolution && frameNo % 10 === 0 && !engine.cfg.paused) {
    const t = engine.cfg.t;
    const dtMyr = (t - lastSimT) * engine.cfg.myrPerT;
    lastSimT = t;
    if (dtMyr > 0) Evolution.step(engine.evolutionView(), dtMyr);
  }

  Camera3D.update(dtMs);
  Renderer3D.render({
    viewProj: Camera3D.viewProj(W / H),
    eye: Camera3D.eye(),
    lightPos, trails, timeMs: now,
    blackHoles: engine.blackHoleList(),
    attribsVersion: gpuOK ? PhysicsGPU.attribsVersion : 0,
  });
  requestAnimationFrame(frame);
}

setInterval(() => {
  $('stat').textContent =
    engine.bodyCount().toLocaleString() + ' bodies · ' +
    engine.simTimeMyr().toFixed(1) + ' Myr · ' +
    Math.round(fpsSmooth) + ' fps · ' + (gpuOK ? 'gpu' : 'cpu');
}, 400);

loadScenario(0);
requestAnimationFrame(frame);
})();
