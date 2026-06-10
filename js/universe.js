'use strict';
/* ============================================================
   FABLE UNIVERSE — real-time N-body gravity simulator
   Barnes-Hut quadtree O(n log n) force solver, canvas renderer.
   Zero dependencies. G = 1 in simulation units.
   ============================================================ */

// ---------------------------------------------------------------- canvas
const canvas = document.getElementById('space');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- bodies
// Parallel arrays for cache-friendly physics. Swap-pop removal.
const TYPE_STAR = 0, TYPE_BH = 1, TYPE_NAMED = 2;
let CAP = 1 << 16;
let n = 0;
let px = new Float64Array(CAP), py = new Float64Array(CAP);
let vx = new Float64Array(CAP), vy = new Float64Array(CAP);
let ms = new Float64Array(CAP);
let rad = new Float32Array(CAP);          // visual radius (world units)
let colIdx = new Uint8Array(CAP);         // sprite palette index
let type = new Uint8Array(CAP);
let names = new Array(CAP).fill(null);

function addBody(x, y, vx_, vy_, m, r, c, t, name) {
  if (n >= CAP) return -1;
  px[n] = x; py[n] = y; vx[n] = vx_; vy[n] = vy_;
  ms[n] = m; rad[n] = r; colIdx[n] = c; type[n] = t;
  names[n] = name || null;
  return n++;
}

function removeBody(i) {
  n--;
  px[i] = px[n]; py[i] = py[n]; vx[i] = vx[n]; vy[i] = vy[n];
  ms[i] = ms[n]; rad[i] = rad[n]; colIdx[i] = colIdx[n];
  type[i] = type[n]; names[i] = names[n]; names[n] = null;
}

function clearBodies() { n = 0; names.fill(null); }

// ---------------------------------------------------------------- star palette
// Approximate blackbody colors, O-class blue through M-class red.
const PALETTE = [
  [155, 176, 255], // O  hot blue
  [170, 191, 255], // B
  [202, 215, 255], // A
  [248, 247, 255], // F  white
  [255, 244, 234], // G  sun-like
  [255, 210, 161], // K  orange
  [255, 163, 110], // M  red dwarf
  [255, 220,  90], // sun sprite
  [120, 200, 255], // accretion blue
];

// Real stellar populations are dominated by cool dwarfs.
function randomStarColor() {
  const u = Math.random();
  if (u < 0.45) return 6;
  if (u < 0.70) return 5;
  if (u < 0.85) return 4;
  if (u < 0.93) return 3;
  if (u < 0.97) return 2;
  if (u < 0.99) return 1;
  return 0;
}

// Pre-rendered glow sprites — drawImage is far cheaper than per-star gradients.
const SPRITE_SIZE = 64;
const sprites = PALETTE.map(([r, g, b]) => {
  const c = document.createElement('canvas');
  c.width = c.height = SPRITE_SIZE;
  const sctx = c.getContext('2d');
  const half = SPRITE_SIZE / 2;
  const grad = sctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, `rgba(${r},${g},${b},0.9)`);
  grad.addColorStop(0.45, `rgba(${r},${g},${b},0.25)`);
  grad.addColorStop(1.0, `rgba(${r},${g},${b},0)`);
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  return c;
});

// ---------------------------------------------------------------- quadtree
// Pooled Barnes-Hut quadtree rebuilt every step. Nodes store
// mass-weighted centroids; force traversal is an explicit stack.
const MAX_DEPTH = 40;

class QuadTree {
  constructor(cap) { this.alloc(cap); }

  alloc(cap) {
    this.cap = cap;
    this.cx = new Float64Array(cap);     // node center
    this.cy = new Float64Array(cap);
    this.size = new Float64Array(cap);   // node width
    this.mass = new Float64Array(cap);
    this.comX = new Float64Array(cap);   // mass-weighted sum during build
    this.comY = new Float64Array(cap);
    this.child = new Int32Array(cap);    // index of first of 4 children, -1 = leaf
    this.count = new Int32Array(cap);    // bodies under this node
    this.used = 0;
    this.stack = new Int32Array(4096);
  }

