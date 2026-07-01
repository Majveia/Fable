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

let _wgpuDevice = null;
if (!noWebGPU && globalThis.WGPU && globalThis.PhysicsWGPU && globalThis.RendererWGPU) {
  // Boot WebGPU on a DETACHED canvas: the visible canvas is swapped in
  // only after the device, both inits, AND a GPU validation scope all
  // succeed. Any failure — including a hung requestAdapter/requestDevice,
  // via the timeout — leaves the visible canvas pristine for WebGL.
  // (WGSL errors never throw in JS; the validation scope catches them.)
  const tryWebGPU = async () => {
    const probe = document.createElement('canvas');
    const w = await WGPU.boot(probe);
    if (!w) return null;
    const cap = Math.min(w.maxBodiesCap || (1 << 21), 1 << 21);
    w.device.pushErrorScope('validation');
    const inited = PhysicsWGPU.init(w, { maxBodies: cap }) && RendererWGPU.init(w);
    const vErr = await w.device.popErrorScope();
    if (!inited || vErr) {
      if (vErr) console.warn('WebGPU validation failed at init:', vErr.message);
      return null;
    }
    return { w, probe, cap };
  };
  let got = null;
  try {
    got = await Promise.race([
      tryWebGPU().catch((e) => { console.warn('WebGPU boot threw:', e); return null; }),
      new Promise((res) => setTimeout(() => res(null), 5000)),
    ]);
  } catch (e) { console.warn('WebGPU attempt failed:', e); }
  if (got) {
    got.probe.id = 'space';
    canvas.replaceWith(got.probe);
    canvas = got.probe;
    renderer = RendererWGPU; engine = PhysicsWGPU;
    wgpuOK = true; modeTag = 'webgpu'; MAX_BODIES = got.cap;
    Bodies.ensureCap(got.cap);
    _wgpuDevice = got.w.device;
  } else {
    console.warn('WebGPU unavailable or failed validation - using WebGL');
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
  // Runtime GPU validation errors (e.g. an invalid pipeline used in a
  // draw) surface here, never as JS exceptions.
  if (_wgpuDevice && typeof _wgpuDevice.addEventListener === 'function') {
    _wgpuDevice.addEventListener('uncapturederror', (e) => {
      if (probation) bailToWebGL((e.error && e.error.message) || 'uncaptured GPU error');
    });
  }
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

function currentBudget() {
  return { gpu: wgpuOK || gpuOK,
           maxBodies: (wgpuOK || gpuOK) ? MAX_BODIES - 128 : Bodies.CAP };
}

// After the global Bodies store has been filled (by a scenario init or a
// cosmos node.populate) and Physics.cfg set, hand it to the active engine.
function commitToEngine() {
  if (wgpuOK) {
    Object.assign(PhysicsWGPU.cfg, Physics.cfg);
    PhysicsWGPU.upload();
    RendererWGPU.setSource({
      posBuf: PhysicsWGPU.posBuf, velBuf: PhysicsWGPU.velBuf,
      attribBuf: PhysicsWGPU.attribBuf,
      count: PhysicsWGPU.count, massiveCount: PhysicsWGPU.massiveCount,
    });
  } else if (gpuOK) {
    Object.assign(PhysicsGPU.cfg, Physics.cfg);
    PhysicsGPU.upload();
    Renderer3D.setSource({
      mode: 'texture',
      posTex: () => PhysicsGPU.posTex,
      count: PhysicsGPU.count, massiveCount: PhysicsGPU.massiveCount,
      staticAttribs: PhysicsGPU.staticAttribs,
    });
  } else if (Renderer3D.setSource) {
    Renderer3D.setSource({ mode: 'arrays' });
  }
}

function loadScenario(i, seed) {
  universeMode = false;
  surfaceMode = false; surface = null;
  $('breadcrumb').textContent = '';
  scenarioIdx = (i + Scenarios.list.length) % Scenarios.list.length;
  const sc = Scenarios.list[scenarioIdx];
  followSlot = -1;
  $('focus').textContent = '';
  Bodies.clear();
  Physics.cfg.t = 0;
  Physics.cfg.timeScale = engine.cfg.timeScale; // keep user's speed setting
  Physics.cfg.theta2 = Physics.cfg.theta2Base;
  engine.clearPull();
  const ret = sc.init(currentBudget(), seed);
  commitToEngine();
  if (globalThis.Evolution) Evolution.reset(engine.evolutionView(), 42 + scenarioIdx);
  lastSimT = 0;
  lightPos = ret.lightPos || { x: 0, y: 0, z: 0 };
  Camera3D.setGoal({ targetX: 0, targetY: 0, targetZ: 0,
                     dist: ret.camDist, yaw: -0.7, pitch: 0.42 });
  toast(sc.label);
  updateHash();
  document.querySelectorAll('#dots span').forEach((d, k) =>
    d.classList.toggle('on', k === scenarioIdx + 1));   // +1: dot 0 is UNIVERSE
}

/* ============================================================
   THE PERSISTENT UNIVERSE — one seed, navigated continuously,
   aged by the clock (and by real time elapsed between visits).
   ============================================================ */
let universeMode = false;

const KIND_LABEL = { universe: 'Universe', galaxy: 'Galaxy', system: 'System', planet: 'Planet' };

function nodeLabel(node) {
  if (node.id === 'u') return 'Universe';
  if (node.name) return node.name;                    // named landmark (Sol, The Maw…)
  const tail = node.id.split('/').pop();              // e.g. "g9","s0","p2"
  const n = tail.replace(/^[a-z]/, '');
  return (KIND_LABEL[node.kind] || node.kind) + ' ' + n;
}

function breadcrumb(node) {
  const parts = [];
  for (let n = node; n; n = n.parent) parts.unshift(nodeLabel(n));
  return parts.join('  ›  ');
}

// Populate one cosmos node into the live engine. `reframe` recentres the
// camera on the node at its interior scale (used on enter + descent/ascent).
function loadCosmosNode(node, reframe) {
  followSlot = -1;
  $('focus').textContent = '';
  Bodies.clear();
  Physics.cfg.t = 0;
  Physics.cfg.theta2 = Physics.cfg.theta2Base;
  engine.clearPull();
  const ret = node.populate(currentBudget(), Bodies);
  if (ret && ret.cfg) Object.assign(Physics.cfg, ret.cfg);
  Physics.cfg.timeScale = engine.cfg.timeScale;
  commitToEngine();
  if (globalThis.Evolution) Evolution.reset(engine.evolutionView(), Cosmos.hashStringToU32(node.id));
  lastSimT = 0;
  lightPos = (ret && ret.light) || { x: 0, y: 0, z: 0 };
  if (reframe) {
    Camera3D.setGoal({ targetX: 0, targetY: 0, targetZ: 0,
                       dist: (node.viewRadius || node.radius) * 1.6,
                       yaw: -0.7, pitch: 0.42 });
  }
  $('breadcrumb').textContent = breadcrumb(node);
}

// ---- DRIFTER game state ----
let camMode = 'chase';            // FLY camera: chase | cockpit | orbit
let walkMode = false;             // on foot inside the ship
let walkView = 'fp';              // walk camera: fp | tp
let overlay = null;               // ship wireframe overlay (node-local), per frame
let surfaceMode = false;          // on a planet surface (piloting OR on foot)
let surface = null;               // Surface descriptor (mesh/sky/heightAt/spawn/...)
let surfView = 'chase';           // surface LANDER camera: chase | cockpit
let surfaceWalk = false;          // v13: out of the lander, walking on foot
let surfWalkView = 'fp';          // on-foot surface camera: fp | tp
let surfaceNodeId = null;         // planet node id for the current surface
const metOutposts = new Set();    // outposts whose crew you've already met
let scanHeld = false;
let pois = [];
let lmList = [];
let dtSecLast = 0.016;
const heldKeys = {};
const steer = { dx: 0, dy: 0 };
// Mouse-look sensitivity: rad-of-input per pixel of drag. The whole
// accumulated delta is drained as a [-1,1] rate command each frame (no
// decaying buffer), so this maps a brisk ~25px drag to roughly full deflection.
const STEER_SENS = 0.04;
let hudReady = false;

function spawnShip(node) {
  if (!globalThis.Ship) return;
  const vr = node.viewRadius || node.radius || 1000;
  Ship.reset({ viewRadius: vr });
  const f = Ship.facing();                      // [0,0,1] at reset
  const d = vr * 0.75;
  Ship.state.pos = [-f[0] * d, -f[1] * d, -f[2] * d]; // sit back, nose toward content
}

function rebuildPOIs(node) {
  pois = (globalThis.POI && node && node.kind !== 'universe') ? POI.forNode(node) : [];
}

function bountyTargets() {
  const ids = lmList.map((l) => l.id);
  if (Cosmos.root) {
    const gals = Cosmos.root.children().filter((c) => !c.landmark).slice(0, 4);
    for (const g of gals) { const s = g.children(); if (s && s[0]) ids.push(s[0].id); }
  }
  return ids.length ? ids : ['u'];
}

function buildShipInput() {
  const i = { thrust: 0, pitch: 0, yaw: 0, roll: 0, boost: false };
  if (heldKeys['w'] || heldKeys['arrowup']) i.thrust += 1;
  if (heldKeys['s'] || heldKeys['arrowdown']) i.thrust -= 1;
  if (heldKeys['a'] || heldKeys['arrowleft']) i.yaw -= 1;
  if (heldKeys['d'] || heldKeys['arrowright']) i.yaw += 1;
  if (heldKeys['q']) i.roll -= 1;
  if (heldKeys['e']) i.roll += 1;
  if (heldKeys['shift']) i.boost = true;
  // Mouse look: consume the whole accumulated delta this frame as a direct
  // rate command (no decaying accumulator -> no input latency / floatiness),
  // then drain it to 0 so nothing bleeds into later frames. steer.dy already
  // carries the NON-INVERTED pitch sign (see pointermove), so +steer.dy = up.
  i.yaw = clampUnit(i.yaw + steer.dx);
  i.pitch = clampUnit(i.pitch + steer.dy);
  steer.dx = 0; steer.dy = 0;
  return i;
}

// Clamp a control axis into the [-1,1] range the ship/avatar expect.
function clampUnit(v) { return v < -1 ? -1 : (v > 1 ? 1 : v); }

function dist3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

// On-foot input: WASD walk, drag look, shift run (shares heldKeys/steer).
function buildAvatarInput() {
  const i = { fwd: 0, strafe: 0, turn: 0, lookPitch: 0, run: false };
  if (heldKeys['w'] || heldKeys['arrowup']) i.fwd += 1;
  if (heldKeys['s'] || heldKeys['arrowdown']) i.fwd -= 1;
  if (heldKeys['a'] || heldKeys['arrowleft']) i.strafe -= 1;
  if (heldKeys['d'] || heldKeys['arrowright']) i.strafe += 1;
  if (heldKeys['shift']) i.run = true;
  // Same direct-drain mouse look as the ship: consume the accumulated delta
  // as a rate command, no decay. steer.dy carries the NON-INVERTED pitch sign.
  i.turn = clampUnit(i.turn + steer.dx);
  i.lookPitch = clampUnit(i.lookPitch + steer.dy);
  steer.dx = 0; steer.dy = 0;
  return i;
}

function saveGame() {
  if (!universeMode || !globalThis.Cosmos || !Cosmos.root) return;
  const game = globalThis.Drifter ? Drifter.serialize() : null;
  Persist.save({ seed: Cosmos.seed, clockMyr: Cosmos.clockMyr, edits: [], game });
}

// Project POIs to screen, pick the one nearest the reticle, run scanning,
// and push the whole cockpit state to the HUD.
function drifterHUD(input) {
  if (!globalThis.HUD) return;
  const vp = Camera3D.viewProj(W / H);
  let best = null, bestD = Infinity, bestS = null;
  for (const p of pois) {
    const lp = p.localPos;
    const cw = vp[3] * lp[0] + vp[7] * lp[1] + vp[11] * lp[2] + vp[15];
    if (cw <= 0.05) continue;
    const sx = ((vp[0] * lp[0] + vp[4] * lp[1] + vp[8] * lp[2] + vp[12]) / cw * 0.5 + 0.5) * W;
    const sy = (1 - ((vp[1] * lp[0] + vp[5] * lp[1] + vp[9] * lp[2] + vp[13]) / cw * 0.5 + 0.5)) * H;
    const d = Math.hypot(sx - W / 2, sy - H / 2);
    if (d < bestD) { bestD = d; best = p; bestS = { sx, sy }; }
  }
  const reticleHit = best && bestD < Math.min(W, H) * 0.16;
  if (globalThis.Drifter) {
    const sc = Drifter.tickScan(dtSecLast, reticleHit ? best : null, scanHeld && reticleHit);
    if (sc) {
      HUD.discovery(sc);
      // Stations are inhabited — meet the souls aboard. Deterministic per
      // station name, so the same port always has the same crew.
      if (sc.kind === 'station' && globalThis.NPC) {
        try {
          const crew = NPC.atLandmark(sc.name || (best && best.id) || 'station');
          if (crew && crew.length) {
            const who = crew[0];
            HUD.toast('MET · ' + who.name + ' — ' + who.role, '#ffb347');
            if (sc.first) for (const p of crew)
              HUD.logEntry('soul', p.name + ' · ' + p.species + ' · ' + p.role, NPC.greeting(p));
          }
        } catch (e) { /* NPC optional — never break the scan loop */ }
      }
      if (globalThis.Score) Score.discovery();
      saveGame();
    }
  }
  const sh = globalThis.Ship ? Ship.state : { speed: 0, pos: [0, 0, 0], yaw: 0, pitch: 0 };
  const target = best ? {
    label: best.name, sx: bestS.sx, sy: bestS.sy,
    on: bestS.sx >= 0 && bestS.sx <= W && bestS.sy >= 0 && bestS.sy <= H,
    dist: dist3(sh.pos, best.localPos),
  } : null;
  HUD.update({
    speed: sh.speed, throttle: input.thrust > 0 ? input.thrust : Math.min(1, sh.speed / ((Ship && Ship._topSpeed) || 1)),
    boost: !!input.boost, breadcrumb: breadcrumb(Navigator.active),
    coords: sh.pos, heading: [sh.yaw, sh.pitch], fps: fpsSmooth,
    age: Cosmos.clockMyr, bodies: engine.bodyCount(), engineTag: modeTag,
    mode: walkMode ? ('walk ' + walkView) : ('fly ' + (camMode === 'cockpit' ? 'fp' : camMode === 'orbit' ? 'orbit' : 'tp')),
    scanProgress: globalThis.Drifter ? Drifter.scanProgress : 0,
    target, bounty: globalThis.Drifter ? Drifter.activeBounty : null,
  });
}

/* ============================================================
   WANDERER — be a person, not just a ship. The ship has a model
   (wireframe + interior) in SHIP SPACE; the avatar walks it. We
   transform ship space -> the active node's LOCAL frame using the
   ship's pose, draw the ship as a render overlay, and drive the
   camera from either the ship (flying) or the avatar (on foot),
   in first or third person.
   ============================================================ */
function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/l, a[1]/l, a[2]/l]; }

