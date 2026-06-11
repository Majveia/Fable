'use strict';
/* ============================================================
   FABLE UNIVERSE v3 — stellar evolution (js/core/evolution.js)
   DOM-free; attaches via globalThis only.

   Operates on a *view* { n, mass, rad, colorIdx, type, setDirty() }
   so the same code drives the CPU Bodies store and the GPU massive
   mirror (see docs/ARCHITECTURE-GPU.md).

   State is SLOT-parallel, not identity-parallel. The CPU engine
   removes captured bodies by swap-pop, which reshuffles which star
   occupies which slot; a reshuffled slot simply inherits the
   previous occupant's evolutionary clock. At demo scale (thousands
   of statistically dying stars) this is invisible and is accepted
   by the v3 contract. Likewise, if n shrinks and then regrows
   within the already-initialized range, the recycled slots keep
   their old clocks. Slots beyond the initialized range (e.g. a
   user-dropped body) are initialized deterministically on demand;
   non-star types are simply skipped every step.
   ============================================================ */
(function () {
  const TYPE_STAR = 0, TYPE_BH = 1;

  // Phases.
  const PH_MAIN = 0, PH_GIANT = 1, PH_FLASH = 2, PH_REMNANT = 3;

  const GIANT_AT = 0.85;     // red-giant phase begins at 85% of lifetime
  const FLASH_MYR = 12;      // supernova flash duration, sim-Myr
  const IMMORTAL_MYR = 1e6;  // K/M dwarfs: effectively forever at demo scale

  // Deterministic seedable RNG (mulberry32).
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Lifetime in sim-Myr by spectral class (palette index 0..6 = O..M).
  // Tuning: the default galaxy runs myrPerT 0.5, dt 0.22 @ 60 fps
  // ≈ 6.6 sim-Myr per wall-second. O/B/A spans 80–250 Myr and initial
  // ages are scattered up to half a lifetime (see _initSlot), so the
  // first supernovae appear within seconds and a steady drizzle of
  // them follows. F/G die over demo-minutes; K/M never do.
  function lifetimeMyr(cls, u) {
    switch (cls) {
      case 0: return 80 + u * 40;    // O:  80–120
      case 1: return 110 + u * 70;   // B: 110–180
      case 2: return 160 + u * 90;   // A: 160–250
      case 3: return 600 + u * 300;  // F: 600–900
      case 4: return 850 + u * 350;  // G: 850–1200
      default: return IMMORTAL_MYR;  // K, M, and any non-O..M palette (e.g. Sol)
    }
  }

  function ceilPow2(n) {
    let p = 1024;
    while (p < n) p *= 2;
    return p;
  }

  const Evolution = {
    // Exposed for tests/debugging; treat as read-only outside this file.
    PH_MAIN, PH_GIANT, PH_FLASH, PH_REMNANT,

    _seed: 1,
    _cap: 0,
    _inited: 0,
    _age: null,        // Float64Array, sim-Myr
    _life: null,       // Float64Array, sim-Myr
    _phase: null,      // Uint8Array
    _baseRad: null,    // Float32Array, rad at init
    _baseColor: null,  // Uint8Array, colorIdx at init
    _roll: null,       // Float32Array, remnant roll (drawn ONCE per slot)

    // Allocate slot-parallel state for view.n bodies. Deterministic
    // given seed: every slot consumes exactly three RNG draws.
    reset(view, seed) {
      this._seed = (seed >>> 0) || 1;
      const n = view.n | 0;
      const cap = ceilPow2(n);
      this._cap = cap;
      this._age = new Float64Array(cap);
      this._life = new Float64Array(cap);
      this._phase = new Uint8Array(cap);
      this._baseRad = new Float32Array(cap);
      this._baseColor = new Uint8Array(cap);
      this._roll = new Float32Array(cap);
      const rng = mulberry32(this._seed);
      for (let i = 0; i < n; i++) this._initSlot(i, view, rng);
      this._inited = n;
    },

    _initSlot(i, view, rng) {
      const uLife = rng(), uAge = rng(), uRoll = rng();
      const cls = view.colorIdx[i];
      const L = lifetimeMyr(cls, uLife);
      this._life[i] = L;
      // Populations are mid-life, not newborn: scatter initial ages up
      // to half a lifetime so deaths start within seconds of a scenario
      // loading instead of after a silent first minute.
      this._age[i] = uAge * 0.5 * L;
      this._phase[i] = PH_MAIN;
      this._baseRad[i] = view.rad[i];
      this._baseColor[i] = cls;
      this._roll[i] = uRoll;
    },

    // Tolerate the view growing (user-dropped bodies) or shrinking
    // (bodies eaten by black holes; CPU swap-pop). New slots get
    // deterministic per-slot streams so growth order does not perturb
    // already-initialized slots.
    _ensure(view, n) {
      if (!this._age) { this.reset(view, this._seed); return; }
      if (n > this._cap) {
        const cap = ceilPow2(n);
        const grow = (old, T) => { const a = new T(cap); a.set(old); return a; };
        this._age = grow(this._age, Float64Array);
        this._life = grow(this._life, Float64Array);
        this._phase = grow(this._phase, Uint8Array);
        this._baseRad = grow(this._baseRad, Float32Array);
        this._baseColor = grow(this._baseColor, Uint8Array);
        this._roll = grow(this._roll, Float32Array);
        this._cap = cap;
      }
      if (n > this._inited) {
        for (let i = this._inited; i < n; i++) {
          const rng = mulberry32((this._seed + Math.imul(i + 1, 0x9E3779B9)) >>> 0);
          this._initSlot(i, view, rng);
        }
        this._inited = n;
      }
    },

    // Advance ages by dtMyr and run phase transitions:
    //   main sequence -> red giant at 85% lifetime (color lerps toward
    //   palette 6, rad -> baseRad*1.6 over the phase) -> supernova at
    //   100% (rad = baseRad*6, colorIdx 3, mass -> 0.2*original, flash
    //   ~12 sim-Myr) -> remnant, rolled once per star:
    //     70% white dwarf  (rad 0.5, palette 3)
    //     27% neutron star (rad 0.4, palette 8)
    //      3% black hole   (type -> TYPE_BH, palette 8, rad 2.0)
    //   DEMO-SCALE CHEAT: a real collapsed core would be far too light
    //   to feed at our captureRadius, so the black-hole branch
    //   multiplies the original mass by 12 (remnant = 0.2 * 12 * m0 =
    //   2.4*m0). The boost is applied at the moment the type flips to
    //   TYPE_BH, so the total mass in bodies of type STAR still
    //   decreases monotonically across supernovae.
    // Only TYPE_STAR evolves. Returns the number of supernovae fired
    // this call; calls view.setDirty() if any visual/mass/type changed.
    // Slot indices of this call's supernovae land in lastEvents so the
    // caller can spawn remnant shells at those bodies' positions.
    lastEvents: [],
    step(view, dtMyr) {
      const n = view.n | 0;
      this._ensure(view, n);
      const { mass, rad, colorIdx, type } = view;
      const age = this._age, life = this._life, phase = this._phase;
      const baseRad = this._baseRad, baseColor = this._baseColor, roll = this._roll;
      let dirty = false, fired = 0;
      this.lastEvents.length = 0;

      for (let i = 0; i < n; i++) {
        const ph = phase[i];
        if (ph === PH_REMNANT) continue;          // terminal (WD/NS slot)
        if (type[i] !== TYPE_STAR) continue;      // BHs, planets, dust, gas
        const a = age[i] + dtMyr;
        age[i] = a;
        const L = life[i];

        if (ph === PH_FLASH) {
          if (a >= L + FLASH_MYR) {
            const r = roll[i];
            phase[i] = PH_REMNANT;
            if (r < 0.70) {                       // white dwarf
              rad[i] = 0.5; colorIdx[i] = 3;
            } else if (r < 0.97) {                // neutron star
              rad[i] = 0.4; colorIdx[i] = 8;
            } else {                              // black hole (see cheat above)
              mass[i] *= 12;
              rad[i] = 2.0; colorIdx[i] = 8; type[i] = TYPE_BH;
            }
            dirty = true;
          }
          continue;
        }

        if (a >= L) {                             // supernova!
          phase[i] = PH_FLASH;
          rad[i] = baseRad[i] * 6;
          colorIdx[i] = 3;
          mass[i] *= 0.2;                         // envelope ejected
          fired++;
          this.lastEvents.push(i);
          dirty = true;
        } else if (a >= L * GIANT_AT) {           // red giant
          phase[i] = PH_GIANT;
          const t = (a - L * GIANT_AT) / (L * (1 - GIANT_AT));
          rad[i] = baseRad[i] * (1 + 0.6 * t);
          const c0 = baseColor[i];
          colorIdx[i] = (c0 + (6 - c0) * t + 0.5) | 0;
          dirty = true;
        }
      }

      if (dirty) view.setDirty();
      return fired;
    },
  };

  globalThis.Evolution = Evolution;
})();
