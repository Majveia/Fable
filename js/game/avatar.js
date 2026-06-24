'use strict';
/* ============================================================
   FABLE: DRIFTER v8 — THE WANDERER — on-foot controller
   (js/game/avatar.js -> globalThis.Avatar). DOM-free; attaches
   via globalThis only and loads in Node via indirect-eval (see
   test/smoke.js for the pattern).

   The avatar walks the SHIP INTERIOR, entirely in SHIP SPACE:
       +Z forward, +Y up, +X right
   (the same frame the ship model & the cockpit seat live in — see
   js/game/shipmodel.js and the v8 contract). The integrator owns
   the ship->node-local transform M; this module never touches it.
   We only produce ship-space state and ship-space camera mounts;
   the integrator transforms a mount by M to drive Camera3D.

   ORIENTATION. We carry a heading yaw and a look pitch. The
   horizontal forward direction is parameterised to MATCH the ship
   exactly at pitch 0:
       fwd(yaw) = [sin(yaw), 0, cos(yaw)]
   so yaw 0 looks down +Z (the ship's nose), and +yaw swings toward
   +X (right), identical to Ship.facing()/camera.js. Strafe is the
   right vector, perpendicular in the X/Z plane:
       right(yaw) = [cos(yaw), 0, -sin(yaw)] = cross([0,1,0], fwd)
   Pitch only tilts the LOOK (the camera forward); walking stays in
   the horizontal plane so you never march into the floor/ceiling.

   MOTION. Gentle first-order feel: input drives a target planar
   velocity (run scales the cap); we ease the live velocity toward
   it (accel) and bleed it when there's no input (damping), both
   frame-rate independent via keep = e^(-rate*dt). After integrating
   we hand the position to model.clamp() so we can never leave the
   walkable bounds.
   ============================================================ */