// Ship-space basis in node-local coords from the ship's pose (+Z fwd, +Y up,
// +X right), with roll applied about the forward axis.
function shipBasis() {
  const F = globalThis.Ship ? norm(Ship.facing()) : [0, 0, 1];
  let R = cross([0, 1, 0], F);
  if (Math.hypot(R[0], R[1], R[2]) < 1e-6) R = [1, 0, 0];
  R = norm(R);
  let U = cross(F, R);
  const roll = (globalThis.Ship && Ship.state.roll) || 0;
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const R2 = [R[0]*cr + U[0]*sr, R[1]*cr + U[1]*sr, R[2]*cr + U[2]*sr];
  const U2 = [U[0]*cr - R[0]*sr, U[1]*cr - R[1]*sr, U[2]*cr - R[2]*sr];
  return { F, R: R2, U: U2 };
}
function shipWorldLen() {
  // On a planet surface the ship is a fixed real-world size against the
  // terrain (extent is ~1200), not scaled by the cosmic LOD extent.
  if (surfaceMode) return 24;
  const vr = (Navigator.active && (Navigator.active.viewRadius || Navigator.active.radius)) || 1000;
  return Math.max(8, Math.min(vr * 0.03, 300));
}
function shipToLocal(s, b, scale, o) {
  return [
    o[0] + (b.R[0]*s[0] + b.U[0]*s[1] + b.F[0]*s[2]) * scale,
    o[1] + (b.R[1]*s[0] + b.U[1]*s[1] + b.F[1]*s[2]) * scale,
    o[2] + (b.R[2]*s[0] + b.U[2]*s[1] + b.F[2]*s[2]) * scale,
  ];
}
function shipDirToLocal(d, b) {
  return [b.R[0]*d[0] + b.U[0]*d[1] + b.F[0]*d[2],
          b.R[1]*d[0] + b.U[1]*d[1] + b.F[1]*d[2],
          b.R[2]*d[0] + b.U[2]*d[1] + b.F[2]*d[2]];
}

