'use strict';
/* ============================================================
   FABLE UNIVERSE v2 — physics driver (js/core/physics.js)
   Barnes-Hut force solve + semi-implicit Euler + black-hole
   accretion. G = 1. Headless: attaches to globalThis only.
   ============================================================ */

(function () {
  const PULL_SOFT2 = 400; // gravity-well softening, matches v1 feel

  // ---- dark matter -------------------------------------------------
  // Analytic halos (cored isothermal spheres) registered by scenarios,
  // shared by both engines. Each: { x, y, z, v02, rc2, rMax2 }. Halos
  // follow their galaxy by snapping to the nearest live black hole
  // each step; toggling `on` mid-flight unbinds the outskirts — the
  // observable argument for dark matter, live.
  const DarkMatter = { on: true, list: [] };
  globalThis.DarkMatter = DarkMatter;

  function updateHaloCenters(B, halos) {
    for (let h = 0; h < halos.length; h++) {
      const H = halos[h];
      let best = -1, bestD2 = H.rc2 * 16;       // search out to 4·rc
      for (let i = 0; i < B.n; i++) {
        if (B.type[i] !== B.TYPE_BH || B.mass[i] <= 0) continue;
        const dx = B.px[i] - H.x, dy = B.py[i] - H.y, dz = B.pz[i] - H.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
      if (best >= 0) { H.x = B.px[best]; H.y = B.py[best]; H.z = B.pz[best]; }
    }
  }
  globalThis.updateHaloCenters = updateHaloCenters;

  const Physics = {
    cfg: {
      dt: 0.25,
      substeps: 1,
      softening: 4,
      theta2: 1.21,        // Barnes-Hut theta^2 (theta=1.1), adapted at runtime
      theta2Base: 1.21,
      captureRadius: 6,    // black holes swallow bodies inside this
      massiveMin: 0.01,    // below this mass a body is a tracer
      timeScale: 1,
      paused: false,
      t: 0,                // simulation time
      myrPerT: 1,          // cosmetic display scale
    },

    tree: new globalThis.Octree(1 << 17),
    pull: null,            // {x, y, z, mass} or null
    _acc: { x: 0, y: 0, z: 0 },

    // One integration step, drift-kick-drift leapfrog (2nd-order
    // symplectic, one force evaluation per step): half-drift -> tree
    // build at the midpoint -> per-body accel (massive bodies use
    // cfg.theta2, tracers a coarse opening angle since they exert no
    // force back) + dark-matter halos + pull well -> full kick ->
    // half-drift -> black-hole capture.
    step(dt) {
      const B = globalThis.Bodies;
      const c = this.cfg;
      const tree = this.tree;

      const soft2 = c.softening * c.softening;
      const massiveMin = c.massiveMin;
      const thetaMassive = c.theta2;
      const thetaTracer = Math.max(2.25, c.theta2 * 2);
      const out = this._acc;
      const n = B.n;
      const { px, py, pz, vx, vy, vz, mass } = B;
      const half = dt * 0.5;

      for (let i = 0; i < n; i++) {
        px[i] += vx[i] * half;
        py[i] += vy[i] * half;
        pz[i] += vz[i] * half;
      }

      tree.build(c.massiveMin);
      const DM = globalThis.DarkMatter;
      const halos = DM && DM.on ? DM.list : null;
      if (halos) updateHaloCenters(B, halos);

      // Tracers exert no force, so they tolerate a cheaper kick schedule:
      // each tracer is kicked every other step with a doubled dt —
      // identical trajectory to first order, half the traversal cost.
      // (Their drifts still advance every step.)
      const parity = (this._step = ((this._step | 0) + 1) & 1);
      const dt2 = dt * 2;

      for (let i = 0; i < n; i++) {
        let kdt = dt;
        if (mass[i] < massiveMin) {
          if ((i & 1) === parity) continue;
          kdt = dt2;
          tree.accel(px[i], py[i], pz[i], thetaTracer, soft2, out);
        } else {
          tree.accel(px[i], py[i], pz[i], thetaMassive, soft2, out);
        }
        let ax = out.x, ay = out.y, az = out.z;
        if (halos) {
          for (let h = 0; h < halos.length; h++) {
            const H = halos[h];
            const dx = H.x - px[i], dy = H.y - py[i], dz = H.z - pz[i];
            const r2 = dx * dx + dy * dy + dz * dz;
            // Cored isothermal sphere: a -> v0^2/r (flat curve) inside
            // rMax, Keplerian falloff beyond.
            let f = H.v02 / (r2 + H.rc2);
            if (r2 > H.rMax2) f *= H.rMax2 / r2;
            ax += dx * f; ay += dy * f; az += dz * f;
          }
        }
        vx[i] += ax * kdt;
        vy[i] += ay * kdt;
        vz[i] += az * kdt;
      }

      // Interactive gravity well: pulls like a heavy invisible mass.
      const pull = this.pull;
      if (pull) {
        const wm = pull.mass;
        for (let i = 0; i < n; i++) {
          const dx = pull.x - px[i], dy = pull.y - py[i], dz = pull.z - pz[i];
          const d2 = dx * dx + dy * dy + dz * dz + PULL_SOFT2;
          const inv = wm / (d2 * Math.sqrt(d2));
          vx[i] += dx * inv * dt;
          vy[i] += dy * inv * dt;
          vz[i] += dz * inv * dt;
        }
      }

      for (let i = 0; i < n; i++) {
        px[i] += vx[i] * half;
        py[i] += vy[i] * half;
        pz[i] += vz[i] * half;
      }

      c.t += dt;
      this.feedBlackHoles();
    },

    frame() {
      const c = this.cfg;
      if (c.paused || c.timeScale <= 0) return;
      const dt = c.dt * c.timeScale / c.substeps;
      for (let s = 0; s < c.substeps; s++) this.step(dt);
    },

    // Black holes swallow what falls in; mass and momentum are conserved.
    // Holes are found inline rather than pre-collected because swap-pop
    // removal renumbers bodies mid-loop and pre-collected indices go stale.
    // If the hole itself is the body swapped down by remove(), follow it.
    feedBlackHoles() {
      const B = globalThis.Bodies;
      const c = this.cfg;
      const TYPE_BH = B.TYPE_BH;
      const { px, py, pz, vx, vy, vz, mass, rad, type } = B;
      for (let b = 0; b < B.n; b++) {
        if (type[b] !== TYPE_BH) continue;
        const r = Math.max(c.captureRadius, rad[b] * 0.7);
        const r2 = r * r;
        for (let i = B.n - 1; i >= 0; i--) {
          if (i === b || type[i] === TYPE_BH) continue;
          const dx = px[i] - px[b], dy = py[i] - py[b], dz = pz[i] - pz[b];
          if (dx * dx + dy * dy + dz * dz < r2) {
            const total = mass[b] + mass[i];
            vx[b] = (vx[b] * mass[b] + vx[i] * mass[i]) / total;
            vy[b] = (vy[b] * mass[b] + vy[i] * mass[i]) / total;
            vz[b] = (vz[b] * mass[b] + vz[i] * mass[i]) / total;
            mass[b] = total;
            rad[b] = Math.min(rad[b] + 0.015, 30);
            const moved = B.n - 1;   // body that remove() swaps into slot i
            B.remove(i);
            if (b === moved) b = i;  // the hole itself was relocated
          }
        }
      }
    },

    /* Supernova remnant shell (CPU mode): plain gas tracers. */
    addBurst(x, y, z, vx, vy, vz, count) {
      const B = globalThis.Bodies;
      for (let k = 0; k < count; k++) {
        if (B.n >= B.CAP - 1) return;
        const ct = 2 * Math.random() - 1, st = Math.sqrt(1 - ct * ct);
        const ph = 2 * Math.PI * Math.random();
        const dx = st * Math.cos(ph), dy = ct, dz = st * Math.sin(ph);
        const sp = 2.5 + Math.random() * 3.5;
        const r0 = 1 + Math.random() * 5;
        B.add(x + dx * r0, y + dy * r0, z + dz * r0,
              vx + dx * sp, vy + dy * sp, vz + dz * sp,
              0.0001, 2.5 + Math.random() * 4.5,
              Math.random() < 0.5 ? 9 : 10, B.TYPE_GAS, null);
      }
    },

    setPull(x, y, z, mass) {
      this.pull = { x, y, z, mass };
    },

    clearPull() {
      this.pull = null;
    },

    // Adaptive quality: coarsen the opening angle when the frame rate
    // sags (cap 2.25), decay back toward theta2Base when there's headroom.
    adaptQuality(fps) {
      const c = this.cfg;
      if (fps < 45) c.theta2 = Math.min(c.theta2 * 1.02, 2.25);
      else if (fps > 55) c.theta2 = Math.max(c.theta2 * 0.99, c.theta2Base);
    },

    // ---- common engine surface (shared with PhysicsGPU, see v3 contract)
    bodyCount() { return globalThis.Bodies.n; },
    simTimeMyr() { return this.cfg.t * this.cfg.myrPerT; },

    evolutionView() {
      const B = globalThis.Bodies;
      return {
        get n() { return B.n; },
        mass: B.mass, rad: B.rad, colorIdx: B.colorIdx, type: B.type,
        setDirty() {},   // arrays mode re-reads Bodies every frame anyway
      };
    },

    blackHoleList() {
      const B = globalThis.Bodies;
      const out = [];
      for (let i = 0; i < B.n; i++) {
        if (B.type[i] !== B.TYPE_BH) continue;
        out.push({ x: B.px[i], y: B.py[i], z: B.pz[i], mass: B.mass[i], rad: B.rad[i] });
      }
      out.sort((a, b) => b.mass - a.mass);
      return out.slice(0, 8);
    },
  };

  globalThis.Physics = Physics;
})();
