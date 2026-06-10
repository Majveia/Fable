'use strict';
/* ============================================================
   FABLE UNIVERSE v2 — body store (js/core/bodies.js)
   Parallel typed arrays, swap-pop removal. Headless: attaches
   to globalThis only, never touches the DOM.
   ============================================================ */

(function () {
  const CAP = 1 << 17;

  const Bodies = {
    // -------- type constants (shared contract) --------
    TYPE_STAR: 0,
    TYPE_BH: 1,
    TYPE_PLANET: 2,
    TYPE_DUST: 3,
    TYPE_GAS: 4,

    CAP,
    n: 0,

    px: new Float64Array(CAP),
    py: new Float64Array(CAP),
    pz: new Float64Array(CAP),
    vx: new Float64Array(CAP),
    vy: new Float64Array(CAP),
    vz: new Float64Array(CAP),
    mass: new Float64Array(CAP),
    rad: new Float32Array(CAP),      // visual radius, world units
    colorIdx: new Uint8Array(CAP),   // palette index (see renderer)
    type: new Uint8Array(CAP),       // 0 star, 1 BH, 2 planet, 3 dust, 4 gas
    names: new Array(CAP).fill(null),

    add(x, y, z, vx_, vy_, vz_, mass_, rad_, colorIdx_, type_, name) {
      const i = this.n;
      if (i >= this.CAP) return -1;
      this.px[i] = x; this.py[i] = y; this.pz[i] = z;
      this.vx[i] = vx_; this.vy[i] = vy_; this.vz[i] = vz_;
      this.mass[i] = mass_;
      this.rad[i] = rad_;
      this.colorIdx[i] = colorIdx_;
      this.type[i] = type_;
      this.names[i] = name || null;
      this.n = i + 1;
      return i;
    },

    // Swap-pop: the last live body fills slot i. Keeps names in sync.
    remove(i) {
      const last = --this.n;
      this.px[i] = this.px[last]; this.py[i] = this.py[last]; this.pz[i] = this.pz[last];
      this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last]; this.vz[i] = this.vz[last];
      this.mass[i] = this.mass[last];
      this.rad[i] = this.rad[last];
      this.colorIdx[i] = this.colorIdx[last];
      this.type[i] = this.type[last];
      this.names[i] = this.names[last];
      this.names[last] = null;
    },

    clear() {
      this.n = 0;
      this.names.fill(null);
    },
  };

  globalThis.Bodies = Bodies;
})();