// Build the ship wireframe overlay (lines + interior node sprites) in the
// active node's local frame from ShipModel (ship space).
function buildOverlay() {
  if (!globalThis.ShipModel || !globalThis.Ship) { overlay = null; return null; }
  const b = shipBasis();
  const scale = shipWorldLen() / (ShipModel.scale || 16);
  const o = Ship.state.pos;
  const src = ShipModel.lines || new Float32Array(0);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const p = shipToLocal([src[i], src[i + 1], src[i + 2]], b, scale, o);
    out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2];
  }
  // Solid hull mesh: transform tri positions ship->local (per vertex) and the
  // normals by the ship basis ROTATION only (no translation/scale), renorm.
  const stris = ShipModel.tris || new Float32Array(0);
  const snorm = ShipModel.norms || new Float32Array(0);
  const triOut = new Float32Array(stris.length);
  const nrmOut = new Float32Array(snorm.length);
  for (let i = 0; i < stris.length; i += 3) {
    const p = shipToLocal([stris[i], stris[i + 1], stris[i + 2]], b, scale, o);
    triOut[i] = p[0]; triOut[i + 1] = p[1]; triOut[i + 2] = p[2];
  }
  for (let i = 0; i < snorm.length; i += 3) {
    const n = norm(shipDirToLocal([snorm[i], snorm[i + 1], snorm[i + 2]], b));
    nrmOut[i] = n[0]; nrmOut[i + 1] = n[1]; nrmOut[i + 2] = n[2];
  }
  const pts = (ShipModel.nodes || []).map((n) => {
    const p = shipToLocal(n.pos, b, scale, o);
    return { x: p[0], y: p[1], z: p[2], colorIdx: n.colorIdx, size: scale * 0.5 };
  });
  // In walk mode, draw the avatar as a bright marker so you see yourself.
  if (walkMode && globalThis.Avatar) {
    const ap = shipToLocal(Avatar.state.pos, b, scale, o);
    pts.push({ x: ap[0], y: ap[1] + scale * 0.06, z: ap[2], colorIdx: 8, size: scale * 0.9 });
  } else if (surfaceWalk && globalThis.Avatar) {
    // On foot on a planet: the avatar walks the terrain in SURFACE/WORLD space
    // directly (no ship transform); mark yourself so you're visible in TP.
    const a = Avatar.state.pos;
    pts.push({ x: a[0], y: a[1] + 1.4, z: a[2], colorIdx: 8, size: 18 });
  }
  overlay = {
    lines: out, lineColor: ShipModel.lineColor || [0.32, 0.9, 1.0], points: pts,
    tris: triOut, norms: nrmOut, triColor: ShipModel.triColor || null,
    lightDir: norm([0.4, 0.8, 0.3]),
    _b: b, _scale: scale,
  };
  return overlay;
}

