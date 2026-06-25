'use strict';
/* ============================================================
   FABLE: DRIFTER — arcade-Newtonian flight model
   (js/game/ship.js -> globalThis.Ship). DOM-free; attaches via
   globalThis only and loads in Node via indirect-eval (see
   test/smoke.js for the pattern).

   The ship flies in the active cosmos node's LOCAL frame. Newton
   on the inside (real inertia, momentum), arcade on the outside:
   an inertial damper continuously bleeds the component of velocity
   that is NOT aligned with where the nose points, so the ship
   "flies where it looks" instead of drifting forever sideways like
   a true vacuum body. Throttle pushes along the nose; boost scales
   the push and lifts the speed cap.

   ORIENTATION. We carry Euler yaw/pitch/roll and derive the unit
   forward (facing) from yaw + pitch each frame. Pitch is clamped
   short of ±90° so the forward vector never degenerates (gimbal
   flip / undefined heading at the poles). Roll is tracked for the
   camera/HUD horizon but does not bend the flight path (an arcade
   simplification — bank is cosmetic, the nose vector is what flies).

   FACING CONVENTION (must match js/render/camera.js EXACTLY).
   camera.js places the eye at
       eye = target + dist * [cosP*sinY, sinP, cosP*cosY]
   and LOOKS from eye toward target, i.e. its view direction is the
   negation of that offset. We define ship forward with the SAME
   angular parameterization:
       F(yaw,pitch) = [cosP*sinY, sinP, cosP*cosY]
   so that a camera looking along +F is produced by
       camYaw = yaw + PI,  camPitch = -pitch
   (then eye_offset = -F * dist, i.e. the eye sits behind the nose).
   See cameraGoal() for the derivation and the chase/cockpit poses.
   ============================================================ */