  newNode(x, y, s) {
    if (this.used + 4 > this.cap) this.grow();
    const i = this.used++;
    this.cx[i] = x; this.cy[i] = y; this.size[i] = s;
    this.mass[i] = 0; this.comX[i] = 0; this.comY[i] = 0;
    this.child[i] = -1; this.count[i] = 0;
    return i;
  }

  grow() {
    const old = { cx: this.cx, cy: this.cy, size: this.size, mass: this.mass,
                  comX: this.comX, comY: this.comY, child: this.child, count: this.count };
    const used = this.used;
    this.alloc(this.cap * 2);
    this.cx.set(old.cx); this.cy.set(old.cy); this.size.set(old.size);
    this.mass.set(old.mass); this.comX.set(old.comX); this.comY.set(old.comY);
    this.child.set(old.child); this.count.set(old.count);
    this.used = used;
  }

  build() {
    this.used = 0;
    if (n === 0) { this.root = -1; return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (px[i] < minX) minX = px[i];
      if (px[i] > maxX) maxX = px[i];
      if (py[i] < minY) minY = py[i];
      if (py[i] > maxY) maxY = py[i];
    }
    const size = Math.max(maxX - minX, maxY - minY) * 1.01 + 1;
    this.root = this.newNode((minX + maxX) / 2, (minY + maxY) / 2, size);
    for (let i = 0; i < n; i++) this.insert(this.root, i, 0);
    // Normalize centroids: comX held mass-weighted sums during insertion.
    for (let k = 0; k < this.used; k++) {
      if (this.mass[k] > 0) { this.comX[k] /= this.mass[k]; this.comY[k] /= this.mass[k]; }
    }
  }

  insert(node, b, depth) {
    const m = ms[b], x = px[b], y = py[b];
    for (;;) {
      this.mass[node] += m;
      this.comX[node] += m * x;
      this.comY[node] += m * y;
      this.count[node]++;

      if (this.count[node] === 1) return;                 // empty leaf claims body
      if (this.child[node] === -1) {
        // Occupied leaf. At max depth, coincident bodies merge into the
        // node aggregate — softening keeps the force finite anyway.
        if (depth >= MAX_DEPTH) return;
        // Subdivide and push the resident body (centroid sums minus the
        // incoming body recover its position) down one level.
        const rm = this.mass[node] - m;
        const rx = (this.comX[node] - m * x) / rm;
        const ry = (this.comY[node] - m * y) / rm;
        const base = this.used;
        const h = this.size[node] / 2, q = h / 2;
        this.newNode(this.cx[node] - q, this.cy[node] - q, h);
        this.newNode(this.cx[node] + q, this.cy[node] - q, h);
        this.newNode(this.cx[node] - q, this.cy[node] + q, h);
        this.newNode(this.cx[node] + q, this.cy[node] + q, h);
        this.child[node] = base;
        const rq = base + (rx >= this.cx[node] ? 1 : 0) + (ry >= this.cy[node] ? 2 : 0);
        this.cxSeed(rq, rx, ry, rm);
      }
      const c = this.child[node];
      node = c + (x >= this.cx[node] ? 1 : 0) + (y >= this.cy[node] ? 2 : 0);
      depth++;
    }
  }

  // Place an already-counted body directly into an empty child quadrant.
  cxSeed(node, x, y, m) {
    this.mass[node] = m;
    this.comX[node] = m * x;
    this.comY[node] = m * y;
    this.count[node] = 1;
  }