/* ============================================================
   PLANET-SURFACE LANDINGS. From orbit at a planet node, press L to
   descend: generate the surface (deterministic from the planet's
   archetype + id), drop the ship in under gravity, and render the
   terrain scene. Press L again to take off back into orbit.
   ============================================================ */
function landOnPlanet() {
  if (!universeMode || surfaceMode) return;
  if (!globalThis.Surface || !globalThis.Ship) return;
  const node = Navigator.active;
  if (!node || node.kind !== 'planet') {
    if (globalThis.HUD) HUD.toast('NO PLANET TO LAND ON — DIVE TO A PLANET FIRST', '#ff4fd8');
    return;
  }
  const sm = node.summary || {};
  surface = Surface.generate({
    archetype: sm.archetype || 'rocky',
    seed: node.id || 'surf',
    radius: node.radius || sm.radVis || 0,
    colorIdx: (sm.colorIdx != null ? sm.colorIdx : 5),
  });
  if (walkMode) { walkMode = false; }
  surfaceMode = true;
  surfaceWalk = false;
  surfView = 'chase';
  surfaceNodeId = node.id || 'surf';
  metOutposts.clear();
  Ship.surfaceReset({ spawn: surface.spawn, gravity: 12, extent: surface.extent, clearance: 5 });
  buildOverlay();
  const g = Ship.surfaceCameraGoal(surfView, surface.heightAt);
  if (g) { Camera3D.setGoal(g); Camera3D.snap(); }
  if (globalThis.HUD) HUD.toast('LANDING · ' + (surface.archetype || '').toUpperCase() +
    ' SURFACE · press X to step out', '#ffb347');
  if (globalThis.Score) Score.discovery();
}

function leaveSurface() {
  if (!surfaceMode) return;
  surfaceMode = false;
  surfaceWalk = false;
  surface = null;
  surfaceNodeId = null;
  // Re-establish orbit at the same planet node and snap the chase cam on.
  spawnShip(Navigator.active);
  buildOverlay();
  const g0 = Ship.cameraGoal(camMode);
  if (g0) { Camera3D.setGoal(g0); Camera3D.snap(); }
  if (globalThis.HUD) HUD.toast('LIFTOFF · BACK IN ORBIT', '#37e6ff');
  if (globalThis.Score) Score.bounty();
}

/* v13 — step out of the parked lander to explore on foot, and climb back in.
   Boarding requires standing near the ship. */