(function () {

  // ---- Tunables (LOCAL-frame units; nodes are O(viewRadius) across) ----
  const ACCEL        = 90;     // base thrust accel along facing (u/s^2)
  const BOOST        = 3.2;    // boost multiplier on accel AND top speed
  const TOP_SPEED    = 420;    // cruise speed cap (u/s); boost lifts it
  const DAMP_ALIGN   = 0.6;    // per-sec fraction of forward-aligned drift bled when coasting
  const DAMP_LATERAL = 2.2;    // per-sec fraction of NON-aligned (sideways) velocity bled
  const PITCH_LIMIT  = 1.50;   // |pitch| clamp (rad) — short of PI/2 to dodge gimbal flip
  const YAW_RATE     = 1.6;    // rad/s at full yaw input
  const PITCH_RATE   = 1.4;    // rad/s at full pitch input
  const ROLL_RATE    = 2.4;    // rad/s at full roll input
  const TWO_PI       = Math.PI * 2;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  // wrap an angle to (-PI, PI]; keeps yaw/roll numerically bounded forever.
  function wrap(a) {
    a = a % TWO_PI;
    if (a > Math.PI) a -= TWO_PI;
    else if (a <= -Math.PI) a += TWO_PI;
    return a;
  }

  // Unit forward from yaw/pitch — the single source of truth, shared by
  // facing(), update()'s thrust/damper, and cameraGoal().
  function forwardFrom(yaw, pitch) {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    return [cp * Math.sin(yaw), sp, cp * Math.cos(yaw)];
  }

  const Ship = {
    state: {
      pos: [0, 0, 0],
      vel: [0, 0, 0],
      yaw: 0, pitch: 0, roll: 0,
      throttle: 0,     // smoothed thrust command, -1..1 (HUD gauge)
      speed: 0,        // |vel|
    },

    // World-scale context (sets the speed envelope so the same model
    // feels right whether you're between moons or between galaxies).
    _viewRadius: 1,
    _topSpeed: TOP_SPEED,

    /* reset({ pos:[x,y,z], viewRadius }) — drop the ship at rest at pos.
       Facing defaults to +Z (yaw 0, pitch 0). viewRadius scales the
       cruise cap so flight feels consistent across cosmic LOD levels. */
    reset(opts) {
      opts = opts || {};
      const p = opts.pos || [0, 0, 0];
      this.state.pos = [+p[0] || 0, +p[1] || 0, +p[2] || 0];
      this.state.vel = [0, 0, 0];
      this.state.yaw = 0;
      this.state.pitch = 0;
      this.state.roll = 0;
      this.state.throttle = 0;
      this.state.speed = 0;
      const vr = (opts.viewRadius > 0) ? opts.viewRadius : 1;
      this._viewRadius = vr;
      // Cruise cap scales gently with the node extent: small node -> the
      // base cap; very large node -> faster so you can actually cross it.
      this._topSpeed = TOP_SPEED * clamp(Math.sqrt(vr / 1500), 0.4, 40);
      return this.state;
    },

    /* update(dtSec, input)
       input = { thrust:-1..1, pitch:-1..1, yaw:-1..1, roll:-1..1, boost:bool }
       Integrates orientation from rate inputs, accelerates along the
       nose, runs the inertial damper, advances position, updates speed. */
    update(dtSec, input) {
      const dt = (dtSec > 0 && isFinite(dtSec)) ? Math.min(dtSec, 0.1) : 0;
      input = input || {};
      const s = this.state;

      // ---- 1) Orientation from rate inputs ----
      const yIn = clamp(+input.yaw   || 0, -1, 1);
      const pIn = clamp(+input.pitch || 0, -1, 1);
      const rIn = clamp(+input.roll  || 0, -1, 1);
      s.yaw   = wrap(s.yaw + yIn * YAW_RATE * dt);
      s.pitch = clamp(s.pitch + pIn * PITCH_RATE * dt, -PITCH_LIMIT, PITCH_LIMIT);
      s.roll  = wrap(s.roll + rIn * ROLL_RATE * dt);

      // ---- 2) Forward (facing) from the freshly integrated angles ----
      const F = forwardFrom(s.yaw, s.pitch);

      // ---- 3) Thrust along facing (boost scales accel) ----
      const thrust = clamp(+input.thrust || 0, -1, 1);
      const boost = !!input.boost;
      const accel = ACCEL * (boost ? BOOST : 1);
      s.vel[0] += F[0] * thrust * accel * dt;
      s.vel[1] += F[1] * thrust * accel * dt;
      s.vel[2] += F[2] * thrust * accel * dt;

      // ---- 4) Inertial damper: split velocity into the component along
      //         the nose and the perpendicular (lateral) remainder. Bleed
      //         the lateral part hard (arcade "flies where it looks") and
      //         the aligned part gently when coasting (so a throttle of 0
      //         eventually brings you to rest). ----
      const vAlong = s.vel[0] * F[0] + s.vel[1] * F[1] + s.vel[2] * F[2];
      const alongX = F[0] * vAlong, alongY = F[1] * vAlong, alongZ = F[2] * vAlong;
      let latX = s.vel[0] - alongX, latY = s.vel[1] - alongY, latZ = s.vel[2] - alongZ;

      // frame-rate-independent exponential bleed: keep = e^(-rate*dt).
      const keepLat = Math.exp(-DAMP_LATERAL * dt);
      latX *= keepLat; latY *= keepLat; latZ *= keepLat;

      // The aligned component only bleeds when you're not commanding thrust
      // in its direction (coast = no throttle, or throttle opposing motion).
      let along = vAlong;
      if (thrust === 0 || (thrust * vAlong < 0 && Math.abs(thrust) < 0.05)) {
        along *= Math.exp(-DAMP_ALIGN * dt);
      }

      s.vel[0] = F[0] * along + latX;
      s.vel[1] = F[1] * along + latY;
      s.vel[2] = F[2] * along + latZ;

      // ---- 5) Cap top speed (boost raises the ceiling) ----
      const cap = this._topSpeed * (boost ? BOOST : 1);
      let sp = Math.hypot(s.vel[0], s.vel[1], s.vel[2]);
      if (sp > cap && sp > 0) {
        const k = cap / sp;
        s.vel[0] *= k; s.vel[1] *= k; s.vel[2] *= k;
        sp = cap;
      }

      // ---- 6) Integrate position; publish speed + throttle ----
      s.pos[0] += s.vel[0] * dt;
      s.pos[1] += s.vel[1] * dt;
      s.pos[2] += s.vel[2] * dt;
      s.speed = sp;
      // Smooth the throttle reading toward the command for a calm gauge.
      s.throttle += (thrust - s.throttle) * (1 - Math.exp(-6 * dt));

      return s;
    },

    /* facing() -> unit forward [x,y,z]. */
    facing() {
      return forwardFrom(this.state.yaw, this.state.pitch);
    },

    /* cameraGoal(mode) -> { targetX,targetY,targetZ, dist, yaw, pitch }
       in the EXACT orbit convention of js/render/camera.js, so feeding
       the result into Camera3D.setGoal() puts the ship ahead of the eye.

       camera.js: eye = target + dist*[cosP*sinY, sinP, cosP*cosY], and it
       looks from eye -> target. To make the camera look along the ship's
       forward F (so the ship is centered ahead of the eye) we need the
       camera's eye-offset direction to be -F:
           [cosP*sinY, sinP, cosP*cosY] = -F
       which (since F uses the same parameterization with the ship angles)
       solves to camYaw = shipYaw + PI, camPitch = -shipPitch.
       The eye then lands at  target - dist*F  — directly behind the nose.

       'chase'   : target a point a little AHEAD of the ship and pull the
                   eye back+up, so we look down the flight path.
       'cockpit' : tight behind the ship, near origin, looking forward.
       'orbit'   : null — the caller keeps manual free-orbit control. */
    cameraGoal(mode) {
      if (mode === 'orbit') return null;

      const s = this.state;
      const F = forwardFrom(s.yaw, s.pitch);

      // Distances scale with the world extent so the framing holds across
      // cosmic LOD levels (a system vs. the universe web).
      const unit = clamp(Math.sqrt(this._viewRadius / 1500), 0.4, 40);
      const tight   = mode === 'cockpit';
      // Third person pulled WAY back so you see the whole ship + its
      // surroundings; cockpit stays tight to the nose.
      const dist    = (tight ? 12  : 150) * unit;   // boom length
      const ahead   = (tight ? 5   : 30)  * unit;   // look-ahead along F
      const lift    = (tight ? 1.2 : 34)  * unit;   // raise the target (world +Y)

      // Camera looks along +F: invert the camera's eye-offset relation.
      const camYaw   = wrap(s.yaw + Math.PI);
      const camPitch = clamp(-s.pitch, -1.55, 1.55);

      // Target a point ahead of (and slightly above) the ship; with the
      // eye at target - dist*F, the ship sits between eye and target.
      return {
        targetX: s.pos[0] + F[0] * ahead,
        targetY: s.pos[1] + F[1] * ahead + lift,
        targetZ: s.pos[2] + F[2] * ahead,
        dist: dist,
        yaw: camYaw,
        pitch: camPitch,
      };
    },
  };

  globalThis.Ship = Ship;
})();