  // Acceleration on point (x, y) excluding nothing — a body's own leaf
  // contributes zero force because its centroid coincides with it.
  accel(x, y, theta2, soft2, out) {
    let ax = 0, ay = 0;
    if (this.root === -1) { out.x = 0; out.y = 0; return; }
    const stack = this.stack;
    let sp = 0;
    stack[0] = this.root;
    while (sp >= 0) {
      const node = stack[sp--];
      const m = this.mass[node];
      if (m === 0) continue;
      const dx = this.comX[node] - x;
      const dy = this.comY[node] - y;
      const d2 = dx * dx + dy * dy;
      const s = this.size[node];
      if (this.child[node] === -1 || s * s < theta2 * d2) {
        if (d2 > 1e-12) {
          const inv = 1 / ((d2 + soft2) * Math.sqrt(d2 + soft2));
          ax += m * dx * inv;
          ay += m * dy * inv;
        }
      } else {
        const c = this.child[node];
        if (this.mass[c] > 0) stack[++sp] = c;
        if (this.mass[c + 1] > 0) stack[++sp] = c + 1;
        if (this.mass[c + 2] > 0) stack[++sp] = c + 2;
        if (this.mass[c + 3] > 0) stack[++sp] = c + 3;
      }
    }
    out.x = ax;
    out.y = ay;
  }
}

const tree = new QuadTree(1 << 17);

// ---------------------------------------------------------------- simulation
const sim = {
  dt: 0.25,            // base step, set per preset
  substeps: 1,
  softening: 4,
  theta2: 0.81,        // Barnes-Hut theta^2, adapted at runtime to hold 60fps
  theta2Base: 0.81,
  captureRadius: 6,    // black holes swallow bodies inside this
  timeScale: 1,
  paused: false,
  t: 0,                // simulation time
  myrPerT: 1,          // cosmetic display scale
};

const cam = { x: 0, y: 0, zoom: 1 };
const mouse = { x: 0, y: 0, down: false, panning: false, lastX: 0, lastY: 0 };
let tool = 'pan';
let trails = false;

const accOut = { x: 0, y: 0 };

function step(dt) {
  tree.build();
  const { theta2 } = sim;
  const soft2 = sim.softening * sim.softening;

  for (let i = 0; i < n; i++) {
    tree.accel(px[i], py[i], theta2, soft2, accOut);
    vx[i] += accOut.x * dt;
    vy[i] += accOut.y * dt;
  }
  // Gravity-well tool: the cursor pulls like a heavy invisible mass.
  if (mouse.down && tool === 'well' && !mouse.panning) {
    const wx = screenToWorldX(mouse.x), wy = screenToWorldY(mouse.y);
    const wellM = 30000;
    for (let i = 0; i < n; i++) {
      const dx = wx - px[i], dy = wy - py[i];
      const d2 = dx * dx + dy * dy + 400;
      const inv = wellM / (d2 * Math.sqrt(d2));
      vx[i] += dx * inv * dt;
      vy[i] += dy * inv * dt;
    }
  }
  for (let i = 0; i < n; i++) {
    px[i] += vx[i] * dt;
    py[i] += vy[i] * dt;
  }
  sim.t += dt;
  feedBlackHoles();
}

// Black holes swallow what falls in; mass and momentum are conserved.
// Holes are found inline rather than pre-collected because swap-pop
// removal renumbers bodies mid-loop.
function feedBlackHoles() {
  for (let b = 0; b < n; b++) {
    if (type[b] !== TYPE_BH) continue;
    const r = Math.max(sim.captureRadius, rad[b] * 0.7);
    const r2 = r * r;
    for (let i = n - 1; i >= 0; i--) {
      if (i === b || type[i] === TYPE_BH) continue;
      const dx = px[i] - px[b], dy = py[i] - py[b];
      if (dx * dx + dy * dy < r2) {
        const total = ms[b] + ms[i];
        vx[b] = (vx[b] * ms[b] + vx[i] * ms[i]) / total;
        vy[b] = (vy[b] * ms[b] + vy[i] * ms[i]) / total;
        ms[b] = total;
        rad[b] = Math.min(rad[b] + 0.015, 30);
        removeBody(i);
      }
    }
  }
}

// ---------------------------------------------------------------- presets
const rand = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() + Math.random() - 2) / 2;