function toggleSurfaceWalk() {
  if (!surfaceMode || !surface || !globalThis.Avatar || !globalThis.Ship) return;
  if (!surfaceWalk) {
    const sp = Ship.state.pos;
    const ax = clampToExtent(sp[0] + 10, surface.extent);
    const az = clampToExtent(sp[2], surface.extent);
    const gy = surface.heightAt(ax, az);
    Avatar.surfaceReset({ pos: [ax, isFinite(gy) ? gy : 0, az], yaw: Ship.state.yaw, extent: surface.extent });
    surfaceWalk = true;
    surfWalkView = 'fp';
    surfaceWalkCamera();
    if (globalThis.HUD) HUD.toast('ON FOOT · ' + surface.archetype.toUpperCase() +
      ' · find an outpost, return to your ship to fly', '#37e6ff');
  } else {
    const a = Avatar.state.pos, sp = Ship.state.pos;
    if (Math.hypot(a[0] - sp[0], a[2] - sp[2]) > 32) {
      toast('RETURN TO YOUR SHIP TO BOARD');
      return;
    }
    surfaceWalk = false;
    const g = Ship.surfaceCameraGoal(surfView, surface.heightAt);
    if (g) { Camera3D.setGoal(g); Camera3D.snap(); }
    if (globalThis.HUD) HUD.toast('ABOARD · at the helm', '#37e6ff');
  }
}
function clampToExtent(v, ext) { const e = ext || 1200; return v < -e ? -e : (v > e ? e : v); }

// Aim the camera from the on-foot avatar's surface mount (world space).
function surfaceWalkCamera() {
  if (!globalThis.Avatar || !surface) return;
  const m = Avatar.surfaceMount(surfWalkView, surface.heightAt);
  aimCamera(m.pos, norm(m.forward), surfWalkView === 'tp' ? 7 : 0.35);
}

// Walking near an outpost meets its crew (once): a toast + the crew logged.
function checkOutpostProximity() {
  if (!surface || !surface.outposts || !globalThis.Avatar) return;
  const a = Avatar.state.pos;
  for (const o of surface.outposts) {
    const d = Math.hypot(a[0] - o.pos[0], a[2] - o.pos[2]);
    const okey = (surfaceNodeId || '') + '|' + o.name;
    if (d < 18 && !metOutposts.has(okey)) {
      metOutposts.add(okey);
      if (globalThis.NPC) {
        const crew = NPC.atOutpost(o.name, o.kind);
        if (crew && crew.length) {
          const who = crew[0];
          if (globalThis.HUD) {
            HUD.toast('OUTPOST · ' + o.name.toUpperCase() + ' — ' + who.name + ' (' + who.role + ')', '#ffb347');
            for (const p of crew) HUD.logEntry('outpost', p.name + ' · ' + p.species + ' · ' + p.role, NPC.greeting(p));
          }
        }
      }
      if (globalThis.Score) Score.discovery();
    }
  }
}

// Cockpit / on-foot readout while on a planet surface. The full POI/scan HUD
// is orbit-only; here we show speed+altitude (lander) or an on-foot line.
function surfaceHUD(input) {
  if (!globalThis.HUD || !globalThis.Ship) return;
  const s = Ship.state;
  const arch = surface ? surface.archetype.toUpperCase() : '';
  let breadcrumb, coords, heading, speed;
  if (surfaceWalk && globalThis.Avatar) {
    const a = Avatar.state;
    // distance to the nearest outpost as a gentle wayfinding hint
    let nearest = Infinity, nname = '';
    if (surface.outposts) for (const o of surface.outposts) {
      const d = Math.hypot(a.pos[0] - o.pos[0], a.pos[2] - o.pos[2]);
      if (d < nearest) { nearest = d; nname = o.name; }
    }
    const hint = isFinite(nearest) ? ' · ' + nname.toUpperCase() + ' ' + Math.round(nearest) + 'm' : '';
    breadcrumb = 'ON FOOT · ' + arch + hint;
    coords = a.pos; heading = [a.yaw, a.pitch]; speed = a.moving ? 6 : 0;
  } else {
    breadcrumb = 'SURFACE · ' + arch + ' · ALT ' + Math.max(0, Math.round(s.altitude)) +
      (s.grounded ? ' · LANDED' : '');
    coords = s.pos; heading = [s.yaw, s.pitch]; speed = s.speed;
  }
  HUD.update({
    speed: speed,
    throttle: input.thrust > 0 ? input.thrust : 0,
    boost: !!input.boost,
    breadcrumb: breadcrumb,
    coords: coords, heading: heading, fps: fpsSmooth,
    mode: surfaceWalk ? ('on-foot ' + surfWalkView) : ('surface ' + surfView),
    scanProgress: 0, target: null, bounty: globalThis.Drifter ? Drifter.activeBounty : null,
  });
}

// Place the camera so its eye sits at E (node-local) looking along unit L.
// eye = target + dist*(cp*sy, sp, cp*cy); look = -that. So target = E + L*D.
function aimCamera(E, L, D) {
  const pitch = Math.asin(Math.max(-1, Math.min(1, -L[1])));
  const yaw = Math.atan2(-L[0], -L[2]);
  Camera3D.setGoal({ targetX: E[0] + L[0]*D, targetY: E[1] + L[1]*D, targetZ: E[2] + L[2]*D,
                     dist: D, yaw, pitch });
  Camera3D.snap();
}

// On-foot camera from the avatar's mount, transformed ship -> local.
function walkCamera() {
  if (!globalThis.Avatar || !overlay) return;
  const m = Avatar.cameraMount(walkView);   // ship space {pos,forward,up}
  const E = shipToLocal(m.pos, overlay._b, overlay._scale, Ship.state.pos);
  const L = norm(shipDirToLocal(m.forward, overlay._b));
  aimCamera(E, L, Math.max(0.5, shipWorldLen() * 0.06));
}

