'use strict';
/* ============================================================
   FABLE UNIVERSE v2 — physics driver (js/core/physics.js)
   Barnes-Hut force solve + semi-implicit Euler + black-hole
   accretion. G = 1. Headless: attaches to globalThis only.
   ============================================================ */

(function () {
  const PULL_SOFT2 = 400; // gravity-well softening, matches v1 feel

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

    // One integration step: tree build -> per-body accel (per-body theta:
    // massive bodies use cfg.theta2, tracers a coarse opening angle since
    // they exert no force back) -> optional pull well -> semi-implicit
    // Euler -> time advance -> black-hole capture.
    step(dt) {
      const B = globalThis.Bodies;
      const c = this.cfg;
      const tree = this.tree;
      tree.build(c.massiveMin);

      const soft2 = c.softening * c.softening;
      const massiveMin = c.massiveMin;
      const thetaMassive = c.theta2;
      const thetaTracer = Math.max(2.25, c.theta2 * 2);
      const out = this._acc;
      const n = B.n;
      const { px, py, pz, vx, vy, vz, mass } = B;

      // Tracers exert no force, so they tolerate a cheaper kick schedule:
      // each tracer is kicked every other step with a doubled dt —
      // identical trajectory to first order, half the traversal cost.
      // (Their drift still advances every step below.)
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
        vx[i] += out.x * kdt;
        vy[i] += out.y * kdt;
        vz[i] += out.z * kdt;
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
        px[i] += vx[i] * dt;
        py[i] += vy[i] * dt;
        pz[i] += vz[i] * dt;
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
  };

  globalThis.Physics = Physics;
})();
