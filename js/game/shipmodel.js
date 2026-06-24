'use strict';
/* ============================================================
   FABLE: DRIFTER v8 — procedural WIREFRAME ship + interior
   (js/game/shipmodel.js -> globalThis.ShipModel). DOM-free;
   attaches via globalThis only and loads in Node via
   indirect-eval (see test/smoke.js for the pattern).

   SHIP SPACE (the load-bearing contract, ARCHITECTURE-WANDERER):
     origin at ship centre, +Z FORWARD (the nose points at +Z),
     +Y UP, +X RIGHT. This matches Ship.facing() at yaw0/pitch0.
   The integrator owns the ship->node-local transform M and just
   feeds these ship-space line/point arrays through it each frame.

   AESTHETIC. The universe is point sprites and additive glow, so
   the ship is a glowing CYAN WIREFRAME (GL_LINES) rather than solid
   geometry. We sketch a recognisable hull by hand — a pointed nose
   at +Z, a swept body with delta wings, and an engine block at -Z —
   then frame an interior the avatar can stand in: a cockpit cage
   forward, a corridor through the middle, and a cargo hold aft.
   `nodes` are glowing interior markers (seat / console / engine /
   cargo); `bounds` are the axis-aligned walkable volumes; `clamp`
   snaps a point to the nearest spot inside the union of bounds.

   DETERMINISM. The base sketch is fixed coordinates. The optional
   seed only nudges a handful of decorative hull greebles via a
   seeded mulberry32 RNG (the repo pattern) so the geometry is
   byte-for-byte reproducible for any given seed, and identical
   across repeated build() calls (cached + idempotent).
   ============================================================ */