// Rotating disk of stars around a central black hole, with spiral arm
// seeding and circular velocities from the enclosed mass.
function makeGalaxy(cx, cy, cvx, cvy, stars, radius, bhMass, dir, arms) {
  const bh = addBody(cx, cy, cvx, cvy, bhMass, 6, 0, TYPE_BH, null);
  const starMass = bhMass * 0.6 / stars;       // disk is 60% of the BH mass
  const scale = radius / 3;
  for (let i = 0; i < stars; i++) {
    // Exponential surface density via inverse-ish transform sampling.
    let r = -Math.log(1 - Math.random()) * scale;
    // Inner cutoff keeps orbital periods resolvable at the global timestep;
    // unresolved orbits gain eccentricity and plunge into the hole.
    r = Math.max(Math.max(radius * 0.06, 40), Math.min(r, radius));
    const arm = (i % arms) * (2 * Math.PI / arms);
    const wind = (r / radius) * 3.2 * dir;     // arms wind with radius
    const theta = arm + wind + gauss() * 0.5 + Math.random() * 0.25;
    const x = cx + r * Math.cos(theta);
    const y = cy + r * Math.sin(theta);
    // Enclosed mass: BH + exponential disk profile.
    const u = r / scale;
    const enc = bhMass + starMass * stars * (1 - Math.exp(-u) * (1 + u));
    const v = Math.sqrt(enc / r);
    addBody(x, y,
      cvx - v * Math.sin(theta) * dir,
      cvy + v * Math.cos(theta) * dir,
      starMass, rand(0.6, 1.8), randomStarColor(), TYPE_STAR, null);
  }
  return bh;
}