(function () {

  // ---- Tunables (SHIP-SPACE units; the ship is ~16 units long) ----
  const WALK_SPEED  = 4.5;    // planar speed cap when walking (u/s)
  const RUN_MULT    = 2.1;    // run scales the speed cap
  const ACCEL_HZ    = 9;      // approach rate toward the target velocity
  const DAMP_HZ     = 7;      // bleed rate when there's no move input
  const TURN_RATE   = 2.2;    // rad/s at full turn input
  const PITCH_RATE  = 1.8;    // rad/s at full lookPitch input
  const PITCH_LIMIT = 1.4;    // |pitch| clamp (rad) — per contract (~±1.4)
  const MOVE_EPS    = 1e-4;   // |planar vel| below this => not "moving"
  const TWO_PI      = Math.PI * 2;

  // First/third-person camera framing (ship-space units).
  const EYE_HEIGHT  = 1.7;    // eye above the avatar's feet (+Y)
  const TP_BACK     = 6.0;    // chase distance behind the avatar
  const TP_UP       = 2.6;    // chase height above the avatar

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function num(v, d) { v = +v; return isFinite(v) ? v : (d || 0); }
  // wrap an angle to (-PI, PI]; keeps yaw numerically bounded forever.
  function wrap(a) {
    a = a % TWO_PI;
    if (a > Math.PI) a -= TWO_PI;
    else if (a <= -Math.PI) a += TWO_PI;
    return a;
  }

  // Horizontal forward from yaw — single source of truth, matches the
  // ship/camera convention at pitch 0.
  function fwdFrom(yaw) {
    return [Math.sin(yaw), 0, Math.cos(yaw)];
  }
  // Horizontal right = cross(up=+Y, forward): perpendicular in X/Z.
  function rightFrom(yaw) {
    return [Math.cos(yaw), 0, -Math.sin(yaw)];
  }
  // Full look direction (forward tilted by pitch) for the camera.
  function lookFrom(yaw, pitch) {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    return [cp * Math.sin(yaw), sp, cp * Math.cos(yaw)];
  }

  const Avatar = {
    state: {
      pos: [0, 0, 0],   // ship-space position (feet)
      yaw: 0,           // heading; 0 looks down +Z
      pitch: 0,         // look elevation, clamped to ~±PITCH_LIMIT
      moving: false,    // true while planar velocity is non-trivial
    },

    // Planar velocity (X/Z), private; +Y is always 0 (we don't fall).
    _vel: [0, 0, 0],

    /* reset({ seat }) — stand the avatar at the seat.
       seat = ShipModel.seat = { pos:[x,y,z], forward:[0,0,1], eye:[...] }.
       Both fields are optional/defensive: missing seat -> origin facing
       +Z. The heading is taken from the seat's forward so you spawn
       looking the way the cockpit faces (yaw 0 == +Z by default). */
    reset(opts) {
      opts = opts || {};
      const seat = opts.seat || {};
      const p = seat.pos || [0, 0, 0];
      this.state.pos = [num(p[0]), num(p[1]), num(p[2])];

      // Derive heading from the seat forward (planar component), default +Z.
      const f = seat.forward;
      let yaw = 0;
      if (f && (Math.abs(num(f[0])) > 1e-9 || Math.abs(num(f[2])) > 1e-9)) {
        yaw = Math.atan2(num(f[0]), num(f[2]));   // atan2(x, z) so +Z -> 0
      }
      this.state.yaw = wrap(yaw);
      this.state.pitch = 0;
      this.state.moving = false;
      this._vel = [0, 0, 0];
      return this.state;
    },

    /* update(dtSec, input, model)
       input = { fwd:-1..1, strafe:-1..1, turn:-1..1, lookPitch:-1..1,
                 run:bool }
       - turn integrates yaw; lookPitch integrates pitch (clamped ±1.4).
       - move in the ship-space horizontal X/Z plane: forward from yaw,
         strafe along the right vector; gentle accel toward the target
         velocity, damping when idle; run scales the speed cap.
       - after integrating, model.clamp(pos) keeps us inside the
         walkable bounds. */
    update(dtSec, input, model) {
      const dt = (dtSec > 0 && isFinite(dtSec)) ? Math.min(dtSec, 0.1) : 0;
      input = input || {};
      const s = this.state;

      // ---- 1) Orientation from rate inputs ----
      const turn = clamp(num(input.turn), -1, 1);
      const look = clamp(num(input.lookPitch), -1, 1);
      s.yaw = wrap(s.yaw + turn * TURN_RATE * dt);
      s.pitch = clamp(s.pitch + look * PITCH_RATE * dt, -PITCH_LIMIT, PITCH_LIMIT);

      // ---- 2) Target planar velocity from move inputs (run scales cap) ----
      const fwdIn = clamp(num(input.fwd), -1, 1);
      const strIn = clamp(num(input.strafe), -1, 1);
      const cap = WALK_SPEED * (input.run ? RUN_MULT : 1);

      const F = fwdFrom(s.yaw);
      const R = rightFrom(s.yaw);
      // Desired direction in X/Z; normalise diagonal so fwd+strafe isn't
      // faster than a single axis, then scale by input magnitude * cap.
      let dx = F[0] * fwdIn + R[0] * strIn;
      let dz = F[2] * fwdIn + R[2] * strIn;
      const magIn = Math.min(1, Math.hypot(fwdIn, strIn));   // 0..1 demand
      const dl = Math.hypot(dx, dz);
      let tgX = 0, tgZ = 0;
      if (dl > 1e-9) {
        const k = (cap * magIn) / dl;
        tgX = dx * k; tgZ = dz * k;
      }

      // ---- 3) Ease velocity toward target (accel) or bleed it (damp) ----
      const hasInput = magIn > 1e-6;
      const rate = hasInput ? ACCEL_HZ : DAMP_HZ;
      const kk = 1 - Math.exp(-rate * dt);
      const v = this._vel;
      v[0] += (tgX - v[0]) * kk;
      v[1] = 0;                       // never leave the floor plane
      v[2] += (tgZ - v[2]) * kk;

      // ---- 4) Integrate position, then clamp into the walkable bounds ----
      s.pos[0] += v[0] * dt;
      s.pos[1] += v[1] * dt;
      s.pos[2] += v[2] * dt;
      if (model && typeof model.clamp === 'function') {
        const c = model.clamp(s.pos);
        if (c) { s.pos[0] = num(c[0]); s.pos[1] = num(c[1]); s.pos[2] = num(c[2]); }
      }

      // ---- 5) Publish "moving" from the live planar speed ----
      s.moving = Math.hypot(v[0], v[2]) > MOVE_EPS;
      return s;
    },

    /* cameraMount(mode) -> { pos:[x,y,z], forward:[x,y,z], up:[x,y,z] }
       All in SHIP SPACE; the integrator transforms by M for Camera3D.
       'fp' : eye at avatar pos + up*EYE_HEIGHT, looking along the full
              yaw+pitch look direction (first-person eyes).
       'tp' : a point BEHIND (-forward*TP_BACK) and ABOVE the avatar's
              eye, looking back toward the avatar (over-the-shoulder). */
    cameraMount(mode) {
      const s = this.state;
      const up = [0, 1, 0];
      const eye = [s.pos[0], s.pos[1] + EYE_HEIGHT, s.pos[2]];
      const look = lookFrom(s.yaw, s.pitch);

      if (mode === 'tp') {
        // Sit behind and above the eye; aim forward toward the avatar.
        const pos = [
          eye[0] - look[0] * TP_BACK,
          eye[1] - look[1] * TP_BACK + TP_UP,
          eye[2] - look[2] * TP_BACK,
        ];
        // Forward = from the camera toward the avatar's head (normalised).
        let fx = eye[0] - pos[0], fy = eye[1] - pos[1], fz = eye[2] - pos[2];
        const fl = Math.hypot(fx, fy, fz) || 1;
        return { pos: pos, forward: [fx / fl, fy / fl, fz / fl], up: up };
      }

      // 'fp' (default): eyes at head height, looking along the look dir.
      return { pos: eye, forward: look, up: up };
    },
  };

  globalThis.Avatar = Avatar;
})();
