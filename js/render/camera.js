'use strict';
/* ============================================================
   FABLE UNIVERSE v2 — orbit camera (globalThis.Camera3D).

   Orbit camera around a target point: yaw around +Y, pitch above
   the horizon (clamped to ±1.55 rad), distance along the boom.
   Every user-facing mutation (orbit / dolly / pan / setGoal)
   writes a *goal*; update(dtMs) eases the live values toward the
   goals with an exponential (critically-damped feel) approach at
   ~8 Hz, so motion is smooth regardless of frame rate.

   viewProj(aspect) returns a column-major Float32Array(16):
   perspective (vertical fov, near 0.1, far 1e6) multiplied with
   lookAt(eye -> target, up = +Y). All mat4 math is inline — no
   libraries, per the architecture contract.
   ============================================================ */
(function () {

  const PITCH_MAX = 1.55;            // just shy of the poles
  const DIST_MIN = 0.5;
  const DIST_MAX = 4e5;              // keep inside the far plane
  const SMOOTH_HZ = 8;               // approach rate, ~6-10 Hz feel

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  const cam = {
    // live (rendered) state
    target: { x: 0, y: 0, z: 0 },
    dist: 1500,
    yaw: 0.6,
    pitch: 0.35,
    fov: 0.9,                        // vertical, radians (~51.6°)

    // goal state — update() chases these
    goal: { tx: 0, ty: 0, tz: 0, dist: 1500, yaw: 0.6, pitch: 0.35 },

    /* Exponential approach toward goals. k = 1 - e^(-rate·dt) is
       frame-rate independent and never overshoots (critically
       damped first-order response). Distance eases in log space so
       dolly feels uniform across scales. */
    update(dtMs) {
      const dt = Math.max(0, Math.min(dtMs, 250)) / 1000;
      const k = 1 - Math.exp(-SMOOTH_HZ * dt);
      const g = this.goal, t = this.target;
      t.x += (g.tx - t.x) * k;
      t.y += (g.ty - t.y) * k;
      t.z += (g.tz - t.z) * k;
      this.yaw += (g.yaw - this.yaw) * k;
      this.pitch += (g.pitch - this.pitch) * k;
      this.dist = Math.exp(Math.log(this.dist) + (Math.log(g.dist) - Math.log(this.dist)) * k);
      // snap when negligibly close to avoid endless tiny deltas
      if (Math.abs(g.yaw - this.yaw) < 1e-5) this.yaw = g.yaw;
      if (Math.abs(g.pitch - this.pitch) < 1e-5) this.pitch = g.pitch;
    },

    orbit(dYaw, dPitch) {
      this.goal.yaw += dYaw;
      this.goal.pitch = clamp(this.goal.pitch + dPitch, -PITCH_MAX, PITCH_MAX);
    },

    dolly(factor) {
      this.goal.dist = clamp(this.goal.dist * factor, DIST_MIN, DIST_MAX);
    },

    /* Pan moves the target in the camera's right/up plane. Pixel
       deltas are converted to world units at the target's depth:
       worldPerPx = 2·dist·tan(fov/2) / viewportH. Dragging right/
       down slides the scene with the cursor (target moves the
       opposite way; screen y points down). */
    pan(dxPx, dyPx, viewportH) {
      const wpp = 2 * this.dist * Math.tan(this.fov / 2) / Math.max(1, viewportH);
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      // camera basis (right-handed, up = +Y world)
      const rx = cy, ry = 0, rz = -sy;                       // right
      const ux = -sp * sy, uy = cp, uz = -sp * cy;           // up
      const g = this.goal;
      g.tx += (-dxPx * rx + dyPx * ux) * wpp;
      g.ty += (-dxPx * ry + dyPx * uy) * wpp;
      g.tz += (-dxPx * rz + dyPx * uz) * wpp;
    },

    /* Smooth transition to a new pose; any field may be omitted. */
    setGoal(o) {
      const g = this.goal;
      if (o.targetX !== undefined) g.tx = o.targetX;
      if (o.targetY !== undefined) g.ty = o.targetY;
      if (o.targetZ !== undefined) g.tz = o.targetZ;
      if (o.dist !== undefined) g.dist = clamp(o.dist, DIST_MIN, DIST_MAX);
      if (o.yaw !== undefined) g.yaw = o.yaw;
      if (o.pitch !== undefined) g.pitch = clamp(o.pitch, -PITCH_MAX, PITCH_MAX);
    },

    /* Jump the live state to the goals instantly (scenario loads, tests). */
    snap() {
      const g = this.goal, t = this.target;
      t.x = g.tx; t.y = g.ty; t.z = g.tz;
      this.dist = g.dist; this.yaw = g.yaw; this.pitch = g.pitch;
    },

    eye() {
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      return {
        x: this.target.x + this.dist * cp * sy,
        y: this.target.y + this.dist * sp,
        z: this.target.z + this.dist * cp * cy,
      };
    },

    /* Column-major perspective · lookAt. */
    viewProj(aspect) {
      const near = 0.1, far = 1e6;
      const f = 1 / Math.tan(this.fov / 2);
      const nf = 1 / (near - far);
      // perspective (column-major)
      const P = [
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0,
      ];

      const e = this.eye(), t = this.target;
      // back = normalize(eye - target)
      let bx = e.x - t.x, by = e.y - t.y, bz = e.z - t.z;
      let bl = Math.hypot(bx, by, bz) || 1;
      bx /= bl; by /= bl; bz /= bl;
      // right = normalize(cross(up, back)), up = +Y
      let rx = bz, ry = 0, rz = -bx;
      let rl = Math.hypot(rx, ry, rz);
      if (rl < 1e-9) { rx = 1; ry = 0; rz = 0; rl = 1; } // looking straight up/down
      rx /= rl; ry /= rl; rz /= rl;
      // up = cross(back, right)
      const ux = by * rz - bz * ry;
      const uy = bz * rx - bx * rz;
      const uz = bx * ry - by * rx;
      // view matrix (column-major)
      const V = [
        rx, ux, bx, 0,
        ry, uy, by, 0,
        rz, uz, bz, 0,
        -(rx * e.x + ry * e.y + rz * e.z),
        -(ux * e.x + uy * e.y + uz * e.z),
        -(bx * e.x + by * e.y + bz * e.z),
        1,
      ];

      // out = P · V (column-major: out[c][r] = Σk P[k][r]·V[c][k])
      const out = new Float32Array(16);
      for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
          out[c * 4 + r] =
            P[r] * V[c * 4] +
            P[4 + r] * V[c * 4 + 1] +
            P[8 + r] * V[c * 4 + 2] +
            P[12 + r] * V[c * 4 + 3];
        }
      }
      return out;
    },
  };

  globalThis.Camera3D = cam;
})();
