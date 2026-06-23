'use strict';
/* ============================================================
   FABLE UNIVERSE v6 — Navigator (globalThis.Navigator).

   Owns the floating origin and LOD/active-node selection. Given
   the cosmos hierarchy and the orbit Camera3D, exactly ONE node
   is "active": its center is the world origin, so everything the
   renderer/engine sees is expressed relative to it and stays
   float32-safe even though absolute coordinates are float64 and
   astronomically large.

   A node is { id, kind, depth, ac:[x,y,z] (absolute float64),
   radius, parent, children() -> node[], summary }.

   Camera coupling (the load-bearing assumption — integrators read
   this): Camera3D orbits its `target` in LOCAL (active-relative)
   space. camera.eye() returns the eye position in that same LOCAL
   frame. We therefore reconstruct the camera's WORLD position as
   origin + eye(). On every active-node change we REBASE: move the
   origin to the new active center and re-express camera.target so
   the rendered view does not jump:
       newTargetLocal = (oldOrigin + oldTargetLocal) - newOrigin
   dist / yaw / pitch are scale/orientation only and are preserved.
   We write the new target via camera.setGoal({targetX/Y/Z}) AND
   directly onto camera.target so the live pose rebases instantly
   (no one-frame smoothing lag through the goal easer). If the
   camera also exposes snap() we leave smoothing untouched beyond
   that — the goal is set so future easing converges correctly.

   Hysteresis prevents flapping: ascend only when the camera is
   well outside (D > radius*3), descend only when well inside a
   child (D_toC < childRadius*1.5) AND the camera is approaching
   that child. A debounce counter additionally forces a freshly
   activated node to persist a few frames before another switch.

   No dependencies; all vec math inline; allocation-light update().
   ============================================================ */