const PRESETS = {
  galaxy: {
    label: 'SPIRAL GALAXY',
    init() {
      Object.assign(sim, { dt: 0.22, substeps: 1, softening: 6, captureRadius: 6, myrPerT: 0.5 });
      makeGalaxy(0, 0, 0, 0, 9000, 900, 40000, 1, 2);
      cam.zoom = Math.min(W, H) / 2000;
    },
  },

  collision: {
    label: 'GALAXY COLLISION',
    init() {
      Object.assign(sim, { dt: 0.22, substeps: 1, softening: 6, captureRadius: 6, myrPerT: 0.5 });
      makeGalaxy(-750, -260, 2.4, 0.9, 5000, 600, 26000, 1, 2);
      makeGalaxy(750, 260, -2.4, -0.9, 5000, 600, 26000, -1, 2);
      cam.zoom = Math.min(W, H) / 2600;
    },
  },

  solar: {
    label: 'SOLAR SYSTEM',
    init() {
      Object.assign(sim, { dt: 0.05, substeps: 3, softening: 1.5, captureRadius: 4, myrPerT: 0.002 });
      const SUN = 50000;
      addBody(0, 0, 0, 0, SUN, 14, 7, TYPE_NAMED, 'Sol');
      const planets = [
        ['Mercury',  60, 1,  2.0, 5],
        ['Venus',    95, 2,  3.4, 4],
        ['Earth',   130, 3,  3.6, 2],
        ['Mars',    175, 1,  2.6, 6],
        ['Jupiter', 380, 60, 8.0, 5],
        ['Saturn',  540, 35, 7.0, 4],
        ['Uranus',  720, 12, 5.0, 2],
        ['Neptune', 880, 14, 5.0, 1],
      ];
      for (const [name, r, m, size, c] of planets) {
        const a = Math.random() * 2 * Math.PI;
        const v = Math.sqrt(SUN / r);
        addBody(r * Math.cos(a), r * Math.sin(a),
                -v * Math.sin(a), v * Math.cos(a), m, size, c, TYPE_NAMED, name);
      }
      // Asteroid belt and Kuiper belt as near-massless swarms.
      for (let i = 0; i < 2500; i++) {
        const r = rand(215, 320), a = Math.random() * 2 * Math.PI;
        const v = Math.sqrt(SUN / r) * rand(0.97, 1.03);
        addBody(r * Math.cos(a), r * Math.sin(a),
                -v * Math.sin(a), v * Math.cos(a), 0.001, rand(0.3, 0.8), 5, TYPE_STAR, null);
      }
      for (let i = 0; i < 2000; i++) {
        const r = rand(960, 1200), a = Math.random() * 2 * Math.PI;
        const v = Math.sqrt(SUN / r) * rand(0.97, 1.03);
        addBody(r * Math.cos(a), r * Math.sin(a),
                -v * Math.sin(a), v * Math.cos(a), 0.001, rand(0.3, 0.8), 2, TYPE_STAR, null);
      }
      cam.zoom = Math.min(W, H) / 2000;
    },
  },

  cluster: {
    label: 'GLOBULAR CLUSTER',
    init() {
      Object.assign(sim, { dt: 0.25, substeps: 1, softening: 6, captureRadius: 6, myrPerT: 0.5 });
      const N = 7000, a = 220, starM = 1.5, M = N * starM;
      for (let i = 0; i < N; i++) {
        // Plummer sphere radius via inverse transform sampling.
        const u = Math.random();
        let r = a / Math.sqrt(Math.pow(u, -2 / 3) - 1);
        r = Math.min(r, a * 8);
        const th = Math.random() * 2 * Math.PI;
        const x = r * Math.cos(th), y = r * Math.sin(th);
        const enc = M * Math.pow(r, 3) / Math.pow(r * r + a * a, 1.5);
        const v = Math.sqrt(Math.max(enc, 0.01) / Math.max(r, 1)) * rand(0.6, 1.05);
        const tangentSign = Math.random() < 0.5 ? 1 : -1;
        addBody(x, y,
          -v * Math.sin(th) * tangentSign + gauss() * v * 0.3,
          v * Math.cos(th) * tangentSign + gauss() * v * 0.3,
          starM, rand(0.6, 1.8), randomStarColor(), TYPE_STAR, null);
      }
      cam.zoom = Math.min(W, H) / 1600;
    },
  },

  bigbang: {
    label: 'BIG BANG',
    init() {
      Object.assign(sim, { dt: 0.3, substeps: 1, softening: 5, captureRadius: 6, myrPerT: 1 });
      // H0 near the critical expansion rate for this mass: outskirts
      // escape while overdense pockets recollapse into clumps.
      const N = 11000, H0 = 0.45;
      for (let i = 0; i < N; i++) {
        const r = Math.pow(Math.random(), 0.5) * 60;
        const th = Math.random() * 2 * Math.PI;
        const x = r * Math.cos(th), y = r * Math.sin(th);
        // Hubble flow: recession velocity proportional to distance,
        // plus primordial fluctuations that seed later structure.
        addBody(x, y,
          x * H0 + gauss() * 1.4,
          y * H0 + gauss() * 1.4,
          2.2, rand(0.6, 1.6), randomStarColor(), TYPE_STAR, null);
      }
      cam.zoom = Math.min(W, H) / 2400;
    },
  },

  binary: {
    label: 'BINARY BLACK HOLES',
    init() {
      Object.assign(sim, { dt: 0.22, substeps: 1, softening: 5, captureRadius: 6, myrPerT: 0.5 });
      const m = 22000, d = 560;
      // Circular two-body orbit about the barycenter; each side carries
      // its disk too (total 1.6m), hence the factor under the root.
      const v = Math.sqrt(1.6 * m / (2 * d));
      makeGalaxy(-d / 2, 0, 0, v, 5500, 260, m, 1, 2);
      makeGalaxy(d / 2, 0, 0, -v, 5500, 260, m, -1, 2);
      cam.zoom = Math.min(W, H) / 1700;
    },
  },
};

let currentPreset = 'galaxy';

function loadPreset(name) {
  currentPreset = name;
  clearBodies();
  sim.t = 0;
  sim.theta2 = sim.theta2Base;
  cam.x = 0; cam.y = 0;
  PRESETS[name].init();
  paintBackground();
  toast(PRESETS[name].label);
  document.querySelectorAll('[data-preset]').forEach(b =>
    b.classList.toggle('active', b.dataset.preset === name));
}

// ---------------------------------------------------------------- camera
function screenToWorldX(sx) { return (sx - W / 2) / cam.zoom + cam.x; }
function screenToWorldY(sy) { return (sy - H / 2) / cam.zoom + cam.y; }

