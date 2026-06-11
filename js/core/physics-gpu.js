'use strict';
/* ============================================================
   FABLE UNIVERSE v3 — GPU N-body engine (js/core/physics-gpu.js)

   Hybrid Barnes-Hut: the CPU rebuilds the octree each frame from
   the MASSIVE bodies only (they stay resident in the Bodies store,
   slot-frozen — no swap-pop), TreePack flattens it into a texture,
   and a fragment shader integrates EVERY body (massive + tracer,
   up to 2^19) against that tree with a stackless escape-pointer
   traversal. Positions/velocities live in ping-pong RGBA32F
   textures the renderer reads directly.

   Slot layout: [0, M) massive · [M, M+SPARE) dormant massive
   slots for runtime additions · [M+SPARE, count) tracers.

   posTex.w is an alive flag (>= 0 alive, < 0 dead), NOT a live
   mass: acceleration is independent of a body's own mass, the
   tree carries CPU-authoritative masses, and tracers are
   massless — so stellar evolution can change masses on the CPU
   mirror without any GPU sync. (Deviation from the v3 contract,
   for the better.)

   Tracer capture happens in-shader against the ≤16 heaviest black
   holes; massive-vs-massive capture happens on the CPU mirror
   after readback, conserving mass and momentum.
   ============================================================ */