function toggleWalk() {
  if (!globalThis.Avatar || !globalThis.ShipModel) { toast('NO INTERIOR'); return; }
  walkMode = !walkMode;
  if (walkMode) {
    if (globalThis.Ship) { Ship.state.vel = [0, 0, 0]; }   // ship holds station
    Avatar.reset({ seat: ShipModel.seat });
    walkView = 'fp';
    toast('ON FOOT · ' + walkView.toUpperCase());
    if (globalThis.HUD) HUD.toast('LEFT THE PILOT SEAT', '#37e6ff');
  } else {
    toast('PILOT SEAT');
    if (globalThis.HUD) HUD.toast('BACK AT THE HELM', '#37e6ff');
  }
}

function enterUniverse(record) {
  universeMode = true;
  surfaceMode = false; surface = null;
  const seed = record ? record.seed : ((Math.random() * 2 ** 31) | 0) >>> 0;
  Cosmos.create(seed);
  let agedMsg = '';
  if (record) {
    const aged = Persist.ageDelta(record.lastVisitMs, Date.now());
    Cosmos.ageTo((record.clockMyr || 0) + aged);
    if (aged > 1) agedMsg = ' · drifted ' + Math.round(aged) + ' Myr';
  }
  if (globalThis.Landmarks) { try { Landmarks.inject(Cosmos); lmList = Landmarks.list(); } catch (e) { lmList = []; } }
  Navigator.init(Cosmos, Camera3D);
  Navigator.focusNode(Cosmos.root);
  loadCosmosNode(Cosmos.root, true);
  spawnShip(Cosmos.root);
  rebuildPOIs(Cosmos.root);
  if (globalThis.HUD) { if (!hudReady) { HUD.init(); hudReady = true; } HUD.show(true);
    if (globalThis.Drifter) HUD.loadEntries(Drifter.discoveries); }
  if (globalThis.Drifter) {
    Drifter.load(record && record.game);
    Drifter._bountySeed = seed;
    Drifter.refreshBounties(seed, bountyTargets());
  }
  camMode = 'chase';
  document.querySelectorAll('#dots span').forEach((d, k) => d.classList.toggle('on', k === 0));
  toast('DRIFTER' + agedMsg);
  if (globalThis.HUD) HUD.toast('ADRIFT IN ' + (lmList.length ? Cosmos.root.children().length + ' WORLDS' : 'THE VOID'), '#37e6ff');
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
  // In DRIFTER mode a drag flies the ship (flight-stick: pitch + yaw),
  // unless you're in free orbit-cam. Otherwise it's the orbit camera.
  if (universeMode && camMode !== 'orbit') {
    // Accumulate RAW mouse delta as a direct steer command (drained whole each
    // frame in buildShipInput/buildAvatarInput -> snappy, no decay lag).
    // NON-INVERTED look: drag DOWN (dy>0) pitches/looks DOWN, so the pitch
    // axis takes the NEGATED dy (matches research: pitch -= movementY).
    if (ptr.down) { steer.dx += dx * STEER_SENS; steer.dy -= dy * STEER_SENS; }
    return;
  }
  if (!ptr.down) return;
  if (ptr.button === 2 || ptr.shift) Camera3D.pan(dx, dy, H);
  else Camera3D.orbit(dx * 0.005, dy * 0.005);
});