// ---------------------------------------------------------------- render
// Distant static backdrop, regenerated on reset/resize.
let bgCanvas = null;
function paintBackground() {
  bgCanvas = document.createElement('canvas');
  bgCanvas.width = W * DPR;
  bgCanvas.height = H * DPR;
  const b = bgCanvas.getContext('2d');
  b.scale(DPR, DPR);
  b.fillStyle = '#020208';
  b.fillRect(0, 0, W, H);
  // Faint nebula washes.
  for (let i = 0; i < 4; i++) {
    const x = rand(0, W), y = rand(0, H), r = rand(200, 500);
    const g = b.createRadialGradient(x, y, 0, x, y, r);
    const hue = rand(200, 290);
    g.addColorStop(0, `hsla(${hue}, 60%, 30%, 0.05)`);
    g.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
    b.fillStyle = g;
    b.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Pinprick background stars.
  for (let i = 0; i < 300; i++) {
    const a = Math.random() * 0.5 + 0.1;
    b.fillStyle = `rgba(255,255,255,${a})`;
    b.fillRect(rand(0, W), rand(0, H), 1, 1);
  }
}

function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  if (trails) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(2, 2, 8, 0.12)';
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bgCanvas, 0, 0);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  ctx.globalCompositeOperation = 'lighter';
  const z = cam.zoom, hw = W / 2, hh = H / 2;
  const camX = cam.x, camY = cam.y;
  const margin = 40;

  for (let i = 0; i < n; i++) {
    const sx = (px[i] - camX) * z + hw;
    const sy = (py[i] - camY) * z + hh;
    if (sx < -margin || sx > W + margin || sy < -margin || sy > H + margin) continue;
    const t = type[i];
    if (t === TYPE_BH) continue; // drawn after stars, on top
    let s = rad[i] * z * 3;
    if (s < 1.1) s = 1.1;
    if (s > 90) s = 90;
    ctx.drawImage(sprites[colIdx[i]], sx - s, sy - s, s * 2, s * 2);
  }

  // Black holes: glow ring + event horizon.
  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < n; i++) {
    if (type[i] !== TYPE_BH) continue;
    const sx = (px[i] - camX) * z + hw;
    const sy = (py[i] - camY) * z + hh;
    if (sx < -100 || sx > W + 100 || sy < -100 || sy > H + 100) continue;
    const r = Math.max(rad[i] * z, 3);
    ctx.globalCompositeOperation = 'lighter';
    const halo = sprites[8];
    const hs = r * 5;
    ctx.drawImage(halo, sx - hs, sy - hs, hs * 2, hs * 2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, 2 * Math.PI);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160, 210, 255, 0.8)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // Labels for named bodies once zoomed in enough to read them.
  if (z * 60 > 18) {
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(205, 214, 244, 0.75)';
    ctx.textAlign = 'center';
    for (let i = 0; i < n; i++) {
      if (!names[i]) continue;
      const sx = (px[i] - camX) * z + hw;
      const sy = (py[i] - camY) * z + hh;
      if (sx < 0 || sx > W || sy < 0 || sy > H) continue;
      ctx.fillText(names[i], sx, sy - rad[i] * z - 7);
    }
  }

  // Gravity-well cursor ring.
  if (mouse.down && tool === 'well' && !mouse.panning) {
    ctx.beginPath();
    ctx.arc(mouse.x, mouse.y, 18 + Math.sin(performance.now() / 120) * 4, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(122, 162, 255, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- main loop
let lastFrame = performance.now();
let fpsSmooth = 60;

function frame(now) {
  const elapsed = Math.min(now - lastFrame, 50);
  lastFrame = now;
  fpsSmooth += (1000 / Math.max(elapsed, 1) - fpsSmooth) * 0.05;

  if (!sim.paused && sim.timeScale > 0) {
    const dt = sim.dt * sim.timeScale / sim.substeps;
    for (let s = 0; s < sim.substeps; s++) step(dt);
  }

  // Adaptive quality: coarsen the Barnes-Hut opening angle when the frame
  // rate sags, restore accuracy when there's headroom.
  if (fpsSmooth < 45) sim.theta2 = Math.min(sim.theta2 * 1.02, 2.25);
  else if (fpsSmooth > 55) sim.theta2 = Math.max(sim.theta2 * 0.99, sim.theta2Base);

  render();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- UI
const $ = (id) => document.getElementById(id);

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.style.opacity = 1;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.style.opacity = 0; }, 1600);
}

document.querySelectorAll('[data-preset]').forEach(btn =>
  btn.addEventListener('click', () => loadPreset(btn.dataset.preset)));

document.querySelectorAll('[data-tool]').forEach(btn =>
  btn.addEventListener('click', () => {
    tool = btn.dataset.tool;
    document.querySelectorAll('[data-tool]').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === tool));
    canvas.className = tool === 'pan' ? '' : 'tool-' + tool;
  }));