(function () {

  // ---- seeded mulberry32 (the repo RNG pattern) ----
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- overall dimensions (ship-space units; SCALE = world length) ----
  const SCALE = 16;          // bow-to-stern length, ~16 world units
  const NOSE  =  8.0;        // +Z tip of the nose
  const TAIL  = -8.0;        // -Z back of the engine block
  const HALF_W = 4.6;        // wing half-span (X)
  const HALF_H = 2.4;        // hull half-height (Y)

  // Colour palette for glowing interior nodes. colorIdx into this table;
  // the integrator/renderer maps the index to a sprite colour.
  // 0 cyan, 1 warm white, 2 amber, 3 magenta.
  const NODE_COLORS = [
    [0.45, 0.95, 1.00], // 0 cyan  — pilot seat
    [0.95, 0.97, 1.00], // 1 white — console
    [1.00, 0.55, 0.20], // 2 amber — engine core
    [0.95, 0.45, 0.95], // 3 magenta — cargo
  ];

  // Small line builder: push a segment (two endpoints) into a flat list.
  function makeBuilder() {
    const out = [];
    return {
      seg(a, b) { out.push(a[0], a[1], a[2], b[0], b[1], b[2]); },
      // a closed/loop polyline of points -> connect consecutive (and wrap).
      loop(pts) {
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
        }
      },
      // an open polyline (no wrap).
      path(pts) {
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i + 1];
          out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
        }
      },
      // a wireframe box from min/max corners (12 edges).
      box(min, max) {
        const x0 = min[0], y0 = min[1], z0 = min[2];
        const x1 = max[0], y1 = max[1], z1 = max[2];
        const c = [
          [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], // back face (-? z0)
          [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], // front face (z1)
        ];
        const E = [
          [0, 1], [1, 2], [2, 3], [3, 0], // back ring
          [4, 5], [5, 6], [6, 7], [7, 4], // front ring
          [0, 4], [1, 5], [2, 6], [3, 7], // connectors
        ];
        for (const [i, j] of E) {
          const a = c[i], b = c[j];
          out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
        }
      },
      get array() { return out; },
    };
  }

  // ----------------------------------------------------------------------
  // Hull + interior sketch. Returns {lines, nodes, seat, bounds}. The whole
  // thing is deterministic for a given seed (rng only nudges greebles).
  // ----------------------------------------------------------------------
  function buildGeometry(seed) {
    const rng = makeRng((seed >>> 0) || 0xC0FFEE);
    const B = makeBuilder();

    // === HULL OUTLINE =====================================================
    // The body is a faceted "diamond" cross-section (top/bottom ridge + side
    // chines) that tapers from a sharp nose at +Z to a broad engine deck at
    // -Z. We define cross-section RINGS along Z and connect them, then add a
    // nose spike, delta wings, twin tail fins, and an engine block.

    // A ring is 6 points around the hull at a given z, scaled by (wx,hy).
    // order: right-chine, top-front... we keep it simple: a hexagon in the
    // XY plane: right, top-right, top-left, left, bottom-left, bottom-right.
    function ring(z, wx, hy) {
      const tx = wx * 0.55, ty = hy * 0.85; // upper/lower chine inset
      return [
        [ wx,        0,   z], // right chine
        [ tx,   ty,       z], // top-right
        [-tx,   ty,       z], // top-left
        [-wx,        0,   z], // left chine
        [-tx,  -ty * 0.7, z], // bottom-left (belly is shallower)
        [ tx,  -ty * 0.7, z], // bottom-right
      ];
    }

    // Profile of half-width / half-height along Z (nose -> tail). Hand-tuned
    // so the body swells just aft of the cockpit then narrows into the engine.
    //   z,    halfWidth, halfHeight
    const PROFILE = [
      [ 7.6, 0.25, 0.30], // just behind the nose tip
      [ 6.0, 0.95, 0.95], // cockpit shoulders
      [ 4.0, 1.70, 1.55], // forward fuselage
      [ 1.5, 2.15, 1.80], // widest of the body
      [-1.0, 2.05, 1.70], // mid fuselage (cargo)
      [-3.5, 1.75, 1.55], // aft fuselage
      [-5.5, 1.55, 1.45], // engine shoulders
      [-7.2, 1.35, 1.30], // engine deck
    ];

    const rings = PROFILE.map(p => ring(p[0], p[1], p[2]));
    // draw each ring as a loop, and longitudinal stringers between rings.
    for (const r of rings) B.loop(r);
    for (let i = 0; i < rings.length - 1; i++) {
      const a = rings[i], b = rings[i + 1];
      for (let k = 0; k < a.length; k++) B.seg(a[k], b[k]);
    }

    // Nose spike: from the front ring forward to the sharp tip at +Z.
    const tip = [0, 0.10, NOSE];
    for (const p of rings[0]) B.seg(p, tip);
    // a couple of crisp nose chines straight to the tip for a "pointed" read.
    B.seg([0, 0.55, 6.0], tip);
    B.seg([0, -0.35, 6.0], tip);

    // === DELTA WINGS ======================================================
    // Swept-back delta wings springing from the widest body, raking down/out
    // toward -Z. Mirror across X. Each wing is a quad with a leading edge.
    function wing(side) {
      const s = side; // +1 right, -1 left
      const root_f = [s * 1.9,  0.05,  1.8];  // root leading
      const root_b = [s * 1.7, -0.10, -3.6];  // root trailing
      const tip_f  = [s * HALF_W, -0.55, -0.6]; // wingtip leading
      const tip_b  = [s * (HALF_W - 0.5), -0.75, -3.0]; // wingtip trailing
      B.loop([root_f, tip_f, tip_b, root_b]);
      // a spar across the wing for the wireframe to read as a surface.
      B.seg(root_f, tip_b);
      // wingtip pod / light pylon.
      const pod = [s * (HALF_W + 0.15), -0.55, -1.2];
      B.seg(tip_f, pod);
      B.seg(tip_b, pod);
    }
    wing(+1); wing(-1);

    // Canards: small forward fins near the cockpit for a sleeker silhouette.
    function canard(side) {
      const s = side;
      const a = [s * 0.95, 0.30, 5.0];
      const b = [s * 2.2,  0.55, 4.1];
      const c = [s * 1.8,  0.20, 3.4];
      B.loop([a, b, c]);
    }
    canard(+1); canard(-1);

    // === TWIN TAIL FINS ===================================================
    // Vertical stabilisers rising from the aft deck.
    function fin(side) {
      const s = side;
      const base_f = [s * 0.9, 0.9, -3.8];
      const base_b = [s * 0.9, 0.9, -6.6];
      const top_b  = [s * 1.05, 2.7, -6.2];
      const top_f  = [s * 1.0, 2.1, -4.4];
      B.loop([base_f, top_f, top_b, base_b]);
    }
    fin(+1); fin(-1);

    // === ENGINE BLOCK (-Z) ================================================
    // A boxy thruster cluster at the stern with twin nozzle rings.
    B.box([-1.7, -1.2, TAIL], [1.7, 1.2, -5.4]);
    // nozzle rings (octagons) on the back face, glowing thruster mouths.
    function nozzle(cx, cy) {
      const r = 0.7, z = TAIL - 0.0;
      const pts = [];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, z]);
      }
      B.loop(pts);
      // a slightly recessed inner ring for depth.
      const inner = pts.map(p => [cx + (p[0] - cx) * 0.5, cy + (p[1] - cy) * 0.5, z + 0.6]);
      B.loop(inner);
      for (let k = 0; k < 8; k++) B.seg(pts[k], inner[k]);
    }
    nozzle(-0.85, -0.1);
    nozzle( 0.85, -0.1);

    // Greebles: a handful of small seeded surface struts on the dorsal spine
    // (deterministic per seed; purely decorative, never affect bounds).
    const nGreeble = 6;
    for (let i = 0; i < nGreeble; i++) {
      const z = -3.0 + rng() * 8.0;
      const w = 0.2 + rng() * 0.5;
      const h = 0.9 + rng() * 0.6;
      const x = (rng() - 0.5) * 0.4;
      B.seg([x - w, h, z], [x + w, h, z]);
      B.seg([x, h, z], [x, h + 0.3 + rng() * 0.3, z]);
    }

    // === INTERIOR FRAMING =================================================
    // The avatar walks INSIDE the hull. We frame three connected spaces along
    // the centreline at roughly floor height. Floor sits a touch below centre.
    const FLOOR = -0.9;   // walkable floor Y
    const CEIL  =  1.3;   // interior ceiling Y

    // Cockpit cage (forward): a domed cage around the pilot seat.
    const cpZ0 = 3.2, cpZ1 = 6.2, cpHW = 1.25;
    B.box([-cpHW, FLOOR, cpZ0], [cpHW, CEIL, cpZ1]);
    // canopy ribs arcing over the cockpit toward the nose.
    for (let k = 0; k <= 3; k++) {
      const z = cpZ0 + (cpZ1 - cpZ0) * (k / 3);
      B.path([[-cpHW, 0.3, z], [-cpHW * 0.6, CEIL + 0.25, z],
              [cpHW * 0.6, CEIL + 0.25, z], [cpHW, 0.3, z]]);
    }
    // a forward window frame angling to the nose.
    B.path([[-cpHW, 0.3, cpZ1], [-0.6, 0.2, NOSE - 1.0],
            [0.6, 0.2, NOSE - 1.0], [cpHW, 0.3, cpZ1]]);

    // Corridor (mid): a rectangular tube connecting cockpit to hold.
    const coZ0 = -1.2, coZ1 = 3.2, coHW = 0.9;
    B.box([-coHW, FLOOR, coZ0], [coHW, CEIL, coZ1]);
    // a couple of corridor frame hoops for the wireframe rhythm.
    for (let k = 1; k <= 3; k++) {
      const z = coZ0 + (coZ1 - coZ0) * (k / 4);
      B.loop([[-coHW, FLOOR, z], [coHW, FLOOR, z],
              [coHW, CEIL, z], [-coHW, CEIL, z]]);
    }

    // Cargo hold (aft): a broader bay before the engine bulkhead.
    const chZ0 = -4.6, chZ1 = -1.2, chHW = 1.7;
    B.box([-chHW, FLOOR, chZ0], [chHW, CEIL, chZ1]);
    // cargo crates (small boxes) as glowing interior detail.
    B.box([-1.4, FLOOR, -4.2], [-0.4, FLOOR + 0.9, -3.2]);
    B.box([ 0.5, FLOOR, -4.0], [ 1.4, FLOOR + 0.7, -3.1]);
    B.box([ 0.4, FLOOR, -2.3], [ 1.3, FLOOR + 1.0, -1.4]);

    // === WALKABLE BOUNDS (axis-aligned) ===================================
    // Three slightly inset volumes the avatar can occupy; their union spans
    // cockpit + corridor + hold. Inset from the frame so the avatar's eye
    // doesn't poke through the wireframe walls.
    // X/Y are inset from the frame so the avatar doesn't poke through the
    // wireframe walls. The corridor's Z is NOT inset — it reaches the cockpit
    // and hold frame faces — so the union of bounds is CONTINUOUS in Z and the
    // avatar can walk bow-to-stern without hitting an unwalkable seam.
    const inset = 0.15;
    const bounds = [
      // cockpit
      { min: [-(cpHW - inset), FLOOR, cpZ0 + inset],
        max: [ (cpHW - inset), CEIL,  cpZ1 - inset] },
      // corridor — Z extended to overlap each neighbour's inset start/end so
      // the walkable union is continuous (no seam) from cockpit to hold.
      { min: [-(coHW - inset), FLOOR, chZ1 - inset],
        max: [ (coHW - inset), CEIL,  cpZ0 + inset] },
      // cargo hold
      { min: [-(chHW - inset), FLOOR, chZ0 + inset],
        max: [ (chHW - inset), CEIL,  chZ1 - inset] },
    ];

    // === INTERIOR NODES (glowing markers) =================================
    // Each pos is placed INSIDE a bound. label + colorIdx for HUD/renderer.
    const seatPos = [0, FLOOR + 0.45, 4.5];        // pilot seat, in cockpit
    const nodes = [
      { pos: seatPos.slice(),          colorIdx: 0, label: 'pilot seat' },
      { pos: [0, FLOOR + 0.95, 5.5],   colorIdx: 1, label: 'console'    },
      { pos: [0, FLOOR + 0.6, -4.3],   colorIdx: 2, label: 'engine core'},
      { pos: [-0.9, FLOOR + 0.5, -3.7],colorIdx: 3, label: 'cargo'      },
    ];

    // === COCKPIT CAMERA MOUNT (seat) ======================================
    // Eye slightly above the seat, looking forward along +Z.
    const seat = {
      pos: seatPos.slice(),
      forward: [0, 0, 1],
      eye: [seatPos[0], seatPos[1] + 0.65, seatPos[2]],
    };

    return {
      lines: Float32Array.from(B.array),
      nodes,
      seat,
      bounds,
    };
  }

  // ----------------------------------------------------------------------
  // Public object: caches a built result; build() is idempotent per seed.
  // ----------------------------------------------------------------------
  const ShipModel = {
    scale: SCALE,
    lineColor: [0.40, 0.92, 1.00], // cyan-ish hull glow

    // populated by build()
    lines: null,
    nodes: null,
    seat: null,
    bounds: null,

    _seed: null,

    /* build(seed?) — generate (or return cached) geometry. Idempotent:
       calling repeatedly with the same seed returns the identical arrays;
       a different seed rebuilds. Returns `this` for chaining. */
    build(seed) {
      const s = (seed === undefined || seed === null) ? 0 : (seed >>> 0);
      if (this.lines && this._seed === s) return this;
      const g = buildGeometry(s);
      this.lines = g.lines;
      this.nodes = g.nodes;
      this.seat = g.seat;
      this.bounds = g.bounds;
      this._seed = s;
      return this;
    },

    /* clamp(pos) -> [x,y,z] — nearest point inside the UNION of walkable
       bounds. If pos is already inside some bound, it is returned unchanged.
       Otherwise we clamp to each bound's box and pick the closest result
       (which lands on the nearest bound's surface/interior). */
    clamp(pos) {
      if (!this.bounds) this.build();
      const x = +pos[0], y = +pos[1], z = +pos[2];
      const bs = this.bounds;

      // already inside any bound? return as-is.
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        if (x >= b.min[0] && x <= b.max[0] &&
            y >= b.min[1] && y <= b.max[1] &&
            z >= b.min[2] && z <= b.max[2]) {
          return [x, y, z];
        }
      }

      // otherwise: clamp into each box, keep the nearest projection.
      let best = null, bestD = Infinity;
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        const cx = x < b.min[0] ? b.min[0] : (x > b.max[0] ? b.max[0] : x);
        const cy = y < b.min[1] ? b.min[1] : (y > b.max[1] ? b.max[1] : y);
        const cz = z < b.min[2] ? b.min[2] : (z > b.max[2] ? b.max[2] : z);
        const dx = cx - x, dy = cy - y, dz = cz - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = [cx, cy, cz]; }
      }
      return best;
    },
  };

  // build once eagerly so the static arrays are available on load.
  ShipModel.build();

  globalThis.ShipModel = ShipModel;
})();