const endPointer = (e) => {
  touches.delete(e.pointerId);
  if (touches.size < 2) pinchDist = 0;
  // A click (not a drag) tracks a body — sandbox only (drifter has its own
  // reticle/scan loop).
  if (!universeMode && ptr.down && e.pointerType !== 'touch' && e.button === 0 &&
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
const FLIGHT_KEYS = ['w', 'a', 's', 'd', 'q', 'e', 'shift',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
window.addEventListener('keydown', (e) => {
  wake();
  const lk = e.key.toLowerCase();
  // In DRIFTER mode the movement keys are held flight controls — claim them
  // before the discrete-action switch so WASD never toggles dark matter etc.
  if (universeMode && FLIGHT_KEYS.indexOf(lk) >= 0) {
    heldKeys[lk] = true;
    if (lk.indexOf('arrow') === 0) e.preventDefault();
    if (globalThis.Score) Score.poke();
    return;
  }
  if (e.repeat && e.key !== '[' && e.key !== ']') return;
  switch (e.key) {
    case ' ': e.preventDefault(); engine.cfg.paused = !engine.cfg.paused;
      toast(engine.cfg.paused ? 'PAUSED' : 'RESUMED'); break;
    case 't': trails = !trails; toast(trails ? 'TRAILS ON' : 'TRAILS OFF'); break;
    case 'u':
      enterUniverse(null);   // jump into a fresh drifter universe
      break;
    case 'x': case 'X':
      if (surfaceMode) toggleSurfaceWalk();  // step out of / climb back into the lander
      else if (universeMode) toggleWalk();   // enter / leave the ship on foot
      break;
    case 'l': case 'L':
      if (surfaceMode) leaveSurface();
      else if (universeMode) landOnPlanet();
      break;
    case 'v': case 'V':
      if (surfaceMode && surfaceWalk) {
        surfWalkView = surfWalkView === 'fp' ? 'tp' : 'fp';
        toast('VIEW · ' + surfWalkView.toUpperCase());
      } else if (surfaceMode) {
        surfView = surfView === 'cockpit' ? 'chase' : 'cockpit';
        toast('VIEW · ' + (surfView === 'cockpit' ? 'FIRST PERSON' : 'THIRD PERSON'));
      } else if (universeMode) {
        if (walkMode) { walkView = walkView === 'fp' ? 'tp' : 'fp'; toast('VIEW · ' + walkView.toUpperCase()); }
        else { camMode = camMode === 'cockpit' ? 'chase' : 'cockpit';
          toast('VIEW · ' + (camMode === 'cockpit' ? 'FIRST PERSON' : 'THIRD PERSON')); }
      }
      break;
    case 'c':
      if (universeMode) {
        // 4-way cycle: fly-TP -> fly-FP -> walk-FP -> walk-TP -> fly-TP
        if (!walkMode && camMode === 'chase') camMode = 'cockpit';
        else if (!walkMode && camMode === 'cockpit') { if (globalThis.Avatar && globalThis.ShipModel) { toggleWalk(); walkView = 'fp'; } else camMode = 'orbit'; }
        else if (walkMode && walkView === 'fp') walkView = 'tp';
        else if (walkMode && walkView === 'tp') { toggleWalk(); camMode = 'chase'; }
        else camMode = 'chase';
        toast('CAM · ' + (walkMode ? 'WALK ' + walkView.toUpperCase() : 'FLY ' + camMode.toUpperCase()));
      }
      break;
    case 'f':
      if (universeMode) { scanHeld = true; }
      else if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
      break;
    case 'j':
      if (universeMode && globalThis.Drifter && Drifter.bounties.length) {
        const b = Drifter.bounties.find((x) => !x.done && x !== Drifter.activeBounty) || Drifter.bounties[0];
        Drifter.acceptBounty(b);
        if (globalThis.HUD) HUD.logBounty(b);
        if (globalThis.Score) Score.bounty();
      }
      break;
    case 'n':
      if (universeMode) setCourseNextLandmark();
      break;
    case 'Tab':
      e.preventDefault();
      if (universeMode && globalThis.HUD) HUD.codex();
      break;
    case 'r':
      if (universeMode) {
        surfaceMode = false; surface = null;
        Navigator.focusNode(Cosmos.root); loadCosmosNode(Cosmos.root, true);
        spawnShip(Cosmos.root); rebuildPOIs(Cosmos.root);
      } else loadScenario(scenarioIdx);
      break;
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
    case 'F': case 'F11':
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
      break;
    case 'ArrowRight': if (!universeMode) loadScenario(scenarioIdx + 1); break;
    case 'ArrowLeft': if (!universeMode) loadScenario(scenarioIdx - 1); break;
    default: {
      const k = parseInt(e.key, 10);
      if (k >= 1 && k <= Scenarios.list.length) loadScenario(k - 1);   // sandbox shortcut
    }
  }
});
window.addEventListener('keyup', (e) => {
  const lk = e.key.toLowerCase();
  heldKeys[lk] = false;
  if (lk === 'f') scanHeld = false;
  if (e.key === 'g') { pulling = false; engine.clearPull(); }
});

// Fast-travel: cycle a course to the next named landmark (a merged sandbox).
let lmIdx = -1;
function setCourseNextLandmark() {
  if (!lmList.length || !Cosmos.root) return;
  lmIdx = (lmIdx + 1) % lmList.length;
  const entry = lmList[lmIdx];
  const node = Cosmos.root.children().find((c) => c.id === entry.id);
  if (!node) return;
  Navigator.focusNode(node);
  loadCosmosNode(node, false);
  spawnShip(node);
  rebuildPOIs(node);
  if (globalThis.HUD) HUD.toast('JUMP · ' + entry.name.toUpperCase(), '#ffb347');
  if (globalThis.Score) Score.bounty();
}

// ------------------------------------------------------------ idle fade
let idleTimer = null;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
}
wake();

// ------------------------------------------------------------ dots
// Dot 0 = the persistent UNIVERSE; the rest are the sandbox scenarios.
const dots = $('dots');
const uDot = document.createElement('span');
uDot.title = 'THE UNIVERSE';
uDot.style.background = 'rgba(140,200,255,0.5)';
uDot.addEventListener('click', () => enterUniverse(null));
dots.appendChild(uDot);
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
      if (frameNo > 300) probation = false;       // survived ~5 s: trust it
    } catch (e) { bailToWebGL(e); return; }
    Camera3D.update(dtMs);
    engine.adaptQuality(fpsSmooth);
    requestAnimationFrame(frame);
    return;
  }

  engine.frame();
  engine.adaptQuality(fpsSmooth);

  // DRIFTER: pilot the ship; the camera follows it; the Navigator streams
  // the universe (LOD + floating origin) around the ship's position; on a
  // level change repopulate, respawn the ship, and rebuild this node's POIs.
  if (surfaceMode && globalThis.Ship && surface) {
    // ON A PLANET SURFACE. The Navigator/LOD is paused; the lander sits where
    // it landed. Either pilot the lander, or (v13) walk the terrain on foot.
    // NOTE: buildShipInput/buildAvatarInput each DRAIN the steer accumulator,
    // so call exactly one per frame (whichever mode is active).
    dtSecLast = dtMs / 1000;
    if (surfaceWalk && globalThis.Avatar) {
      // ON FOOT: walk the alien ground; the parked lander stays put.
      const ainput = buildAvatarInput();
      if (!engine.cfg.paused) {
        Avatar.updateOnSurface(dtSecLast, ainput, surface.heightAt, surface.extent);
        surfaceWalkCamera();
        checkOutpostProximity();
        if (globalThis.Score) Score.setThrust(0);
      }
      buildOverlay();
      surfaceHUD({ thrust: 0, boost: false });
    } else {
      // PILOT the lander: gravity flight + ground collision; camera chases it.
      const input = buildShipInput();
      if (!engine.cfg.paused) {
        Ship.surfaceUpdate(dtSecLast, input, surface.heightAt);
        const g = Ship.surfaceCameraGoal(surfView, surface.heightAt);
        if (g) Camera3D.setGoal(g);
        if (globalThis.Score) Score.setThrust(input.thrust > 0 ? (input.boost ? 1 : 0.6) : 0);
      }
      buildOverlay();
      surfaceHUD(input);
    }
  } else if (universeMode && globalThis.Navigator && Navigator.active) {
    dtSecLast = dtMs / 1000;
    const input = buildShipInput();
    if (walkMode && globalThis.Avatar) {
      // ON FOOT: the ship holds station; you walk its interior; the camera
      // rides the avatar (first or third person).
      Avatar.update(dtSecLast, buildAvatarInput(), globalThis.ShipModel);
      buildOverlay();
      walkCamera();
      if (globalThis.Score) Score.setThrust(0);
    } else {
      // FLYING: pilot the ship; camera = cockpit (FP) or chase (TP).
      if (globalThis.Ship && camMode !== 'orbit' && !engine.cfg.paused) {
        Ship.update(dtSecLast, input);
        const goal = Ship.cameraGoal(camMode);
        if (goal) Camera3D.setGoal(goal);
        if (globalThis.Score) Score.setThrust(input.thrust > 0 ? (input.boost ? 1 : 0.6) : 0);
      }
      buildOverlay();
    }
    const nav = Navigator.update(dtMs);
    if (nav.changed) {
      loadCosmosNode(Navigator.active, false);
      spawnShip(Navigator.active);
      // Snap the camera onto the freshly-spawned ship so it doesn't ease
      // across the (possibly huge) scale gap — which would briefly place
      // the camera far from the new node and bounce the LOD straight back.
      if (globalThis.Ship && !walkMode) {
        const g0 = Ship.cameraGoal(camMode);
        if (g0) { Camera3D.setGoal(g0); Camera3D.snap(); }
      }
      rebuildPOIs(Navigator.active);
      if (globalThis.HUD) HUD.toast('ENTERING · ' +
        (Navigator.active.name || nodeLabel(Navigator.active)).toUpperCase(), '#37e6ff');
      if (globalThis.Score) Score.discovery();
      if (globalThis.Drifter) {
        const b = Drifter.completeBountyIfAt(Navigator.active.id);
        if (b) { if (globalThis.HUD) HUD.toast('BOUNTY CLAIMED · ' + b.name +
          ' · ' + (b.reward || 0).toLocaleString() + ' w', '#ffb347');
          if (globalThis.Score) Score.bounty(); saveGame(); }
      }
    }
    if (!engine.cfg.paused) {
      Cosmos.ageTo(Cosmos.clockMyr +
        engine.cfg.dt * engine.cfg.timeScale * engine.cfg.myrPerT);
    }
    drifterHUD(input);
  }

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

  // Click-to-focus: glue the camera target to the tracked body. (Disabled
  // in universe mode — body indices churn as nodes stream in/out.)
  if (followSlot >= 0 && !universeMode) {
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
    overlay: ((surfaceMode || universeMode) && overlay) ? overlay : null,   // solid ship
    surface: (surfaceMode && surface) ? {                  // planet-surface scene
      mesh: surface.mesh, propMesh: surface.propMesh, markers: surface.markers,
      sky: surface.sky, water: surface.water, extent: surface.extent, timeMs: now,
    } : null,
  });
  requestAnimationFrame(frame);
}

