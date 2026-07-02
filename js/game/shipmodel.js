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
  // Proportions follow the spacecraft research: a long, slender fuselage
  // (fineness ~8:1), a double-delta wing (span ~0.6L), a swept tail, and an
  // ogive nose tapered over the front ~18% of length. Length L ~= 16 units
  // (NOSE - TAIL), so the normalized 0..1 research values map ~x16.
  const SCALE = 16;          // bow-to-stern length, ~16 world units
  const NOSE  =  8.0;        // +Z tip of the nose
  const TAIL  = -8.0;        // -Z back of the engine block
  const HALF_W = 4.8;        // wing half-span (X) -> span ~9.6 ~= 0.6L
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

  // Solid triangle builder: accumulates a triangle mesh (positions, per-vertex
  // normals, per-triangle material colour) in SHIP SPACE. Layout:
  //   tris  : Float32Array, 9 floats per triangle (3 verts x xyz)
  //   norms : Float32Array, 9 floats per triangle (3 unit normals, one/vert)
  //   triColor: Float32Array, 3 floats RGB per triangle
  // Winding is CCW when viewed from OUTSIDE; the geometric normal is the
  // normalized cross product of (b-a)x(c-a). Helpers below let callers either
  // accept the flat face normal or supply smooth per-vertex normals.
  function makeMesh() {
    const pos = [];      // flat xyz, 9 per tri
    const nrm = [];      // flat xyz, 9 per tri
    const col = [];      // flat rgb, 3 per tri
    function sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
    function crs(u, v) {
      return [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
    }
    function unit(v) {
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0]/l, v[1]/l, v[2]/l];
    }
    return {
      // flat-shaded triangle: face normal from winding (a,b,c CCW from outside).
      tri(a, b, c, color) {
        const n = unit(crs(sub(b, a), sub(c, a)));
        pos.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
        nrm.push(n[0],n[1],n[2], n[0],n[1],n[2], n[0],n[1],n[2]);
        col.push(color[0], color[1], color[2]);
      },
      // smooth triangle: caller supplies a per-vertex normal for each vertex.
      striz(a, na, b, nb, c, nc, color) {
        const ua = unit(na), ub = unit(nb), uc = unit(nc);
        pos.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
        nrm.push(ua[0],ua[1],ua[2], ub[0],ub[1],ub[2], uc[0],uc[1],uc[2]);
        col.push(color[0], color[1], color[2]);
      },
      // quad a,b,c,d (CCW from outside) -> two flat triangles.
      quad(a, b, c, d, color) {
        this.tri(a, b, c, color);
        this.tri(a, c, d, color);
      },
      // axis-aligned solid box from min/max corners (12 tris, outward normals).
      box(min, max, color) {
        const x0=min[0], y0=min[1], z0=min[2];
        const x1=max[0], y1=max[1], z1=max[2];
        const p = [
          [x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0], // 0..3 back (-Z)
          [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1], // 4..7 front (+Z)
        ];
        // each face CCW seen from outside
        this.quad(p[4],p[5],p[6],p[7], color); // +Z front
        this.quad(p[1],p[0],p[3],p[2], color); // -Z back
        this.quad(p[0],p[4],p[7],p[3], color); // -X left
        this.quad(p[5],p[1],p[2],p[6], color); // +X right
        this.quad(p[3],p[7],p[6],p[2], color); // +Y top
        this.quad(p[0],p[1],p[5],p[4], color); // -Y bottom
      },
      get pos() { return pos; },
      get nrm() { return nrm; },
      get col() { return col; },
    };
  }

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
    const M = makeMesh();

    // ---- material palette (solid hull) ----
    // Realistic spacecraft livery from the research, mapped to LINEAR 0..1
    // (the renderer applies Lambert + ambient + rim on top; emissive parts may
    // exceed 1). Three material zones dominate: near-white ceramic TPS body,
    // black RCC leading edges / nose cap / nozzle interiors, and gold/amber MLI
    // foil accents near the engine bay, over a gunmetal structural substrate.
    // sRGB->linear approx via square (c/255)^2 keeps the TPS reading as a calm
    // off-white rather than blowing out under the additive bloom.
    const MAT = {
      tps:     [0.78, 0.78, 0.74],  // near-white ceramic TPS (235,235,228)
      tpsDk:   [0.50, 0.51, 0.50],  // shaded TPS / belly tile field
      tpsLt:   [0.88, 0.89, 0.86],  // sunlit upper TPS highlight
      tpsMid:  [0.60, 0.61, 0.58],  // mid-tone TPS tile (panel checker step)
      tpsCool: [0.71, 0.73, 0.72],  // cool-grey tile blanket (FRSI-ish)
      rcc:     [0.05, 0.05, 0.06],  // black RCC leading edge / nose cap (20,20,22)
      gunmetal:[0.16, 0.18, 0.20],  // gunmetal structure (84,88,94)
      gold:    [0.55, 0.40, 0.10],  // gold MLI foil (212,175,55)
      goldDk:  [0.42, 0.30, 0.07],  // amber MLI (199,150,40)
      soot:    [0.10, 0.09, 0.08],  // scorch/soot near nozzles + belly aft
      // legacy hull aliases kept so the rest of the build reads cleanly
      hull:    [0.78, 0.78, 0.74],  // = tps
      hullDk:  [0.50, 0.51, 0.50],  // = tpsDk (aft/belly tiles)
      hullLt:  [0.88, 0.89, 0.86],  // = tpsLt (upper deck highlight)
      accent:  [0.55, 0.40, 0.10],  // = gold MLI panel
      wing:    [0.74, 0.74, 0.70],  // wing skin (TPS, slightly cooler)
      wingEdge:[0.05, 0.05, 0.06],  // wing leading edge = black RCC
      fin:     [0.74, 0.74, 0.71],  // tail fin TPS
      engine:  [0.34, 0.31, 0.27],  // engine block (inconel/ablative tan)
      nozzleMetal:[0.30, 0.27, 0.23], // inconel bell wall (150,140,130)
      throat:  [1.60, 0.80, 0.30],  // glowing throat disk, warm HDR emissive
      bellMid: [0.55, 0.16, 0.07],  // hot mid-bell (120,40,20)
      bellLip: [0.07, 0.05, 0.05],  // dark cooled lip (25,20,20)
      bellRim: [0.50, 0.47, 0.42],  // machined bell rim ring (visible from aft)
      nozzle:  [1.60, 0.80, 0.30],  // legacy alias -> glowing throat
      canopy:  [0.04, 0.10, 0.14],  // tinted blue-green glass (30,45,55)
      rcsRim:  [0.03, 0.03, 0.03],  // black RCS thruster rim
      // interior materials (kept cohesive with the new livery)
      floor:   [0.20, 0.22, 0.24],
      floorDk: [0.12, 0.14, 0.16],  // alternate deck plate (tone contrast)
      console: [0.22, 0.28, 0.34],
      screen:  [0.20, 1.40, 1.60],  // emissive teal console screens (HDR)
      cabin:   [0.52, 0.36, 0.18],  // warm cabin accent panels
      strip:   [1.30, 1.20, 1.00],  // warm-white cabin light strip (HDR)
      seatMat: [0.28, 0.31, 0.36],
      crate:   [0.40, 0.31, 0.12],  // amber MLI-wrapped cargo
      bulkhd:  [0.24, 0.27, 0.31],
      readout: [0.20, 1.40, 1.60],  // glowing teal engine readout = screen
    };

    // Direction-hinted flat triangle/quad: guarantees the face normal agrees
    // with `want` by flipping the winding when needed. Used for surfaces whose
    // visible side matters under the renderer's eye-facing interior culling
    // (interior detail faces INTO the cabin; aft surfaces face AFT; etc).
    function triD(a, b, c, want, color) {
      const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2];
      const vx = c[0]-a[0], vy = c[1]-a[1], vz = c[2]-a[2];
      const nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
      if (nx*want[0] + ny*want[1] + nz*want[2] >= 0) M.tri(a, b, c, color);
      else M.tri(a, c, b, color);
    }
    function quadD(a, b, c, d, want, color) {
      triD(a, b, c, want, color);
      triD(a, c, d, want, color);
    }

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

    // Profile of half-width / half-height along Z (nose -> tail). Tuned for a
    // slender fuselage (fineness ~8:1: L~16, max diameter ~2x max halfWidth
    // ~4.3 -> ~7.4:1, with the nose ogive making the effective slenderness
    // read longer). The nose tapers as an ogive: a fast pinch over the front
    // ~18% then a gentle swell to the widest mid-body, narrowing into the
    // engine deck. Extra rings near the nose give the ogive its curved profile.
    //   z,    halfWidth, halfHeight
    const PROFILE = [
      [ 7.3, 0.16, 0.18], // ogive shoulder just behind the black nose cap
      [ 6.6, 0.55, 0.58], // ogive curve
      [ 6.0, 0.92, 0.95], // cockpit shoulders
      [ 4.0, 1.62, 1.50], // forward fuselage
      [ 1.5, 2.12, 1.78], // widest of the body
      [-1.0, 2.02, 1.68], // mid fuselage (cargo)
      [-3.5, 1.72, 1.52], // aft fuselage
      [-5.5, 1.52, 1.42], // engine shoulders
      [-7.2, 1.34, 1.28], // engine deck
      [-7.9, 1.12, 1.05], // boat-tail: sculpted taper into the engine bay
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

    // === SOLID FUSELAGE ===================================================
    // Close each pair of cross-section rings into quads (one per facet) so the
    // hull is a watertight solid that matches the wireframe silhouette. Smooth
    // normals: average the two adjacent facet normals at each ring vertex so
    // the faceted hull still shades smoothly around its girth.
    function ringFacetNormals(r) {
      // outward normal of each edge facet of a ring (in the XY plane, z const).
      const n = [];
      for (let k = 0; k < r.length; k++) {
        const a = r[k], b = r[(k + 1) % r.length];
        // edge direction in XY; outward normal points away from axis (0,0).
        let ex = b[0] - a[0], ey = b[1] - a[1];
        let nx = ey, ny = -ex; // rotate -90 -> outward for CCW-from-front order
        // ensure it points away from the centreline
        const mx = (a[0] + b[0]) * 0.5, my = (a[1] + b[1]) * 0.5;
        if (nx * mx + ny * my < 0) { nx = -nx; ny = -ny; }
        const l = Math.hypot(nx, ny) || 1;
        n.push([nx / l, ny / l, 0]);
      }
      return n;
    }
    // per-vertex smooth normal at ring vertex k = average of facet (k-1) and k.
    function vertNormals(r, fn) {
      const vn = [];
      for (let k = 0; k < r.length; k++) {
        const a = fn[(k - 1 + r.length) % r.length], b = fn[k];
        vn.push([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
      }
      return vn;
    }
    const ringFN = rings.map(ringFacetNormals);
    const ringVN = rings.map((r, i) => vertNormals(r, ringFN[i]));
    // Ring hexagon vertex order (from ring()): 0 right-chine, 1 top-right,
    // 2 top-left, 3 left-chine, 4 bottom-left, 5 bottom-right. So facet index
    // k spans verts k..k+1: facet 1 = top deck (tr->tl), facets 4 & 5 = belly.
    // Each ring-to-ring band is subdivided into z-SLICES and the tile tone is
    // varied per slice with a deterministic hash so the upper hull reads as a
    // fitted TPS tile field (Shuttle-orbiter feel) rather than one flat white
    // slab. Belly/aft zones keep their darker soot/gunmetal treatment.
    const SLICES = 3;
    function lerp3v(p, q, t) {
      return [p[0]+(q[0]-p[0])*t, p[1]+(q[1]-p[1])*t, p[2]+(q[2]-p[2])*t];
    }
    // Deterministic small hash -> 0..3 (independent of the decorative rng so
    // the tile pattern is stable across seeds).
    function tileHash(i, k, s) {
      let h = (i * 73856093) ^ (k * 19349663) ^ (s * 83492791);
      h = (h ^ (h >>> 13)) >>> 0;
      return h % 4;
    }
    // tone tables: top deck sparkles lighter, sides checker around base TPS.
    const TOP_TONES  = [MAT.tpsLt, MAT.tps, MAT.tpsLt, MAT.tpsMid];
    const SIDE_TONES = [MAT.tps, MAT.tpsCool, MAT.tps, MAT.tpsMid];
    for (let i = 0; i < rings.length - 1; i++) {
      const a = rings[i], b = rings[i + 1];
      const an = ringVN[i], bn = ringVN[i + 1];
      const za = rings[i][0][2];
      for (let k = 0; k < a.length; k++) {
        const k2 = (k + 1) % a.length;
        // Material zones: belly facets (4,5) read as the darker tile field and
        // pick up soot toward the aft (re-entry/thrust heating); the top deck
        // (facet 1) is sunlit TPS with light tile variation; sides are TPS
        // with a subtle panel checker. Aft of the engine shoulders the whole
        // girth darkens toward gunmetal/soot.
        const belly = (k === 4 || k === 5);
        for (let s = 0; s < SLICES; s++) {
          const t0 = s / SLICES, t1 = (s + 1) / SLICES;
          const pk0  = lerp3v(a[k],  b[k],  t0), pk1  = lerp3v(a[k],  b[k],  t1);
          const pk20 = lerp3v(a[k2], b[k2], t0), pk21 = lerp3v(a[k2], b[k2], t1);
          const nk0  = lerp3v(an[k],  bn[k],  t0), nk1  = lerp3v(an[k],  bn[k],  t1);
          const nk20 = lerp3v(an[k2], bn[k2], t0), nk21 = lerp3v(an[k2], bn[k2], t1);
          let mat;
          if (za < -4.5)      mat = belly ? MAT.soot : MAT.gunmetal;
          else if (belly)     mat = (za < 0) ? MAT.soot : MAT.tpsDk;
          else if (k === 1)   mat = TOP_TONES[tileHash(i, k, s)];   // top deck tiles
          else                mat = SIDE_TONES[tileHash(i, k, s)];  // side tile checker
          // same winding as the original band quads (CCW from outside; ring i
          // is the more +Z / forward ring), just sliced along z.
          M.striz(pk20, nk20, pk0, nk0, pk1, nk1, mat);
          M.striz(pk20, nk20, pk1, nk1, pk21, nk21, mat);
        }
      }
    }
    // Gold MLI foil accents: a crinkled foil band on the top deck over the
    // forward fuselage (between cockpit shoulders and the wide body), plus a
    // second band on the boat-tail right by the engine bay — grouped accents
    // against the clean white skin per the 80/20 rule.
    for (const i of [3, rings.length - 2]) {
      const a = rings[i], b = rings[i + 1];
      const an = ringVN[i], bn = ringVN[i + 1];
      const mat = (i % 2 === 0) ? MAT.gold : MAT.goldDk;
      M.striz(a[2], an[2], a[1], an[1], b[1], bn[1], mat);
      M.striz(a[2], an[2], b[1], bn[1], b[2], bn[2], mat);
    }

    // === SOLID NOSE CONE =================================================
    // Triangle fan from the forward ring (rings[0]) to the sharp tip.
    {
      const r = rings[0], rn = ringVN[0];
      // tip normal points forward (+Z) and slightly up to match the spike.
      const tn = [0, 0.18, 1];
      for (let k = 0; k < r.length; k++) {
        const k2 = (k + 1) % r.length;
        // Black RCC nose cap (re-entry leading surface), CCW from outside.
        M.striz(r[k], rn[k], r[k2], rn[k2], tip, tn, MAT.rcc);
      }
    }

    // === CANOPY GLASS + FRAMING =========================================
    // A faceted tinted canopy over the cockpit shoulders, framed by raised dark
    // metal mullions. Per the research, thick window frames (a single detail)
    // massively boost believability, so we model the glass panes slightly inset
    // and lay gunmetal frame strips along every pane seam (solid quads) plus a
    // bright wireframe outline for crisp trim.
    {
      const zf = 6.0, zb = 3.4, hw = 0.92, hy = 1.05;
      const fl = [-hw, 0.35, zf], fr = [hw, 0.35, zf];
      const bl = [-hw, 0.45, zb], br = [hw, 0.45, zb];
      const tf = [0, hy + 0.15, zf - 0.4], tb = [0, hy + 0.35, zb + 0.2];
      // glass panes (tinted, slightly recessed look via dark tint)
      M.tri(fl, fr, tf, MAT.canopy);          // front pane
      M.quad(fr, br, tb, tf, MAT.canopy);     // right pane
      M.quad(bl, fl, tf, tb, MAT.canopy);     // left pane
      M.tri(bl, br, tb, MAT.canopy);          // back pane

      // raised mullion frame: thin gunmetal slabs along the canopy seams.
      // a frame strip is a thin box centred on segment a->b, lifted outward.
      function strip(a, b, t) {
        const mx = (a[0]+b[0])*0.5, my = (a[1]+b[1])*0.5, mz = (a[2]+b[2])*0.5;
        const dx = b[0]-a[0], dy = b[1]-a[1], dz = b[2]-a[2];
        const len = Math.hypot(dx,dy,dz) || 1;
        // box bounds padded by t around the segment midline (axis-aligned;
        // fine for these short near-axis seams and reads as a thick frame).
        const min = [Math.min(a[0],b[0])-t, Math.min(a[1],b[1])-t*0.6, Math.min(a[2],b[2])-t];
        const max = [Math.max(a[0],b[0])+t, Math.max(a[1],b[1])+t*0.6, Math.max(a[2],b[2])+t];
        M.box(min, max, MAT.gunmetal);
        return len;
      }
      const fw = 0.06; // frame half-width ~ a few % of canopy width
      strip(fl, fr, fw);   // lower front rail
      strip(fl, tf, fw);   // left front A-pillar
      strip(fr, tf, fw);   // right front A-pillar
      strip(tf, tb, fw);   // dorsal spine rail
      strip(bl, br, fw);   // lower back rail
      strip(bl, tb, fw);   // left rear pillar
      strip(br, tb, fw);   // right rear pillar
      strip(fl, bl, fw);   // left sill
      strip(fr, br, fw);   // right sill

      // bright wireframe trim over the frame (canopy outline + centre mullion)
      B.loop([fl, fr, br, bl]);
      B.path([fl, tf, tb, bl]);
      B.path([fr, tf]); B.path([br, tb]);
      B.seg(tf, tb);
    }

    // === DOUBLE-DELTA WINGS ===============================================
    // A double-delta planform per the research: a steeply-swept inner glove
    // (leading edge ~75 deg) blending to a less-swept outboard panel (~45 deg),
    // with black RCC leading edges and a thin trailing edge. The wing is built
    // from two thin slabs (glove + outboard) sharing the mid leading/trailing
    // break, mirrored across X. Slight outboard dihedral lifts the wingtip.
    function wing(side) {
      const s = side; // +1 right, -1 left
      // planform vertices (top view), Y gives a touch of anhedral at the root
      // sweeping to a small dihedral at the tip.
      const root_f = [s * 1.85,  0.02,  2.4];   // glove root leading (far fwd -> high sweep)
      const root_b = [s * 1.70, -0.10, -3.7];   // root trailing
      const mid_f  = [s * 3.05, -0.18, -0.4];   // glove->outboard leading break
      const mid_b  = [s * 2.95, -0.30, -3.2];   // mid trailing
      const tip_f  = [s * HALF_W,      -0.30, -1.6]; // outboard leading (45 deg)
      const tip_b  = [s * (HALF_W-0.45),-0.40, -3.0]; // wingtip trailing
      B.loop([root_f, mid_f, tip_f, tip_b, mid_b, root_b]);
      B.seg(mid_f, mid_b);                 // panel break spar
      B.seg(root_f, tip_b);                // diagonal stringer
      // wingtip pod / nav-light pylon.
      const pod = [s * (HALF_W + 0.18), -0.30, -2.0];
      B.seg(tip_f, pod);
      B.seg(tip_b, pod);

      // --- SOLID WING SLAB: top + bottom + leading/trailing/tip edges. ---
      // Built per-panel so the planform break reads as a real chine. Helper
      // emits one slab from a planform loop of 4 corners (f-leading inner,
      // f-leading outer, trailing outer, trailing inner) with thickness TH.
      function slab(fi, fo, to, ti, TH, matSkin) {
        const up = TH, dn = -TH;
        const fit=[fi[0],fi[1]+up,fi[2]], fot=[fo[0],fo[1]+up,fo[2]];
        const tot=[to[0],to[1]+up,to[2]], tit=[ti[0],ti[1]+up,ti[2]];
        const fib=[fi[0],fi[1]+dn,fi[2]], fob=[fo[0],fo[1]+dn,fo[2]];
        const tob=[to[0],to[1]+dn,to[2]], tib=[ti[0],ti[1]+dn,ti[2]];
        if (s > 0) {
          M.quad(fit, fot, tot, tit, matSkin);    // top
          M.quad(fib, tib, tob, fob, matSkin);    // bottom
          M.quad(fib, fob, fot, fit, MAT.wingEdge); // leading edge (RCC)
          M.quad(tit, tot, tob, tib, MAT.wingEdge); // trailing edge
          M.quad(fot, fob, tob, tot, MAT.wingEdge); // outboard/tip edge
        } else {
          M.quad(tit, tot, fot, fit, matSkin);    // top (mirror winding)
          M.quad(fob, tob, tib, fib, matSkin);    // bottom
          M.quad(fit, fot, fob, fib, MAT.wingEdge); // leading edge
          M.quad(tib, tob, tot, tit, MAT.wingEdge); // trailing edge
          M.quad(tot, tob, fob, fot, MAT.wingEdge); // outboard/tip edge
        }
      }
      slab(root_f, mid_f, mid_b, root_b, 0.17, MAT.wing); // inner glove (thicker)
      slab(mid_f,  tip_f, tip_b, mid_b,  0.11, MAT.wing); // outboard (thin)
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

    // === CANTED TWIN TAIL FINS (V-TAIL) ==================================
    // Outward-canted stabilisers (~30 deg cant) swept ~45 deg, height ~0.27 of
    // wingspan. The outward cant reads instantly as 'aerospace'. Each fin is a
    // thin slab; the leading edge is black RCC, the skin is TPS.
    function fin(side) {
      const s = side;
      const CANT = 1.15; // top splayed further out than the base (~30 deg)
      const base_f = [s * 0.95, 0.85, -3.9];
      const base_b = [s * 0.95, 0.85, -6.7];
      const top_b  = [s * (0.95 + CANT), 2.55, -6.0];
      const top_f  = [s * (0.95 + CANT*0.9), 2.05, -4.5];
      B.loop([base_f, top_f, top_b, base_b]);

      // --- SOLID FIN: a thin vertical slab (two faces + edges). ---
      const TH = 0.10;
      const bf_o = [base_f[0] + s*TH, base_f[1], base_f[2]];
      const bb_o = [base_b[0] + s*TH, base_b[1], base_b[2]];
      const tb_o = [top_b[0]  + s*TH, top_b[1],  top_b[2]];
      const tf_o = [top_f[0]  + s*TH, top_f[1],  top_f[2]];
      const bf_i = [base_f[0] - s*TH, base_f[1], base_f[2]];
      const bb_i = [base_b[0] - s*TH, base_b[1], base_b[2]];
      const tb_i = [top_b[0]  - s*TH, top_b[1],  top_b[2]];
      const tf_i = [top_f[0]  - s*TH, top_f[1],  top_f[2]];
      if (s > 0) {
        M.quad(bf_o, tf_o, tb_o, bb_o, MAT.fin);   // outer face (+X)
        M.quad(bf_i, bb_i, tb_i, tf_i, MAT.fin);   // inner face
      } else {
        M.quad(bb_o, tb_o, tf_o, bf_o, MAT.fin);
        M.quad(bb_i, bf_i, tf_i, tb_i, MAT.fin);
      }
      // leading + trailing edges (same winding both sides)
      M.quad(bf_i, tf_i, tf_o, bf_o, MAT.wingEdge); // leading
      M.quad(bb_o, tb_o, tb_i, bb_i, MAT.wingEdge); // trailing
      M.quad(tf_o, tf_i, tb_i, tb_o, MAT.wingEdge); // top cap
    }
    fin(+1); fin(-1);

    // === SCULPTED STERN: BOAT-TAIL CLOSURE + RECESSED ENGINE BAY (-Z) =====
    // The fuselage rings themselves now taper into a boat-tail (last PROFILE
    // row), so the stern is closed with a sculpted funnel: the aft ring steps
    // inward/forward to a recessed engine-bay bulkhead, and the bell nozzles
    // grow out of that bay. Greebles (turbopump housings / feed lines) cluster
    // here per the research 80/20 rule; the rest of the hull stays clean.
    const aftRing = rings[rings.length - 1];          // boat-tail ring @ z=-7.9
    const AFT_Z = aftRing[0][2];
    const BAY_Z = AFT_Z + 0.55;                       // recessed bay bulkhead
    const bayRing = ring(BAY_Z, 1.12 * 0.76, 1.05 * 0.76);
    // funnel annulus: boat-tail rim -> recessed bay ring (gunmetal, aft-facing)
    for (let k = 0; k < aftRing.length; k++) {
      const k2 = (k + 1) % aftRing.length;
      // want: aft (-Z) with an outward radial tilt at the facet midpoint
      const mx = (aftRing[k][0] + aftRing[k2][0]) * 0.5;
      const my = (aftRing[k][1] + aftRing[k2][1]) * 0.5;
      quadD(aftRing[k], aftRing[k2], bayRing[k2], bayRing[k],
            [mx * 0.35, my * 0.35, -1], MAT.gunmetal);
    }
    // recessed bay bulkhead plate (sooted, aft-facing fan to the centre)
    const bayC = [0, 0, BAY_Z];
    for (let k = 0; k < bayRing.length; k++) {
      const k2 = (k + 1) % bayRing.length;
      triD(bayRing[k], bayRing[k2], bayC, [0, 0, -1], MAT.soot);
    }
    // crisp wireframe trim on the bay rim
    B.loop(bayRing);

    // turbopump housings + plumbing greebles tucked under the boat-tail
    for (const sx of [-1, 1]) {
      M.box([sx*0.55 - 0.26, -1.02, -6.6], [sx*0.55 + 0.26, -0.48, -5.6], MAT.gunmetal);
      B.box([sx*0.55 - 0.26, -1.02, -6.6], [sx*0.55 + 0.26, -0.48, -5.6]);
    }
    // a couple of fuel/ox feed lines running forward from the bay
    for (const sx of [-0.9, 0.9]) {
      B.path([[sx, -0.7, -5.6], [sx, -0.5, -4.6], [sx*0.7, -0.3, -3.8]]);
    }

    // --- RAO BELL NOZZLE seen from behind as a real engine bell: a machined
    // rim ring at the exit, an inconel OUTER wall, a glowing INNER wall that
    // ramps hot->dark from the recessed throat, and an emissive throat disk
    // deep inside the bell (the warm glow you see up the nozzle). Inner and
    // outer walls are separate surfaces with opposite facing so the renderer's
    // eye-facing cull shows the right side from every angle. ---
    function bellNozzle(cx, cy, exitR, throatZ) {
      const SEG = 12;                     // angular resolution
      const STEPS = 5;                    // inner-wall axial rings
      const throatR = exitR * 0.28;       // exit/throat ~3.6:1 diameter
      const len = exitR * 2.5;            // length ~1.25x exit diameter
      const wall = 0.035 + exitR * 0.07;  // bell wall thickness at the lip
      // parabolic radius profile (fast initial flare, gentle near the lip).
      function ringAt(t, grow) {          // t in 0..1 (throat->exit)
        const r = throatR + (exitR - throatR) * Math.sqrt(t) + (grow || 0);
        const z = throatZ - len * t;
        const pts = [];
        for (let k = 0; k < SEG; k++) {
          const a = (k / SEG) * Math.PI * 2;
          pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, z]);
        }
        return pts;
      }
      function lerp3(a, b, t) { return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t]; }
      function bellColor(t) {
        // throat(hot glow) -> mid(dull orange) -> lip(dark cooled metal);
        // fast falloff so the glow is a warm CORE deep in a dark bell rather
        // than the whole mouth reading as an orange ball.
        return t < 0.32 ? lerp3(MAT.throat, MAT.bellMid, t/0.32)
                        : lerp3(MAT.bellMid, MAT.bellLip, (t-0.32)/0.68);
      }
      // (1) emissive throat disk, recessed at the top of the bell, faces aft.
      const throatRing = ringAt(0);
      const throatCentre = [cx, cy, throatZ - 0.02];
      for (let k = 0; k < SEG; k++) {
        const k2 = (k + 1) % SEG;
        triD(throatRing[k], throatRing[k2], throatCentre, [0, 0, -1], MAT.throat);
      }
      // (2) INNER wall: glowing gradient, faces INWARD/AFT (seen up the bell).
      let prev = throatRing;
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS;
        const cur = ringAt(t);
        const cThis = bellColor(t * 0.9);
        for (let k = 0; k < SEG; k++) {
          const k2 = (k + 1) % SEG;
          const am = (k + 0.5) / SEG * Math.PI * 2;
          // want: inward radial + aft, so the glow shows looking up the bell
          quadD(prev[k], cur[k], cur[k2], prev[k2],
                [-Math.cos(am), -Math.sin(am), -0.45], cThis);
        }
        prev = cur;
      }
      const innerLip = prev;
      // (3) OUTER wall: inconel shell, faces OUTWARD (the bell you see from
      // the side). Slightly larger radius, fewer steps (it is a smooth cone).
      const OSTEPS = 3;
      let oprev = ringAt(0, wall * 0.7);
      for (let i = 1; i <= OSTEPS; i++) {
        const t = i / OSTEPS;
        const cur = ringAt(t, wall);
        for (let k = 0; k < SEG; k++) {
          const k2 = (k + 1) % SEG;
          const am = (k + 0.5) / SEG * Math.PI * 2;
          quadD(oprev[k], cur[k], cur[k2], oprev[k2],
                [Math.cos(am), Math.sin(am), 0.3], MAT.nozzleMetal);
        }
        oprev = cur;
      }
      const outerLip = oprev;
      // (4) machined RIM ring: the annulus between inner and outer lips,
      // facing aft — the crisp bright ring that reads "bell" from behind.
      for (let k = 0; k < SEG; k++) {
        const k2 = (k + 1) % SEG;
        quadD(innerLip[k], innerLip[k2], outerLip[k2], outerLip[k],
              [0, 0, -1], MAT.bellRim);
      }
      // bright wireframe rims at throat + exit for trim.
      B.loop(throatRing);
      B.loop(innerLip);
    }
    // 3-engine cluster growing out of the recessed bay: 1 centre + 2 outboard,
    // tightly clustered like SSMEs (centre bell high, outboard pair low).
    bellNozzle( 0.00,  0.10, 0.46, BAY_Z - 0.02); // centre (largest)
    bellNozzle(-0.70, -0.20, 0.36, BAY_Z - 0.06); // port
    bellNozzle( 0.70, -0.20, 0.36, BAY_Z - 0.06); // starboard

    // === RCS THRUSTER QUADS (4 extremities) ==============================
    // Small recessed black-rimmed nozzle clusters where the torque arm is
    // longest: nose top/sides and aft fuselage corners. Each is a shallow
    // square recess (gunmetal floor + black rim) implying a thruster pod.
    function rcsQuad(c, n, sz) {
      // c centre, n outward normal (unit-ish), sz half-size of the recess.
      // build a small inset square facing along n with a darker recessed floor.
      // pick two in-plane axes.
      let up = Math.abs(n[1]) < 0.9 ? [0,1,0] : [1,0,0];
      const ux = [n[1]*up[2]-n[2]*up[1], n[2]*up[0]-n[0]*up[2], n[0]*up[1]-n[1]*up[0]];
      const ul = Math.hypot(ux[0],ux[1],ux[2]) || 1;
      const ax = [ux[0]/ul, ux[1]/ul, ux[2]/ul];
      const ay = [n[1]*ax[2]-n[2]*ax[1], n[2]*ax[0]-n[0]*ax[2], n[0]*ax[1]-n[1]*ax[0]];
      function P(u, v, d) {
        return [c[0]+ax[0]*u+ay[0]*v+n[0]*d, c[1]+ax[1]*u+ay[1]*v+n[1]*d, c[2]+ax[2]*u+ay[2]*v+n[2]*d];
      }
      const o = sz, ir = sz*0.55, dp = -sz*0.6; // outer, inner, recess depth
      const o00=P(-o,-o,0), o10=P(o,-o,0), o11=P(o,o,0), o01=P(-o,o,0);
      const i00=P(-ir,-ir,dp), i10=P(ir,-ir,dp), i11=P(ir,ir,dp), i01=P(-ir,ir,dp);
      // black rim funnel (outer square -> inner recessed square)
      M.quad(o00, o10, i10, i00, MAT.rcsRim);
      M.quad(o10, o11, i11, i10, MAT.rcsRim);
      M.quad(o11, o01, i01, i11, MAT.rcsRim);
      M.quad(o01, o00, i00, i01, MAT.rcsRim);
      // gunmetal recessed floor (the 2x2 thruster face)
      M.quad(i00, i10, i11, i01, MAT.gunmetal);
    }
    // nose: two side-pointing + one up
    rcsQuad([ 0.55, 0.55, 6.6], [ 0.6, 0.5, 0.6], 0.16);
    rcsQuad([-0.55, 0.55, 6.6], [-0.6, 0.5, 0.6], 0.16);
    // aft fuselage corners (down/out)
    rcsQuad([ 1.5, -0.9, -4.8], [ 0.7, -0.4, -0.6], 0.18);
    rcsQuad([-1.5, -0.9, -4.8], [-0.7, -0.4, -0.6], 0.18);

    // === DORSAL SENSOR SPINE + RADIATORS =================================
    // Sensor domes (hemispheres) on the dorsal line and a louvered radiator
    // strip on the lower aft side. Concentrated detail; clean hull elsewhere.
    function dome(cx, cy, cz, r) {
      const RINGS = 3, SEG = 8;
      const apex = [cx, cy + r, cz];
      // latitude rings from just below the apex (phi>0) down to the base.
      function ringAt(i) {
        const phi = (i / RINGS) * (Math.PI / 2);
        const yr = r * Math.cos(phi), rr = r * Math.sin(phi);
        const pts = [];
        for (let k = 0; k < SEG; k++) {
          const a = (k / SEG) * Math.PI * 2;
          pts.push([cx + Math.cos(a)*rr, cy + yr, cz + Math.sin(a)*rr]);
        }
        return pts;
      }
      let prev = ringAt(1);
      // apex cap fan (outward normals away from the dome centre)
      for (let k = 0; k < SEG; k++) {
        const k2 = (k + 1) % SEG;
        M.tri(apex, prev[k], prev[k2], MAT.gunmetal);
      }
      for (let i = 2; i <= RINGS; i++) {
        const cur = ringAt(i);
        for (let k = 0; k < SEG; k++) {
          const k2 = (k + 1) % SEG;
          M.quad(prev[k], cur[k], cur[k2], prev[k2], MAT.gunmetal);
        }
        prev = cur;
      }
    }
    dome(0.0, 1.95, 1.0, 0.22);
    dome(0.0, 1.78, -0.6, 0.18);
    // antenna stub
    B.path([[0.0, 2.17, 1.0], [0.05, 2.7, 0.9]]);
    // radiator louver strip (parallel slats) on the lower aft side panels.
    for (const s of [-1, 1]) {
      for (let i = 0; i < 8; i++) {
        const z = -2.2 - i * 0.32;
        const x0 = s * 1.55, y0 = -0.55, y1 = -0.1;
        M.quad([x0, y0, z], [x0, y1, z], [x0 + s*0.04, y1, z - 0.14], [x0 + s*0.04, y0, z - 0.14], MAT.gunmetal);
        B.seg([x0, y0, z], [x0, y1, z]);
      }
    }

    // === PANEL LINES (crisp wireframe trim over the solid TPS) ============
    // Asymmetric, grouped panel-line clusters following the hull's natural
    // sections: nose ring, cockpit surround, mid-body bay seam, wing-root
    // fairing. Large clean areas are left blank for contrast (80/20 rule).
    function ringLineAt(z, wx, hy) { B.loop(ring(z, wx, hy)); }
    ringLineAt(5.0, 1.30, 1.25);   // cockpit surround seam
    ringLineAt(2.3, 2.05, 1.74);   // forward bay seam
    ringLineAt(-2.4, 1.86, 1.60);  // mid-body / cargo bay seam
    // a few longitudinal stringer panel lines on the upper deck (grouped, asym)
    B.path([[0.5, 1.55, 4.6], [0.5, 1.70, 1.5], [0.5, 1.55, -2.2]]);
    B.path([[-0.7, 1.50, 3.8], [-0.7, 1.62, 0.0]]);
    // belly landing-gear bay door hints (rectangular seams sitting on the
    // belly chine ~ a touch below the lowest profile point near mid-body).
    for (const bay of [[-1.0, -0.1, -1.6, -3.4], [0.2, 1.1, -1.6, -3.4]]) {
      const [x0, x1, z0, z1] = bay;
      const yb = -1.15;
      B.loop([[x0, yb, z0], [x1, yb, z0], [x1, yb, z1], [x0, yb, z1]]);
    }

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

    // === SOLID INTERIOR DETAIL (walkable) =================================
    // Solid floor decks under each room so the avatar stands on a real surface,
    // plus a console bank, a seat, doorway/bulkhead frames, cargo crates and an
    // engine-room readout. Floor grating lines (wireframe) layer on top.
    const DECK = 0.08; // floor slab thickness

    // floor decks (cockpit / corridor / hold).
    M.box([-cpHW, FLOOR - DECK, cpZ0], [cpHW, FLOOR, cpZ1], MAT.floor);
    M.box([-coHW, FLOOR - DECK, coZ0], [coHW, FLOOR, coZ1], MAT.floor);
    M.box([-chHW, FLOOR - DECK, chZ0], [chHW, FLOOR, chZ1], MAT.floor);

    // deck PLATING: alternating plate tones laid just above each deck so the
    // walk view reads as riveted floor plates, not one flat slab.
    function plates(hw, z0, z1, n) {
      for (let s = 0; s < n; s++) {
        const za = z0 + (z1 - z0) * (s / n);
        const zb = z0 + (z1 - z0) * ((s + 1) / n);
        const matP = (s % 2 === 0) ? MAT.floor : MAT.floorDk;
        quadD([-hw, FLOOR + 0.006, za], [hw, FLOOR + 0.006, za],
              [hw, FLOOR + 0.006, zb], [-hw, FLOOR + 0.006, zb],
              [0, 1, 0], matP);
      }
    }
    plates(cpHW - 0.02, cpZ0, cpZ1, 4);
    plates(coHW - 0.02, coZ0, coZ1, 6);
    plates(chHW - 0.02, chZ0, chZ1, 5);

    // ceiling LIGHT STRIPS: thin PAIRED rails either side of the spine (warm
    // emissive, facing down into the cabin). Kept narrow and off-centre so a
    // standing avatar (eye near the ceiling) never gets a blown-white band
    // straight overhead.
    const STRIP_W = 0.045;
    for (const seg of [[coZ0 + 0.3, cpZ0 - 0.3, 0.42],   // corridor rails
                       [chZ0 + 0.4, chZ1 - 0.4, 0.85],   // hold rails
                       [cpZ0 + 0.3, cpZ1 - 0.9, 0.55]]) { // cockpit rails
      for (const sx of [-1, 1]) {
        const x0 = sx * seg[2] - STRIP_W, x1 = sx * seg[2] + STRIP_W;
        quadD([x0, CEIL - 0.02, seg[0]], [x1, CEIL - 0.02, seg[0]],
              [x1, CEIL - 0.02, seg[1]], [x0, CEIL - 0.02, seg[1]],
              [0, -1, 0], MAT.strip);
      }
    }

    // corridor WALL PANELS: warm cabin accents + teal status strips whose
    // normals point INTO the cabin so they render when walked past under the
    // renderer's eye-facing interior culling.
    for (const s of [-1, 1]) {
      const x = s * (coHW - 0.03);
      quadD([x, FLOOR + 0.25, 0.4], [x, FLOOR + 0.25, 2.6],
            [x, FLOOR + 1.05, 2.6], [x, FLOOR + 1.05, 0.4],
            [-s, 0, 0], MAT.cabin);
      quadD([x, FLOOR + 1.15, 0.6], [x, FLOOR + 1.15, 2.4],
            [x, FLOOR + 1.32, 2.4], [x, FLOOR + 1.32, 0.6],
            [-s, 0, 0], MAT.screen);
    }
    // hold WALL PANELS: gunmetal equipment racks + a warm accent per side.
    for (const s of [-1, 1]) {
      const x = s * (chHW - 0.04);
      quadD([x, FLOOR + 0.2, -4.3], [x, FLOOR + 0.2, -1.6],
            [x, FLOOR + 1.5, -1.6], [x, FLOOR + 1.5, -4.3],
            [-s, 0, 0], MAT.bulkhd);
      quadD([x - s * 0.01, FLOOR + 0.55, -3.9], [x - s * 0.01, FLOOR + 0.55, -2.2],
            [x - s * 0.01, FLOOR + 1.0, -2.2], [x - s * 0.01, FLOOR + 1.0, -3.9],
            [-s, 0, 0], MAT.cabin);
    }

    // floor grating lines (accent) running along each deck.
    for (let g = -2; g <= 2; g++) {
      const x = g * 0.4;
      if (Math.abs(x) <= cpHW) B.seg([x, FLOOR + 0.002, cpZ0], [x, FLOOR + 0.002, cpZ1]);
    }
    for (let z = -4; z <= 6; z++) {
      if (z >= chZ0 && z <= cpZ1) {
        const hw = z >= cpZ0 ? cpHW : (z >= coZ0 ? coHW : chHW);
        B.seg([-hw, FLOOR + 0.002, z], [hw, FLOOR + 0.002, z]);
      }
    }

    // --- COCKPIT CONSOLE BANK: a dashboard rising AWAY from the pilot so its
    // angled face (normal up + aft, toward the seat) survives the renderer's
    // eye-facing cull from the pilot's eye, with EMISSIVE TEAL SCREENS inset
    // on the dash. ---
    {
      const z0 = 5.2, z1 = 5.95, hw = 1.05;
      const base = FLOOR;
      const yLo = base + 0.30, yHi = base + 0.95;
      // solid plinth under the dash
      M.box([-hw, base, z0], [hw, yLo, z1], MAT.console);
      // angled dash face: near edge low (by the pilot), far edge high.
      const nl = [-hw, yLo, z0], nr = [hw, yLo, z0];
      const fl = [-hw, yHi, z1], fr = [hw, yHi, z1];
      const wantDash = [0, 0.75, -0.65];  // up + aft, toward the seat
      quadD(nl, nr, fr, fl, wantDash, MAT.console);
      // point on the dash face at cross-pos u, slope 0..1, lifted off by
      // `lift` along the face normal (so screens sit proud, no z-fight).
      function dashP(u, t, lift) {
        return [u,
                yLo + (yHi - yLo) * t + wantDash[1] * lift,
                z0 + (z1 - z0) * t + wantDash[2] * lift];
      }
      // emissive teal screen bank (three displays visible from the seat)
      for (const cx of [-0.62, 0, 0.62]) {
        const w = 0.24;
        quadD(dashP(cx - w, 0.22, 0.02), dashP(cx + w, 0.22, 0.02),
              dashP(cx + w, 0.82, 0.02), dashP(cx - w, 0.82, 0.02),
              wantDash, MAT.screen);
      }
      // glowing accent seams across the dash (running lights)
      for (let k = 0; k <= 3; k++) {
        const t = k / 3;
        B.seg(dashP(-hw + 0.1, t, 0.012), dashP(hw - 0.1, t, 0.012));
      }
      // two side stalk panels angled inward
      M.box([-hw - 0.05, base, z0], [-hw + 0.18, yHi, z0 + 0.5], MAT.console);
      M.box([ hw - 0.18, base, z0], [ hw + 0.05, yHi, z0 + 0.5], MAT.console);
    }

    // --- PILOT SEAT: a proper seat shape (base + cushion + back + headrest). ---
    {
      const sx = 0.32, sz = 4.5, sy = FLOOR;
      M.box([-sx, sy, sz - 0.35], [sx, sy + 0.18, sz + 0.35], MAT.seatMat);          // base
      M.box([-sx, sy + 0.18, sz - 0.05], [sx, sy + 0.30, sz + 0.35], MAT.seatMat);   // cushion
      M.box([-sx, sy + 0.18, sz - 0.40], [sx, sy + 0.95, sz - 0.18], MAT.seatMat);   // backrest
      M.box([-0.22, sy + 0.95, sz - 0.40], [0.22, sy + 1.18, sz - 0.20], MAT.seatMat); // headrest
      // seat frame accent edges
      B.box([-sx, sy + 0.18, sz - 0.40], [sx, sy + 0.95, sz - 0.18]);
    }

    // --- BULKHEAD / DOORWAY FRAMES between rooms (cockpit|corridor|hold). ---
    function doorway(z, hw) {
      const jamb = 0.12, h = CEIL - 0.05;
      // left + right jambs and a lintel as solid posts
      M.box([-hw, FLOOR, z - jamb*0.5], [-hw + jamb, h, z + jamb*0.5], MAT.bulkhd);
      M.box([ hw - jamb, FLOOR, z - jamb*0.5], [ hw, h, z + jamb*0.5], MAT.bulkhd);
      M.box([-hw, h - jamb, z - jamb*0.5], [ hw, h, z + jamb*0.5], MAT.bulkhd);
      // glowing frame outline (accent)
      B.loop([[-hw, FLOOR, z], [hw, FLOOR, z], [hw, h, z], [-hw, h, z]]);
    }
    doorway(cpZ0, coHW);   // cockpit <-> corridor
    doorway(coZ0, coHW);   // corridor <-> hold

    // --- SOLID CARGO CRATES (replace the wireframe-only crates visually). ---
    M.box([-1.4, FLOOR, -4.2], [-0.4, FLOOR + 0.9, -3.2], MAT.crate);
    M.box([ 0.5, FLOOR, -4.0], [ 1.4, FLOOR + 0.7, -3.1], MAT.crate);
    M.box([ 0.4, FLOOR, -2.3], [ 1.3, FLOOR + 1.0, -1.4], MAT.crate);

    // --- ENGINE-ROOM READOUT: a glowing panel on the aft bulkhead. ---
    {
      const z = chZ0 + 0.05, hw = 0.8, y0 = FLOOR + 0.5, y1 = FLOOR + 1.1;
      // panel faces forward (+Z) into the hold
      M.quad([-hw, y0, z], [hw, y0, z], [hw, y1, z], [-hw, y1, z], MAT.readout);
      // scanline accents on the readout
      for (let k = 1; k <= 3; k++) {
        const y = y0 + (y1 - y0) * (k / 4);
        B.seg([-hw + 0.05, y, z + 0.01], [hw - 0.05, y, z + 0.01]);
      }
    }

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

    // Expand per-triangle material colours to a flat RGB-per-triangle array.
    const triColor = Float32Array.from(M.col);

    return {
      lines: Float32Array.from(B.array),
      tris: Float32Array.from(M.pos),     // 9 floats/tri: 3 verts x xyz
      norms: Float32Array.from(M.nrm),    // 9 floats/tri: 3 unit normals
      triColor,                            // 3 floats/tri: material RGB
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
    tris: null,        // Float32Array, 9 floats/tri (3 verts x xyz), SHIP SPACE
    norms: null,       // Float32Array, 9 floats/tri (3 per-vertex unit normals)
    triColor: null,    // Float32Array, 3 floats/tri (per-triangle material RGB)
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
      this.tris = g.tris;
      this.norms = g.norms;
      this.triColor = g.triColor;
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