(function () {

  // Tunables -------------------------------------------------------------
  const ASCEND_FACTOR = 3.0;   // leave a node when D > radius * this
  const DESCEND_FACTOR = 1.5;  // enter a child when D_toC < childRadius * this
  const DEBOUNCE_FRAMES = 4;   // min frames a node stays active before re-switch
  const CONTEXT_CAP = 64;      // max context nodes returned per update

  // Inline vec helpers (operate on / return plain triples) ---------------
  function dist3(ax, ay, az, bx, by, bz) {
    const dx = ax - bx, dy = ay - by, dz = az - bz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  const nav = {
    cosmos: null,
    camera: null,
    active: null,
    origin: [0, 0, 0],

    // internal transition state
    _debounce: 0,          // frames remaining before another switch is allowed
    _changedPending: false, // focusNode/init asked for changed=true next update
    _childDist: new Map(), // per-child last-frame distance (for "approaching")

    // scratch eye (world) — reused to keep update() allocation-light
    _eye: { x: 0, y: 0, z: 0 },

    init(cosmos, camera) {
      this.cosmos = cosmos;
      this.camera = camera;
      this.active = cosmos.root;
      this.origin = this.active.ac.slice();
      this._debounce = 0;
      this._changedPending = false;
      this._childDist.clear();
      return this;
    },

    /* Absolute -> active-relative. Small because origin tracks active. */
    toLocal(ac) {
      const o = this.origin;
      return [ac[0] - o[0], ac[1] - o[1], ac[2] - o[2]];
    },

    /* Camera world position = origin + camera.eye() (eye is LOCAL). */
    _cameraWorld() {
      const e = this.camera.eye();           // local-frame eye
      const o = this.origin;
      const w = this._eye;
      w.x = o[0] + e.x;
      w.y = o[1] + e.y;
      w.z = o[2] + e.z;
      return w;
    },

    /* Move origin to `node`, re-expressing the camera so the rendered
       view is continuous. dist/yaw/pitch are preserved (scale + orbit
       orientation are origin-independent). */
    _rebase(node) {
      const cam = this.camera;
      const oldOrigin = this.origin;
      const t = cam.target;
      // world position the camera target currently looks at
      const wx = oldOrigin[0] + t.x;
      const wy = oldOrigin[1] + t.y;
      const wz = oldOrigin[2] + t.z;
      const newOrigin = node.ac.slice();
      const nlx = wx - newOrigin[0];
      const nly = wy - newOrigin[1];
      const nlz = wz - newOrigin[2];
      this.active = node;
      this.origin = newOrigin;
      // Set both the goal and the live target so the rebase is instant
      // and the easer converges to the same place.
      if (typeof cam.setGoal === 'function') {
        cam.setGoal({ targetX: nlx, targetY: nly, targetZ: nlz });
      }
      cam.target.x = nlx;
      cam.target.y = nly;
      cam.target.z = nlz;
      this._debounce = DEBOUNCE_FRAMES;
      this._childDist.clear();
    },

    /* The nearest enterable child the camera is approaching, or null.
       "Enterable": D_toC < childRadius * DESCEND_FACTOR. Among those,
       pick the nearest. Used both by descend logic and descendTarget(). */
    _nearestEnterableChild(camW) {
      const a = this.active;
      if (!a || typeof a.children !== 'function') return null;
      const kids = a.children();
      if (!kids || kids.length === 0) return null;
      let best = null, bestD = Infinity;
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        const cac = c.ac;
        const d = dist3(camW.x, camW.y, camW.z, cac[0], cac[1], cac[2]);
        if (d < c.radius * DESCEND_FACTOR && d < bestD) {
          bestD = d; best = c;
        }
      }
      return best;
    },

    /* HUD/preview: the child DESCEND would pick right now (or null). */
    descendTarget() {
      if (!this.active) return null;
      return this._nearestEnterableChild(this._cameraWorld());
    },

    /* Jump active to `node` (load / teleport). Origin snaps to node.ac;
       the view is NOT re-expressed (caller positions the camera). The
       next update() reports changed=true. */
    focusNode(node) {
      this.active = node;
      this.origin = node.ac.slice();
      this._debounce = DEBOUNCE_FRAMES;
      this._childDist.clear();
      this._changedPending = true;
      return this;
    },

    update(dtMs) {
      const a = this.active;
      const camW = this._cameraWorld();
      let changed = this._changedPending;
      this._changedPending = false;

      if (this._debounce > 0) this._debounce--;

      const aac = a.ac;
      const D = dist3(camW.x, camW.y, camW.z, aac[0], aac[1], aac[2]);

      // Only consider one transition per frame; debounce gates switches.
      if (this._debounce === 0) {
        // ASCEND: camera well outside the active node's INTERIOR extent ->
        // go to parent. viewRadius is the populated scale you fly among;
        // radius (the as-a-child capture size) is far smaller, so ascend
        // must key off viewRadius or you'd be ejected instantly. Falls back
        // to radius when viewRadius is absent (Navigator's own unit tests).
        const interior = a.viewRadius || a.radius;
        if (a.parent && D > interior * ASCEND_FACTOR) {
          this._rebase(a.parent);
          changed = true;
        } else {
          // DESCEND: nearest enterable child the camera is approaching.
          const kids = (typeof a.children === 'function') ? a.children() : null;
          if (kids && kids.length) {
            let best = null, bestD = Infinity;
            for (let i = 0; i < kids.length; i++) {
              const c = kids[i];
              const cac = c.ac;
              const d = dist3(camW.x, camW.y, camW.z, cac[0], cac[1], cac[2]);
              const prev = this._childDist.has(c) ? this._childDist.get(c) : Infinity;
              const approaching = d < prev;             // distance to C decreasing
              this._childDist.set(c, d);
              if (d < c.radius * DESCEND_FACTOR && approaching && d < bestD) {
                bestD = d; best = c;
              }
            }
            if (best) {
              this._rebase(best);
              changed = true;
            }
          }
        }
      } else {
        // Still debouncing: keep child-distance history fresh so the
        // "approaching" test is correct on the frame we're allowed to switch.
        if (typeof a.children === 'function') {
          const kids = a.children();
          if (kids) {
            for (let i = 0; i < kids.length; i++) {
              const c = kids[i];
              const cac = c.ac;
              this._childDist.set(c, dist3(camW.x, camW.y, camW.z, cac[0], cac[1], cac[2]));
            }
          }
        }
      }

      return { changed, active: this.active, context: this._buildContext() };
    },

    /* Context = active.parent (backdrop) + parent's other children
       (siblings) + active's own children, each annotated with a
       LOCAL-frame localPos and its summary. Capped to nearest CONTEXT_CAP. */
    _buildContext() {
      const a = this.active;
      const out = [];
      const seen = new Set();
      const push = (node) => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        out.push(node);
      };

      const parent = a.parent || null;
      push(parent);
      if (parent && typeof parent.children === 'function') {
        const sibs = parent.children();
        if (sibs) for (let i = 0; i < sibs.length; i++) {
          if (sibs[i] !== a) push(sibs[i]);
        }
      }
      if (typeof a.children === 'function') {
        const kids = a.children();
        if (kids) for (let i = 0; i < kids.length; i++) push(kids[i]);
      }

      // Annotate with local position (allocates the triple per node — the
      // context list is small and capped, so this stays cheap).
      const o = this.origin;
      for (let i = 0; i < out.length; i++) {
        const node = out[i];
        const ac = node.ac;
        node.localPos = [ac[0] - o[0], ac[1] - o[1], ac[2] - o[2]];
        // summary passes through (node.summary already set by cosmos);
        // ensure the field exists so consumers can rely on it.
        if (node.summary === undefined) node.summary = null;
      }

      // Cap to nearest CONTEXT_CAP by local distance from the origin.
      if (out.length > CONTEXT_CAP) {
        out.sort((p, q) => {
          const pl = p.localPos, ql = q.localPos;
          const pd = pl[0] * pl[0] + pl[1] * pl[1] + pl[2] * pl[2];
          const qd = ql[0] * ql[0] + ql[1] * ql[1] + ql[2] * ql[2];
          return pd - qd;
        });
        out.length = CONTEXT_CAP;
      }
      return out;
    },
  };

  globalThis.Navigator = nav;
})();