(function () {
  const TEXW = 2048;
  const SPARE = 64;
  const MAX_TRAV = 8192;
  const MAX_BH = 16;
  const PULL_SOFT2 = 400;

  const VS = `#version 300 es
  void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const FS = `#version 300 es
  precision highp float;
  precision highp int;
  uniform sampler2D u_pos;
  uniform sampler2D u_vel;
  uniform sampler2D u_tree;
  uniform int u_count;
  uniform int u_massiveCount;
  uniform float u_dt;
  uniform float u_soft2;
  uniform float u_thetaM;
  uniform float u_thetaT;
  uniform vec4 u_pull;                  // xyz + mass (0 = off)
  uniform int u_nbh;
  uniform vec4 u_bh[${MAX_BH}];         // xyz + capture radius
  layout(location = 0) out vec4 oPos;
  layout(location = 1) out vec4 oVel;

  ivec2 tc(int i) { return ivec2(i & ${TEXW - 1}, i >> 11); }

  void main() {
    int id = int(gl_FragCoord.x) + (int(gl_FragCoord.y) << 11);
    vec4 pm = texelFetch(u_pos, tc(id), 0);
    vec4 vt = texelFetch(u_vel, tc(id), 0);
    if (id >= u_count || pm.w < 0.0) { oPos = pm; oVel = vt; return; }
    vec3 p = pm.xyz;
    vec3 v = vt.xyz;
    float theta2 = id < u_massiveCount ? u_thetaM : u_thetaT;
    vec3 a = vec3(0.0);

    // Stackless Barnes-Hut: hit pointer descends, miss pointer escapes.
    int i = 0;
    for (int it = 0; it < ${MAX_TRAV}; it++) {
      if (i < 0) break;
      vec4 t0 = texelFetch(u_tree, tc(i * 2), 0);      // com.xyz, mass
      vec4 t1 = texelFetch(u_tree, tc(i * 2 + 1), 0);  // size2, hit, miss, -
      vec3 d = t0.xyz - p;
      float d2 = dot(d, d);
      if (t1.y >= 0.0 && t1.x >= theta2 * d2) {
        i = int(t1.y);                                  // open node
      } else {
        if (d2 > 1e-9) {
          float inv = t0.w / ((d2 + u_soft2) * sqrt(d2 + u_soft2));
          a += d * inv;
        }
        i = int(t1.z);                                  // escape
      }
    }

    if (u_pull.w > 0.0) {
      vec3 d = u_pull.xyz - p;
      float d2 = dot(d, d) + ${PULL_SOFT2}.0;
      a += d * (u_pull.w / (d2 * sqrt(d2)));
    }

    v += a * u_dt;
    p += v * u_dt;

    float alive = pm.w;
    if (id >= u_massiveCount) {
      for (int k = 0; k < ${MAX_BH}; k++) {
        if (k >= u_nbh) break;
        vec3 d = p - u_bh[k].xyz;
        if (dot(d, d) < u_bh[k].w * u_bh[k].w) { alive = -1.0; break; }
      }
    }
    oPos = vec4(p, alive);
    oVel = vec4(v, vt.w);
  }`;

  let gl = null;
  let prog = null, vao = null, uni = {};
  let texPos = [null, null], texVel = [null, null], texTree = null;
  let front = 0;
  let simFBO = null, readFBO = null;
  let rows = 0, treeRows = 0;
  let treeBuf = null, readPosBuf = null, readVelBuf = null;
  let uploadBuf = null;
  let massiveSlots = 0;     // live massive region incl. spares
  let deadMassive = 0;
  const bhUniform = new Float32Array(MAX_BH * 4);

  function makeTex(w, h) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('PhysicsGPU shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  const PhysicsGPU = {
    cfg: {
      dt: 0.25, substeps: 1, softening: 4,
      theta2: 1.21, theta2Base: 1.21,
      captureRadius: 6, massiveMin: 0.01,
      timeScale: 1, paused: false, t: 0, myrPerT: 1,
    },

    tree: null,             // shared Octree instance (over the Bodies mirror)
    posTex: null,
    count: 0,
    massiveCount: 0,
    staticAttribs: null,
    attribsVersion: 0,
    pull: null,

    init(glCtx, opts) {
      gl = glCtx;
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return false;
      const maxBodies = (opts && opts.maxBodies) || (1 << 19);
      rows = Math.ceil(maxBodies / TEXW);
      // Tree texture: 2 texels per node; clustered octrees stay well
      // under 3 nodes per body in practice — allocate 4x for safety.
      const maxNodes = Math.min(4 * 40000 + 8 * 1024, 1 << 18);
      treeRows = Math.ceil(maxNodes * 2 / TEXW);
      try {
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          throw new Error('PhysicsGPU link: ' + gl.getProgramInfoLog(prog));
        }
        for (const u of ['u_pos', 'u_vel', 'u_tree', 'u_count', 'u_massiveCount',
                         'u_dt', 'u_soft2', 'u_thetaM', 'u_thetaT', 'u_pull',
                         'u_nbh', 'u_bh']) {
          uni[u] = gl.getUniformLocation(prog, u);
        }
        vao = gl.createVertexArray();
        for (const k of [0, 1]) {
          texPos[k] = makeTex(TEXW, rows);
          texVel[k] = makeTex(TEXW, rows);
        }
        texTree = makeTex(TEXW, treeRows);
        simFBO = gl.createFramebuffer();
        readFBO = gl.createFramebuffer();
        treeBuf = new Float32Array(TEXW * treeRows * 4);
        uploadBuf = new Float32Array(TEXW * rows * 4);
        this.tree = new globalThis.Octree(1 << 17);
        this._maxBodies = maxBodies;
        return true;
      } catch (e) {
        console.warn(e.message);
        prog = null;
        return false;
      }
    },

    /* Partition the staged Bodies store: massive bodies are compacted
       into slots [0, M) and REMAIN in Bodies as the CPU mirror;
       tracers are copied to the GPU textures and dropped from Bodies. */
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
      const total = Math.min(massiveSlots + tracerIdx.length, this._maxBodies);
      deadMassive = 0;

      const pos = uploadBuf;
      const vel = new Float32Array(total * 4);
      this.staticAttribs = new Float32Array(total * 3);
      const sa = this.staticAttribs;

      // Temp copies of massive rows so the in-place permutation is safe.
      const tmp = massiveIdx.map(i => [
        B.px[i], B.py[i], B.pz[i], B.vx[i], B.vy[i], B.vz[i],
        B.mass[i], B.rad[i], B.colorIdx[i], B.type[i], B.names[i]]);

      let slot = 0;
      const put = (x, y, z, vx, vy, vz, m, rad, col, type, alive) => {
        const o = slot * 4;
        pos[o] = x; pos[o + 1] = y; pos[o + 2] = z; pos[o + 3] = alive ? m : -1;
        vel[o] = vx; vel[o + 1] = vy; vel[o + 2] = vz; vel[o + 3] = type;
        sa[slot * 3] = rad; sa[slot * 3 + 1] = col; sa[slot * 3 + 2] = type;
        slot++;
      };
      for (const t of tmp) put(t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8], t[9], true);
      for (let s = 0; s < SPARE; s++) put(0, 0, 0, 0, 0, 0, 0, 0, 0, 255, false);
      for (const i of tracerIdx) {
        if (slot >= total) break;
        put(B.px[i], B.py[i], B.pz[i], B.vx[i], B.vy[i], B.vz[i],
            B.mass[i], B.rad[i], B.colorIdx[i], B.type[i], true);
      }

      // Rewrite Bodies as the slot-frozen massive mirror.
      for (let s2 = 0; s2 < massiveSlots; s2++) {
        const t = s2 < M ? tmp[s2] : [0, 0, 0, 0, 0, 0, 0, 0, 0, 255, null];
        B.px[s2] = t[0]; B.py[s2] = t[1]; B.pz[s2] = t[2];
        B.vx[s2] = t[3]; B.vy[s2] = t[4]; B.vz[s2] = t[5];
        B.mass[s2] = t[6]; B.rad[s2] = t[7]; B.colorIdx[s2] = t[8];
        B.type[s2] = t[9]; B.names[s2] = t[10];
      }
      B.n = massiveSlots;

      const usedRows = Math.ceil(total / TEXW);
      // Pad the final partial row so dead garbage never renders.
      for (let i = total; i < usedRows * TEXW; i++) pos[i * 4 + 3] = -1;
      for (const k of [0, 1]) {
        gl.bindTexture(gl.TEXTURE_2D, texPos[k]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEXW, usedRows, gl.RGBA, gl.FLOAT,
                         pos.subarray(0, usedRows * TEXW * 4));
        gl.bindTexture(gl.TEXTURE_2D, texVel[k]);
        const velPad = new Float32Array(usedRows * TEXW * 4);
        velPad.set(vel.subarray(0, Math.min(vel.length, velPad.length)));
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEXW, usedRows, gl.RGBA, gl.FLOAT, velPad);
      }
      front = 0;
      this.posTex = texPos[0];
      this.count = total;
      this.massiveCount = massiveSlots;
      this.attribsVersion++;
      readPosBuf = new Float32Array(Math.ceil(massiveSlots / TEXW) * TEXW * 4);
      readVelBuf = new Float32Array(readPosBuf.length);
      return { count: total, massiveCount: massiveSlots };
    },

    _writeTexel(tex, slot, a, b, c2, d) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, slot & (TEXW - 1), slot >> 11, 1, 1,
                       gl.RGBA, gl.FLOAT, new Float32Array([a, b, c2, d]));
    },

    frame() {
      const c = this.cfg;
      if (c.paused || c.timeScale <= 0 || this.count === 0) return;
      const B = globalThis.Bodies;

      // ---- 1. read back massive region (sync; small: <= ~40 rows)
      const mRows = Math.ceil(massiveSlots / TEXW);
      gl.bindFramebuffer(gl.FRAMEBUFFER, readFBO);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texPos[front], 0);
      gl.readPixels(0, 0, TEXW, mRows, gl.RGBA, gl.FLOAT, readPosBuf);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texVel[front], 0);
      gl.readPixels(0, 0, TEXW, mRows, gl.RGBA, gl.FLOAT, readVelBuf);
      for (let i = 0; i < massiveSlots; i++) {
        if (B.type[i] === 255 || B.mass[i] <= 0) continue;
        const o = i * 4;
        B.px[i] = readPosBuf[o]; B.py[i] = readPosBuf[o + 1]; B.pz[i] = readPosBuf[o + 2];
        B.vx[i] = readVelBuf[o]; B.vy[i] = readVelBuf[o + 1]; B.vz[i] = readVelBuf[o + 2];
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
            this._writeTexel(texPos[front], i, B.px[i], B.py[i], B.pz[i], -1);
            this._writeTexel(texVel[front], b, B.vx[b], B.vy[b], B.vz[b], B.type[b]);
          }
        }
      }

      // ---- 3. rebuild + flatten + upload the tree
      this.tree.build(c.massiveMin);
      const { data, nodeCount } = globalThis.TreePack.flatten(this.tree, treeBuf);
      if (nodeCount > 0) {
        const tRows = Math.min(Math.ceil(nodeCount * 2 / TEXW), treeRows);
        gl.bindTexture(gl.TEXTURE_2D, texTree);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEXW, tRows, gl.RGBA, gl.FLOAT,
                         data.subarray(0, tRows * TEXW * 4));
      }

      // ---- 4. black-hole capture list for the tracer shader
      const bhs = this.blackHoleList();
      const nbh = Math.min(bhs.length, MAX_BH);
      for (let k = 0; k < nbh; k++) {
        bhUniform[k * 4] = bhs[k].x; bhUniform[k * 4 + 1] = bhs[k].y;
        bhUniform[k * 4 + 2] = bhs[k].z;
        bhUniform[k * 4 + 3] = Math.max(c.captureRadius, bhs[k].rad * 0.7);
      }

      // ---- 5. integration passes (ping-pong)
      const usedRows = Math.ceil(this.count / TEXW);
      const dt = c.dt * c.timeScale / c.substeps;
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.viewport(0, 0, TEXW, usedRows);
      gl.uniform1i(uni.u_count, this.count);
      gl.uniform1i(uni.u_massiveCount, massiveSlots);
      gl.uniform1f(uni.u_dt, dt);
      gl.uniform1f(uni.u_soft2, c.softening * c.softening);
      gl.uniform1f(uni.u_thetaM, c.theta2);
      gl.uniform1f(uni.u_thetaT, Math.max(2.25, c.theta2 * 2));
      const p = this.pull;
      gl.uniform4f(uni.u_pull, p ? p.x : 0, p ? p.y : 0, p ? p.z : 0, p ? p.mass : 0);
      gl.uniform1i(uni.u_nbh, nbh);
      gl.uniform4fv(uni.u_bh, bhUniform);

      for (let s = 0; s < c.substeps; s++) {
        const back = 1 - front;
        gl.bindFramebuffer(gl.FRAMEBUFFER, simFBO);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texPos[back], 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texVel[back], 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texPos[front]);
        gl.uniform1i(uni.u_pos, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, texVel[front]);
        gl.uniform1i(uni.u_vel, 1);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, texTree);
        gl.uniform1i(uni.u_tree, 2);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        front = back;
        c.t += dt;
      }
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE0);
      this.posTex = texPos[front];
    },

    addMassive(x, y, z, vx, vy, vz, m, rad, col, type) {
      const B = globalThis.Bodies;
      for (let s = 0; s < massiveSlots; s++) {
        if (B.type[s] !== 255) continue;
        B.px[s] = x; B.py[s] = y; B.pz[s] = z;
        B.vx[s] = vx; B.vy[s] = vy; B.vz[s] = vz;
        B.mass[s] = m; B.rad[s] = rad; B.colorIdx[s] = col; B.type[s] = type;
        this._writeTexel(texPos[front], s, x, y, z, m);
        this._writeTexel(texVel[front], s, vx, vy, vz, type);
        this.staticAttribs[s * 3] = rad;
        this.staticAttribs[s * 3 + 1] = col;
        this.staticAttribs[s * 3 + 2] = type;
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

    bodyCount() { return this.count - SPARE - deadMassive; },
    simTimeMyr() { return this.cfg.t * this.cfg.myrPerT; },

    evolutionView() {
      const B = globalThis.Bodies;
      const self = this;
      return {
        get n() { return massiveSlots; },
        mass: B.mass, rad: B.rad, colorIdx: B.colorIdx, type: B.type,
        setDirty() {
          const sa = self.staticAttribs;
          for (let i = 0; i < massiveSlots; i++) {
            sa[i * 3] = B.rad[i];
            sa[i * 3 + 1] = B.colorIdx[i];
            sa[i * 3 + 2] = B.type[i];
          }
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

  globalThis.PhysicsGPU = PhysicsGPU;
})();
