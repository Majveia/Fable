'use strict';
/* ============================================================
   FABLE UNIVERSE v5 — WebGPU compute engine (js/webgpu/compute.js)

   WGSL transcription of the proven WebGL2 hybrid (physics-gpu.js):
   the CPU rebuilds the Barnes-Hut octree from the massive bodies
   (slot-frozen in the Bodies store — the mirror), TreePack flattens
   it, and a compute pass integrates EVERY body against it with the
   stackless hit/miss traversal. DKD leapfrog, dark-matter halos,
   pull well, in-shader tracer capture — all semantics identical.

   Differences from the GL version, all simplifications:
   - Storage buffers instead of textures; no 2048-wide indexing games.
   - Integration is IN PLACE (each invocation owns its slot; forces
     come from the tree buffer) — no ping-pong, stable buffer
     identities for the renderer.
   - Readback via copyBufferToBuffer -> mapAsync staging ring (2),
     truly asynchronous; the mirror runs a frame or two stale.

   Slot layout identical: [0, M) massive · [M, M+SPARE) spare
   massive · [M+SPARE, …) tracers · trailing TRACER_POOL remnant
   shells. posBuf[i].w is the alive flag (>= 0 alive, < 0 dead).
   ============================================================ */
(function () {
  const SPARE = 64;
  const TRACER_POOL = 16384;
  const MAX_BH = 16;
  const MAX_HALO = 64;
  const WG = 64;

  const KERNEL = /* wgsl */`
struct SimParams {
  dt: f32, soft2: f32, thetaM: f32, thetaT: f32,
  count: u32, massiveCount: u32, nbh: u32, nhalo: u32,
  pull: vec4f,
}
@group(0) @binding(0) var<storage, read_write> pos: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> vel: array<vec4f>;
@group(0) @binding(2) var<storage, read> tree: array<vec4f>;
@group(0) @binding(3) var<uniform> P: SimParams;
@group(0) @binding(4) var<storage, read> bhs: array<vec4f>;
@group(0) @binding(5) var<storage, read> halos: array<vec4f>;  // A,B interleaved

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid.x;
  if (id >= P.count) { return; }
  let pm = pos[id];
  let vt = vel[id];
  if (pm.w < 0.0) { return; }

  // Drift-kick-drift leapfrog (2nd-order symplectic). The tree was
  // built from start-of-step mirror positions; the half-drift offset
  // is below the opening-angle error.
  var v = vt.xyz;
  var p = pm.xyz + v * (P.dt * 0.5);
  let theta2 = select(P.thetaT, P.thetaM, id < P.massiveCount);
  var a = vec3f(0.0);

  // Stackless Barnes-Hut: hit pointer descends, miss pointer escapes.
  var i: i32 = 0;
  for (var it = 0; it < 8192; it++) {
    if (i < 0) { break; }
    let t0 = tree[u32(i) * 2u];        // com.xyz, mass
    let t1 = tree[u32(i) * 2u + 1u];   // size2, hit, miss, -
    let d = t0.xyz - p;
    let d2 = dot(d, d);
    if (t1.y >= 0.0 && t1.x >= theta2 * d2) {
      i = i32(t1.y);                   // open node
    } else {
      if (d2 > 1e-9) {
        let inv = t0.w / ((d2 + P.soft2) * sqrt(d2 + P.soft2));
        a += d * inv;
      }
      i = i32(t1.z);                   // escape
    }
  }

  // Dark-matter halos: cored isothermal, Keplerian beyond rMax.
  for (var h = 0u; h < P.nhalo; h++) {
    let A = halos[h * 2u];
    let B = halos[h * 2u + 1u];
    let d = A.xyz - p;
    let r2 = dot(d, d);
    var f = A.w / (r2 + B.x);
    if (r2 > B.y) { f *= B.y / r2; }
    a += d * f;
  }

  if (P.pull.w > 0.0) {
    let d = P.pull.xyz - p;
    let d2 = dot(d, d) + 400.0;
    a += d * (P.pull.w / (d2 * sqrt(d2)));
  }

  v += a * P.dt;
  p += v * (P.dt * 0.5);

  var alive = pm.w;
  if (id >= P.massiveCount) {
    for (var k = 0u; k < P.nbh; k++) {
      let d = p - bhs[k].xyz;
      if (dot(d, d) < bhs[k].w * bhs[k].w) { alive = -1.0; break; }
    }
  }
  pos[id] = vec4f(p, alive);
  vel[id] = vec4f(v, vt.w);
}`;

  let device = null;
  let pipeline = null, bindGroup = null;
  let posBuf = null, velBuf = null, treeBuf = null, attribBuf = null;
  let simU = null, bhBuf = null, haloBuf = null;
  let staging = [];                 // ring of {buf, state: 'free'|'pending'|'ready', bytes}
  let maxBodies = 0, maxNodes = 0;
  let massiveSlots = 0, deadMassive = 0;
  let poolStart = 0, poolNext = 0, poolUsed = 0;
  let treeF32 = null, attribData = null;
  const simData = new Float32Array(12);          // 48 bytes (u32 view shares)
  const simU32 = new Uint32Array(simData.buffer);
  const bhData = new Float32Array(MAX_BH * 4);
  const haloData = new Float32Array(MAX_HALO * 8);
  const texel = new Float32Array(4);

  function writeSlot(buf, slot, a, b, c, d) {
    texel[0] = a; texel[1] = b; texel[2] = c; texel[3] = d;
    device.queue.writeBuffer(buf, slot * 16, texel);
  }

  const PhysicsWGPU = {
    cfg: {
      dt: 0.25, substeps: 1, softening: 4,
      theta2: 1.21, theta2Base: 1.21,
      captureRadius: 6, massiveMin: 0.01,
      timeScale: 1, paused: false, t: 0, myrPerT: 1,
    },

    tree: null,
    posBuf: null, velBuf: null, attribBuf: null,
    count: 0,
    massiveCount: 0,
    attribsVersion: 0,
    pull: null,

    init(wgpu, opts) {
      if (!wgpu || !wgpu.device || !globalThis.Octree || !globalThis.TreePack) return false;
      device = wgpu.device;
      try {
        maxBodies = Math.min((opts && opts.maxBodies) || (1 << 21),
                             wgpu.maxBodiesCap || (1 << 21));
        maxNodes = 1 << 18;
        const B = GPUBufferUsage;
        const mk = (bytes, usage) => device.createBuffer({ size: bytes, usage });
        posBuf = mk(maxBodies * 16, B.STORAGE | B.COPY_DST | B.COPY_SRC);
        velBuf = mk(maxBodies * 16, B.STORAGE | B.COPY_DST | B.COPY_SRC);
        attribBuf = mk(maxBodies * 16, B.STORAGE | B.COPY_DST);
        treeBuf = mk(maxNodes * 32, B.STORAGE | B.COPY_DST);
        simU = mk(48, B.UNIFORM | B.COPY_DST);
        bhBuf = mk(MAX_BH * 16, B.STORAGE | B.COPY_DST);
        haloBuf = mk(MAX_HALO * 32, B.STORAGE | B.COPY_DST);

        const module = device.createShaderModule({ code: KERNEL });
        pipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module, entryPoint: 'main' },
        });
        bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: posBuf } },
            { binding: 1, resource: { buffer: velBuf } },
            { binding: 2, resource: { buffer: treeBuf } },
            { binding: 3, resource: { buffer: simU } },
            { binding: 4, resource: { buffer: bhBuf } },
            { binding: 5, resource: { buffer: haloBuf } },
          ],
        });
        this.tree = new globalThis.Octree(1 << 17);
        treeF32 = new Float32Array(maxNodes * 8);
        this.posBuf = posBuf; this.velBuf = velBuf; this.attribBuf = attribBuf;
        return true;
      } catch (e) {
        console.warn('PhysicsWGPU init failed:', e.message);
        return false;
      }
    },

    /* Partition the staged Bodies store; massive bodies REMAIN in
       Bodies as the CPU mirror (slot-frozen). Same scheme as the GL
       engine, with the remnant pool at the tail. */
    upload() {
      const B = globalThis.Bodies;
      const c = this.cfg;
      const n = B.n;
      const massiveIdx = [], tracerIdx = [];
      for (let i = 0; i < n; i++) {
        if (B.mass[i] >= c.massiveMin || B.type[i] === B.TYPE_BH) massiveIdx.push(i);
        else tracerIdx.push(i);
      }
      const M = massiveIdx.length;
      massiveSlots = M + SPARE;
      const nTracers = Math.min(tracerIdx.length, maxBodies - massiveSlots - TRACER_POOL);
      const total = massiveSlots + nTracers + TRACER_POOL;
      deadMassive = 0;
      poolStart = massiveSlots + nTracers;
      poolNext = poolStart;
      poolUsed = 0;

      const pos = new Float32Array(total * 4);
      const velA = new Float32Array(total * 4);
      attribData = new Float32Array(total * 4);

      const tmp = massiveIdx.map(i => [
        B.px[i], B.py[i], B.pz[i], B.vx[i], B.vy[i], B.vz[i],
        B.mass[i], B.rad[i], B.colorIdx[i], B.type[i], B.names[i]]);

      let slot = 0;
      const put = (x, y, z, vx, vy, vz, m, rad, col, type, alive) => {
        const o = slot * 4;
        pos[o] = x; pos[o + 1] = y; pos[o + 2] = z; pos[o + 3] = alive ? m : -1;
        velA[o] = vx; velA[o + 1] = vy; velA[o + 2] = vz; velA[o + 3] = type;
        attribData[o] = rad; attribData[o + 1] = col; attribData[o + 2] = type;
        slot++;
      };
      for (const t of tmp) put(t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8], t[9], true);
      for (let s = 0; s < SPARE; s++) put(0, 0, 0, 0, 0, 0, 0, 0, 0, 255, false);
      for (let k = 0; k < nTracers; k++) {
        const i = tracerIdx[k];
        put(B.px[i], B.py[i], B.pz[i], B.vx[i], B.vy[i], B.vz[i],
            B.mass[i], B.rad[i], B.colorIdx[i], B.type[i], true);
      }
      for (let k = 0; k < TRACER_POOL; k++) put(0, 0, 0, 0, 0, 0, 0, 4, 9, 4, false);

      // Bodies becomes the slot-frozen massive mirror.
      for (let s2 = 0; s2 < massiveSlots; s2++) {
        const t = s2 < M ? tmp[s2] : [0, 0, 0, 0, 0, 0, 0, 0, 0, 255, null];
        B.px[s2] = t[0]; B.py[s2] = t[1]; B.pz[s2] = t[2];
        B.vx[s2] = t[3]; B.vy[s2] = t[4]; B.vz[s2] = t[5];
        B.mass[s2] = t[6]; B.rad[s2] = t[7]; B.colorIdx[s2] = t[8];
        B.type[s2] = t[9]; B.names[s2] = t[10];
      }
      B.n = massiveSlots;

      device.queue.writeBuffer(posBuf, 0, pos);
      device.queue.writeBuffer(velBuf, 0, velA);
      device.queue.writeBuffer(attribBuf, 0, attribData);

      // Staging ring sized to the massive region (pos + vel back-to-back).
      for (const s of staging) s.buf.destroy();
      staging = [];
      const mBytes = massiveSlots * 16;
      for (let k = 0; k < 2; k++) {
        staging.push({
          buf: device.createBuffer({
            size: mBytes * 2,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          }),
          state: 'free',
        });
      }

      this.count = total;
      this.massiveCount = massiveSlots;
      this.attribsVersion++;
      return { count: total, massiveCount: massiveSlots };
    },

    frame() {
      const c = this.cfg;
      if (c.paused || c.timeScale <= 0 || this.count === 0 || !device) return;
      const B = globalThis.Bodies;
      const mBytes = massiveSlots * 16;

      // ---- 1. consume any staging buffer whose mapAsync resolved
      for (const s of staging) {
        if (s.state !== 'ready') continue;
        const data = new Float32Array(s.buf.getMappedRange());
        for (let i = 0; i < massiveSlots; i++) {
          if (B.type[i] === 255 || B.mass[i] <= 0) continue;
          const o = i * 4, ov = massiveSlots * 4 + i * 4;
          B.px[i] = data[o]; B.py[i] = data[o + 1]; B.pz[i] = data[o + 2];
          B.vx[i] = data[ov]; B.vy[i] = data[ov + 1]; B.vz[i] = data[ov + 2];
        }
        s.buf.unmap();
        s.state = 'free';
        break;
      }

      // ---- 2. massive-vs-massive capture on the mirror
      for (let b = 0; b < massiveSlots; b++) {
        if (B.type[b] !== B.TYPE_BH || B.mass[b] <= 0) continue;
        const r = Math.max(c.captureRadius, B.rad[b] * 0.7);
        const r2 = r * r;
        for (let i = 0; i < massiveSlots; i++) {
          if (i === b || B.type[i] === B.TYPE_BH || B.type[i] === 255 || B.mass[i] <= 0) continue;
          const dx = B.px[i] - B.px[b], dy = B.py[i] - B.py[b], dz = B.pz[i] - B.pz[b];
          if (dx * dx + dy * dy + dz * dz < r2) {
            const total = B.mass[b] + B.mass[i];
            B.vx[b] = (B.vx[b] * B.mass[b] + B.vx[i] * B.mass[i]) / total;
            B.vy[b] = (B.vy[b] * B.mass[b] + B.vy[i] * B.mass[i]) / total;
            B.vz[b] = (B.vz[b] * B.mass[b] + B.vz[i] * B.mass[i]) / total;
            B.mass[b] = total;
            B.rad[b] = Math.min(B.rad[b] + 0.015, 30);
            B.mass[i] = 0;
            deadMassive++;
            writeSlot(posBuf, i, B.px[i], B.py[i], B.pz[i], -1);
            writeSlot(velBuf, b, B.vx[b], B.vy[b], B.vz[b], B.type[b]);
          }
        }
      }

      // ---- 3. halos follow their black holes; tree rebuild + upload
      const DM = globalThis.DarkMatter;
      const halos = DM && DM.on ? DM.list : [];
      const nh = Math.min(halos.length, MAX_HALO);
      if (nh && globalThis.updateHaloCenters) globalThis.updateHaloCenters(B, halos);
      for (let h = 0; h < nh; h++) {
        const o = h * 8;
        haloData[o] = halos[h].x; haloData[o + 1] = halos[h].y;
        haloData[o + 2] = halos[h].z; haloData[o + 3] = halos[h].v02;
        haloData[o + 4] = halos[h].rc2; haloData[o + 5] = halos[h].rMax2;
      }
      if (nh) device.queue.writeBuffer(haloBuf, 0, haloData, 0, nh * 8);

      this.tree.build(c.massiveMin);
      const { data, nodeCount } = globalThis.TreePack.flatten(this.tree, treeF32);
      if (nodeCount > 0) {
        device.queue.writeBuffer(treeBuf, 0, data, 0, Math.min(nodeCount * 8, maxNodes * 8));
      } else {
        // Sentinel empty node: zero mass, no children, immediate escape.
        device.queue.writeBuffer(treeBuf, 0,
          new Float32Array([0, 0, 0, 0, 0, -1, -1, -1]));
      }

      // ---- 4. black-hole capture list
      const bhsList = this.blackHoleList();
      const nbh = Math.min(bhsList.length, MAX_BH);
      for (let k = 0; k < nbh; k++) {
        bhData[k * 4] = bhsList[k].x; bhData[k * 4 + 1] = bhsList[k].y;
        bhData[k * 4 + 2] = bhsList[k].z;
        bhData[k * 4 + 3] = Math.max(c.captureRadius, bhsList[k].rad * 0.7);
      }
      if (nbh) device.queue.writeBuffer(bhBuf, 0, bhData, 0, nbh * 4);

      // ---- 5. uniforms + compute passes
      const dt = c.dt * c.timeScale / c.substeps;
      simData[0] = dt;
      simData[1] = c.softening * c.softening;
      simData[2] = c.theta2;
      simData[3] = Math.max(2.25, c.theta2 * 2);
      simU32[4] = this.count;
      simU32[5] = massiveSlots;
      simU32[6] = nbh;
      simU32[7] = nh;
      const p = this.pull;
      simData[8] = p ? p.x : 0; simData[9] = p ? p.y : 0;
      simData[10] = p ? p.z : 0; simData[11] = p ? p.mass : 0;
      device.queue.writeBuffer(simU, 0, simData);

      const enc = device.createCommandEncoder();
      const groups = Math.ceil(this.count / WG);
      for (let s = 0; s < c.substeps; s++) {
        const pass = enc.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(groups);
        pass.end();
        c.t += dt;
      }

      // ---- 6. start the next async readback if a staging slot is free
      const free = staging.find(s => s.state === 'free');
      if (free) {
        enc.copyBufferToBuffer(posBuf, 0, free.buf, 0, mBytes);
        enc.copyBufferToBuffer(velBuf, 0, free.buf, mBytes, mBytes);
        free.state = 'pending';
      }
      device.queue.submit([enc.finish()]);
      if (free) {
        free.buf.mapAsync(GPUMapMode.READ)
          .then(() => { free.state = 'ready'; })
          .catch(() => { free.state = 'free'; });
      }
    },

    /* Supernova remnant shell: gas tracers through the recycled pool. */
    addBurst(x, y, z, vx, vy, vz, count) {
      if (!device || TRACER_POOL === 0) return;
      for (let k = 0; k < count; k++) {
        const slot = poolNext;
        poolNext = poolStart + ((poolNext - poolStart + 1) % TRACER_POOL);
        if (poolUsed < TRACER_POOL) poolUsed++;
        const ct = 2 * Math.random() - 1, st = Math.sqrt(1 - ct * ct);
        const ph = 2 * Math.PI * Math.random();
        const dx = st * Math.cos(ph), dy = ct, dz = st * Math.sin(ph);
        const sp = 2.5 + Math.random() * 3.5;
        const r0 = 1 + Math.random() * 5;
        writeSlot(posBuf, slot, x + dx * r0, y + dy * r0, z + dz * r0, 0.0001);
        writeSlot(velBuf, slot, vx + dx * sp, vy + dy * sp, vz + dz * sp, 4);
        const rad = 2.5 + Math.random() * 4.5;
        const col = Math.random() < 0.5 ? 9 : 10;
        attribData[slot * 4] = rad; attribData[slot * 4 + 1] = col; attribData[slot * 4 + 2] = 4;
        writeSlot(attribBuf, slot, rad, col, 4, 0);
      }
      this.attribsVersion++;
    },

    addMassive(x, y, z, vx, vy, vz, m, rad, col, type) {
      const B = globalThis.Bodies;
      for (let s = 0; s < massiveSlots; s++) {
        if (B.type[s] !== 255) continue;
        B.px[s] = x; B.py[s] = y; B.pz[s] = z;
        B.vx[s] = vx; B.vy[s] = vy; B.vz[s] = vz;
        B.mass[s] = m; B.rad[s] = rad; B.colorIdx[s] = col; B.type[s] = type;
        writeSlot(posBuf, s, x, y, z, m);
        writeSlot(velBuf, s, vx, vy, vz, type);
        attribData[s * 4] = rad; attribData[s * 4 + 1] = col; attribData[s * 4 + 2] = type;
        writeSlot(attribBuf, s, rad, col, type, 0);
        this.attribsVersion++;
        return s;
      }
      return -1;
    },

    setPull(x, y, z, mass) { this.pull = { x, y, z, mass }; },
    clearPull() { this.pull = null; },

    adaptQuality(fps) {
      const c = this.cfg;
      if (fps < 45) c.theta2 = Math.min(c.theta2 * 1.02, 2.25);
      else if (fps > 55) c.theta2 = Math.max(c.theta2 * 0.99, c.theta2Base);
    },

    bodyCount() { return this.count - SPARE - deadMassive - (TRACER_POOL - poolUsed); },
    simTimeMyr() { return this.cfg.t * this.cfg.myrPerT; },

    evolutionView() {
      const B = globalThis.Bodies;
      const self = this;
      return {
        get n() { return massiveSlots; },
        mass: B.mass, rad: B.rad, colorIdx: B.colorIdx, type: B.type,
        setDirty() {
          for (let i = 0; i < massiveSlots; i++) {
            attribData[i * 4] = B.rad[i];
            attribData[i * 4 + 1] = B.colorIdx[i];
            attribData[i * 4 + 2] = B.type[i];
          }
          device.queue.writeBuffer(attribBuf, 0, attribData, 0, massiveSlots * 4);
          self.attribsVersion++;
        },
      };
    },

    blackHoleList() {
      const B = globalThis.Bodies;
      const out = [];
      for (let i = 0; i < massiveSlots; i++) {
        if (B.type[i] !== B.TYPE_BH || B.mass[i] <= 0) continue;
        out.push({ x: B.px[i], y: B.py[i], z: B.pz[i], mass: B.mass[i], rad: B.rad[i] });
      }
      out.sort((a, b) => b.mass - a.mass);
      return out;
    },
  };

  globalThis.PhysicsWGPU = PhysicsWGPU;
})();