setInterval(() => {
  if (globalThis.Sound) Sound.setScale(Camera3D.dist);
  if (universeMode) {
    // DRIFTER: the HUD owns the cockpit readout; keep the old chrome hidden.
    $('stat').textContent = '';
    $('focus').textContent = '';
    $('breadcrumb').textContent = '';
  } else {
    if (followSlot >= 0) focusLabel(followSlot);
    $('stat').textContent =
      engine.bodyCount().toLocaleString() + ' bodies · ' +
      engine.simTimeMyr().toFixed(1) + ' Myr · ' +
      Math.round(fpsSmooth) + ' fps · ' + modeTag;
  }
}, 400);

// Autosave the drifter (seed + clock + discoveries/bounties) so the universe
// ages and remembers what you found while you are away.
function saveUniverse() {
  if (universeMode && globalThis.Cosmos && Cosmos.root) {
    Persist.save({ seed: Cosmos.seed, clockMyr: Cosmos.clockMyr, edits: [],
                   game: globalThis.Drifter ? Drifter.serialize() : null });
  }
}
setInterval(saveUniverse, 10000);
window.addEventListener('pagehide', saveUniverse);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveUniverse();
});

if (boot.dm !== undefined) DarkMatter.on = boot.dm !== '0';
if (boot.ts !== undefined) engine.cfg.timeScale = Math.max(0, Math.min(3, +boot.ts || 1));
try {
  if (boot.s) {
    // Explicit sandbox scenario via URL hash (#s=galaxy&seed=…).
    const bootIdx = Math.max(0, Scenarios.list.findIndex(sc => sc.key === boot.s));
    loadScenario(bootIdx, boot.seed !== undefined ? (+boot.seed >>> 0) : undefined);
  } else if (globalThis.Cosmos && globalThis.Navigator && globalThis.Persist) {
    // Default: the persistent universe — load the saved seed+clock (aging
    // it by time elapsed away) or mint a fresh one.
    let rec = null;
    try { rec = await Persist.load(); } catch { rec = null; }
    enterUniverse(rec);
  } else {
    loadScenario(0);   // cosmos modules absent (shouldn't happen) — sandbox
  }
} catch (e) {
  if (probation) { bailToWebGL(e); return; }
  // Universe path failed for a non-WebGPU reason — fall back to sandbox.
  console.warn('universe boot failed, sandbox fallback:', e);
  try { loadScenario(0); } catch (e2) { throw e2; }
}
requestAnimationFrame(frame);
})();