$('speed').addEventListener('input', (e) => {
  sim.timeScale = e.target.value / 100;
  $('speedVal').textContent = sim.timeScale.toFixed(1) + 'x';
});

function setPaused(p) {
  sim.paused = p;
  $('pauseBtn').textContent = p ? 'Resume' : 'Pause';
  $('pauseBtn').classList.toggle('active', p);
}

function setTrails(t) {
  trails = t;
  $('trailsBtn').classList.toggle('active', t);
  if (!t) paintBackground();
}

$('pauseBtn').addEventListener('click', () => setPaused(!sim.paused));
$('trailsBtn').addEventListener('click', () => setTrails(!trails));
$('resetBtn').addEventListener('click', () => loadPreset(currentPreset));

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  switch (e.key) {
    case ' ': e.preventDefault(); setPaused(!sim.paused); break;
    case 't': setTrails(!trails); break;
    case 'r': loadPreset(currentPreset); break;
    default: {
      const k = parseInt(e.key, 10);
      const keys = Object.keys(PRESETS);
      if (k >= 1 && k <= keys.length) loadPreset(keys[k - 1]);
    }
  }
});

// Pointer interaction: left-drag uses the active tool, pan is the default.
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  mouse.down = true;
  mouse.x = e.clientX; mouse.y = e.clientY;
  mouse.lastX = e.clientX; mouse.lastY = e.clientY;
  mouse.panning = (tool === 'pan') || e.button !== 0;
  if (mouse.panning) canvas.classList.add('grabbing');
  if (tool === 'bh' && e.button === 0) {
    addBody(screenToWorldX(e.clientX), screenToWorldY(e.clientY),
            0, 0, 6000, 3, 0, TYPE_BH, null);
    toast('BLACK HOLE SPAWNED');
  }
});

canvas.addEventListener('pointermove', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (mouse.down && mouse.panning) {
    cam.x -= (e.clientX - mouse.lastX) / cam.zoom;
    cam.y -= (e.clientY - mouse.lastY) / cam.zoom;
  }
  mouse.lastX = e.clientX; mouse.lastY = e.clientY;
});

canvas.addEventListener('pointerup', () => {
  mouse.down = false;
  mouse.panning = false;
  canvas.classList.remove('grabbing');
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0012);
  const wx = screenToWorldX(e.clientX), wy = screenToWorldY(e.clientY);
  cam.zoom = Math.max(0.02, Math.min(cam.zoom * factor, 60));
  // Keep the world point under the cursor fixed while zooming.
  cam.x = wx - (e.clientX - W / 2) / cam.zoom;
  cam.y = wy - (e.clientY - H / 2) / cam.zoom;
}, { passive: false });

window.addEventListener('resize', paintBackground);

// Stats readout, throttled.
setInterval(() => {
  $('stBodies').textContent = n.toLocaleString();
  $('stTime').textContent = (sim.t * sim.myrPerT).toFixed(1) + ' Myr';
  $('stFps').textContent = Math.round(fpsSmooth);
}, 300);

// ---------------------------------------------------------------- go
loadPreset('galaxy');
requestAnimationFrame(frame);
