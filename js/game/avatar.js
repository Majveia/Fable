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
  // Retuned for a responsive FPS feel per the control-feel research: quick
  // accel/decel (tau ~0.08-0.10s -> ACCEL/DAMP_HZ below), a ~1.7x run, and
  // crisp turn/look rates so aim feels immediate, not floaty.
  const WALK_SPEED  = 4.5;    // planar speed cap when walking (u/s) — in the 4-5 m/s band
  const RUN_MULT    = 1.7;    // run scales the speed cap (research: 1.6-1.8x)
  const ACCEL_HZ    = 12.5;   // approach rate toward target velocity (tau ~0.08s) — snappy start
  const DAMP_HZ     = 10;     // bleed rate when idle (tau ~0.10s) — quick, crisp stop
  const TURN_RATE   = 2.8;    // rad/s at full turn input — responsive
  const PITCH_RATE  = 2.4;    // rad/s at full lookPitch input — responsive
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

    /* ========================================================
       v13 LIVING WORLDS — walk a PLANET SURFACE on foot.
       Same yaw/pitch/look convention as above, but here pos is in
       SURFACE/WORLD space (+Y up), the FLOOR is the terrain height
       heightAt(x,z) instead of ShipModel.bounds, and there is real
       gravity so you step off ledges and rise up slopes. X/Z are
       clamped to the playable square (+/- extent). The camera mount
       is already in world space (no ship->local transform), so the
       integrator can aim Camera3D straight from it.
       ======================================================== */
    _surfVy: 0,          // vertical velocity (gravity), surface only
    _surfExtent: 1200,   // X/Z clamp

    surfaceReset(opts) {
      opts = opts || {};
      const p = opts.pos || [0, 0, 0];
      const s = this.state;
      s.pos = [num(p[0]), num(p[1]), num(p[2])];
      s.yaw = wrap(num(opts.yaw));
      s.pitch = 0;
      s.moving = false;
      this._vel = [0, 0, 0];
      this._surfVy = 0;
      this._surfExtent = (opts.extent > 0 && isFinite(opts.extent)) ? +opts.extent : 1200;
      return s;
    },

    /* updateOnSurface(dtSec, input, heightAt, extent)
       input = { fwd, strafe, turn, lookPitch, run } like update().
       Planar WASD in the facing frame with the same responsive accel/
       damp; gravity pulls -Y and the terrain (heightAt) is the floor
       so you fall off ledges and climb slopes; X/Z clamp to extent. */
    updateOnSurface(dtSec, input, heightAt, extent) {
      const dt = (dtSec > 0 && isFinite(dtSec)) ? Math.min(dtSec, 0.1) : 0;
      input = input || {};
      const s = this.state;
      const ext = (extent > 0 && isFinite(extent)) ? +extent : this._surfExtent;
      this._surfExtent = ext;
      const ht = (typeof heightAt === 'function') ? heightAt : function () { return 0; };

      // ---- 1) Orientation ----
      const turn = clamp(num(input.turn), -1, 1);
      const look = clamp(num(input.lookPitch), -1, 1);
      s.yaw = wrap(s.yaw + turn * TURN_RATE * dt);
      s.pitch = clamp(s.pitch + look * PITCH_RATE * dt, -PITCH_LIMIT, PITCH_LIMIT);

      // ---- 2) Target planar velocity (a bit brisker on foot outdoors) ----
      const SURF_WALK = 6.5, SURF_RUN = 1.75, SURF_GRAV = 22;
      const fwdIn = clamp(num(input.fwd), -1, 1);
      const strIn = clamp(num(input.strafe), -1, 1);
      const cap = SURF_WALK * (input.run ? SURF_RUN : 1);
      const F = fwdFrom(s.yaw), R = rightFrom(s.yaw);
      let dx = F[0] * fwdIn + R[0] * strIn;
      let dz = F[2] * fwdIn + R[2] * strIn;
      const magIn = Math.min(1, Math.hypot(fwdIn, strIn));
      const dl = Math.hypot(dx, dz);
      let tgX = 0, tgZ = 0;
      if (dl > 1e-9) { const k = (cap * magIn) / dl; tgX = dx * k; tgZ = dz * k; }

      const rate = (magIn > 1e-6) ? ACCEL_HZ : DAMP_HZ;
      const kk = 1 - Math.exp(-rate * dt);
      const v = this._vel;
      v[0] += (tgX - v[0]) * kk;
      v[2] += (tgZ - v[2]) * kk;

      // ---- 3) Integrate planar, clamp X/Z to the playable square ----
      s.pos[0] = clamp(s.pos[0] + v[0] * dt, -ext, ext);
      s.pos[2] = clamp(s.pos[2] + v[2] * dt, -ext, ext);

      // ---- 4) Gravity + terrain floor: fall off ledges, rise up slopes ----
      this._surfVy -= SURF_GRAV * dt;
      s.pos[1] += this._surfVy * dt;
      let ground = ht(s.pos[0], s.pos[2]);
      if (!isFinite(ground)) ground = 0;
      if (s.pos[1] <= ground) {
        s.pos[1] = ground;                 // feet on the ground
        if (this._surfVy < 0) this._surfVy = 0;
      }

      // ---- 5) NaN guard + moving flag ----
      for (let i = 0; i < 3; i++) {
        if (!isFinite(s.pos[i])) s.pos[i] = 0;
        if (!isFinite(v[i])) v[i] = 0;
      }
      if (!isFinite(this._surfVy)) this._surfVy = 0;
      s.moving = Math.hypot(v[0], v[2]) > MOVE_EPS;
      return s;
    },

    /* surfaceMount(view, heightAt) -> { pos, forward, up } in WORLD space.
       'fp' eyes at feet + EYE_HEIGHT looking along yaw+pitch; 'tp' behind
       and above, kept clear of the terrain via heightAt. */
    surfaceMount(view, heightAt) {
      const s = this.state;
      const up = [0, 1, 0];
      const ht = (typeof heightAt === 'function') ? heightAt : function () { return -1e9; };
      const eye = [s.pos[0], s.pos[1] + EYE_HEIGHT, s.pos[2]];
      const look = lookFrom(s.yaw, s.pitch);

      if (view === 'tp') {
        const BACK = 7.0, UPP = 3.0;
        const pos = [
          eye[0] - look[0] * BACK,
          eye[1] - look[1] * BACK + UPP,
          eye[2] - look[2] * BACK,
        ];
        // Keep the chase eye above the terrain it hovers over.
        const g = ht(pos[0], pos[2]);
        if (isFinite(g) && pos[1] < g + 1.5) pos[1] = g + 1.5;
        let fx = eye[0] - pos[0], fy = eye[1] - pos[1], fz = eye[2] - pos[2];
        const fl = Math.hypot(fx, fy, fz) || 1;
        return { pos: pos, forward: [fx / fl, fy / fl, fz / fl], up: up };
      }
      return { pos: eye, forward: look, up: up };
    },
  };

  globalThis.Avatar = Avatar;
})();
