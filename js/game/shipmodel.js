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
    // Cool gunmetal greys/blues for the hull, a couple of warm accent panels,
    // and warm amber for the engine area. RGB roughly in the renderer's HDR
    // range (the shader applies Lambert + ambient + rim on top).
    const MAT = {
      hull:    [0.34, 0.40, 0.48],  // gunmetal blue-grey
      hullDk:  [0.22, 0.27, 0.34],  // shadowed panels / belly
      hullLt:  [0.46, 0.53, 0.61],  // upper deck highlight
      accent:  [0.62, 0.34, 0.22],  // warm copper accent panel
      wing:    [0.28, 0.33, 0.40],  // wing skin
      wingEdge:[0.40, 0.45, 0.52],  // wing leading edge
      fin:     [0.30, 0.36, 0.44],  // tail fin
      engine:  [0.42, 0.30, 0.18],  // engine block (warm)
      nozzle:  [1.10, 0.55, 0.16],  // glowing nozzle disk (amber, HDR)
      canopy:  [0.18, 0.28, 0.40],  // dark blue canopy glass
      // interior materials
      floor:   [0.20, 0.23, 0.27],
      console: [0.24, 0.30, 0.38],
      seatMat: [0.30, 0.34, 0.40],
      crate:   [0.38, 0.30, 0.20],
      bulkhd:  [0.26, 0.31, 0.38],
      readout: [0.16, 0.40, 0.46],
    };

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
    for (let i = 0; i < rings.length - 1; i++) {
      const a = rings[i], b = rings[i + 1];
      const an = ringVN[i], bn = ringVN[i + 1];
      const mat = (rings[i][0][2] < -3) ? MAT.hullDk : MAT.hull;
      for (let k = 0; k < a.length; k++) {
        const k2 = (k + 1) % a.length;
        // quad a[k] -> a[k2] -> b[k2] -> b[k], wound CCW from outside (nose
        // ring index i is the more +Z / forward ring).
        M.striz(a[k2], an[k2], a[k], an[k], b[k], bn[k], mat);
        M.striz(a[k2], an[k2], b[k], bn[k], b[k2], bn[k2], mat);
      }
    }
    // accent panel: a warm copper band on the top-front facet (upper deck).
    {
      const a = rings[1], b = rings[2];
      const an = ringVN[1], bn = ringVN[2];
      // facet between top-right(1) and top-left(2)
      M.striz(a[2], an[2], a[1], an[1], b[1], bn[1], MAT.accent);
      M.striz(a[2], an[2], b[1], bn[1], b[2], bn[2], MAT.accent);
    }

    // === SOLID NOSE CONE =================================================
    // Triangle fan from the forward ring (rings[0]) to the sharp tip.
    {
      const r = rings[0], rn = ringVN[0];
      // tip normal points forward (+Z) and slightly up to match the spike.
      const tn = [0, 0.18, 1];
      for (let k = 0; k < r.length; k++) {
        const k2 = (k + 1) % r.length;
        // wound so outward normal faces away from the axis (CCW from outside)
        M.striz(r[k], rn[k], r[k2], rn[k2], tip, tn, MAT.hullLt);
      }
    }

    // === CANOPY GLASS ===================================================
    // A dark blue faceted canopy over the cockpit shoulders for a real cockpit.
    {
      const zf = 6.0, zb = 3.4, hw = 0.95, hy = 1.05;
      const fl = [-hw, 0.35, zf], fr = [hw, 0.35, zf];
      const bl = [-hw, 0.45, zb], br = [hw, 0.45, zb];
      const tf = [0, hy + 0.15, zf - 0.4], tb = [0, hy + 0.35, zb + 0.2];
      M.tri(fl, fr, tf, MAT.canopy);          // front pane
      M.quad(fr, br, tb, tf, MAT.canopy);     // right pane
      M.quad(bl, fl, tf, tb, MAT.canopy);     // left pane
      M.tri(bl, br, tb, MAT.canopy);          // back pane
    }

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

      // --- SOLID WING: a thin slab (top + bottom + leading/trailing edges). ---
      const TH = 0.16; // half-thickness of the wing slab
      // top surface verts (lifted +Y), bottom (-Y).
      const rf_t = [root_f[0], root_f[1] + TH, root_f[2]];
      const rb_t = [root_b[0], root_b[1] + TH, root_b[2]];
      const tf_t = [tip_f[0],  tip_f[1]  + TH, tip_f[2]];
      const tb_t = [tip_b[0],  tip_b[1]  + TH, tip_b[2]];
      const rf_b = [root_f[0], root_f[1] - TH, root_f[2]];
      const rb_b = [root_b[0], root_b[1] - TH, root_b[2]];
      const tf_b = [tip_f[0],  tip_f[1]  - TH, tip_f[2]];
      const tb_b = [tip_b[0],  tip_b[1]  - TH, tip_b[2]];
      if (s > 0) {
        M.quad(rf_t, tf_t, tb_t, rb_t, MAT.wing);   // top (CCW from +Y)
        M.quad(rf_b, rb_b, tb_b, tf_b, MAT.wing);   // bottom
        M.quad(rf_b, tf_b, tf_t, rf_t, MAT.wingEdge); // leading edge
        M.quad(rb_t, tb_t, tb_b, rb_b, MAT.wingEdge); // trailing edge
        M.quad(tf_t, tf_b, tb_b, tb_t, MAT.wingEdge); // wingtip
      } else {
        M.quad(rb_t, tb_t, tf_t, rf_t, MAT.wing);   // top (mirror winding)
        M.quad(rb_b, rf_b, tf_b, tb_b, MAT.wing);   // bottom
        M.quad(rf_t, tf_t, tf_b, rf_b, MAT.wingEdge); // leading edge
        M.quad(rb_b, tb_b, tb_t, rb_t, MAT.wingEdge); // trailing edge
        M.quad(tb_t, tb_b, tf_b, tf_t, MAT.wingEdge); // wingtip
      }
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

    // === ENGINE BLOCK (-Z) ================================================
    // A boxy thruster cluster at the stern with twin nozzle rings.
    B.box([-1.7, -1.2, TAIL], [1.7, 1.2, -5.4]);
    // --- SOLID ENGINE BLOCK (warm). ---
    M.box([-1.7, -1.2, TAIL], [1.7, 1.2, -5.4], MAT.engine);

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

      // --- SOLID GLOWING NOZZLE: cone from the outer ring to a recessed,
      // brightly lit inner disk so the thruster reads as a glowing mouth. ---
      const centre = [cx, cy, z + 0.55];
      const nBack = [0, 0, -1]; // faces aft (-Z)
      for (let k = 0; k < 8; k++) {
        const a = pts[k], b = pts[(k + 1) % 8];
        const ia = inner[k], ib = inner[(k + 1) % 8];
        // cowl wall (outer ring -> inner ring), warm engine material
        M.quad(b, a, ia, ib, MAT.engine);
        // glowing inner disk fan toward the recessed centre
        M.tri(ib, ia, centre, MAT.nozzle);
      }
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

    // === SOLID INTERIOR DETAIL (walkable) =================================
    // Solid floor decks under each room so the avatar stands on a real surface,
    // plus a console bank, a seat, doorway/bulkhead frames, cargo crates and an
    // engine-room readout. Floor grating lines (wireframe) layer on top.
    const DECK = 0.08; // floor slab thickness

    // floor decks (cockpit / corridor / hold).
    M.box([-cpHW, FLOOR - DECK, cpZ0], [cpHW, FLOOR, cpZ1], MAT.floor);
    M.box([-coHW, FLOOR - DECK, coZ0], [coHW, FLOOR, coZ1], MAT.floor);
    M.box([-chHW, FLOOR - DECK, chZ0], [chHW, FLOOR, chZ1], MAT.floor);

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

    // --- COCKPIT CONSOLE BANK: an angled panel sweep in front of the seat. ---
    {
      const z0 = 5.2, z1 = 6.0, hw = 1.05;
      const base = FLOOR;
      const top = FLOOR + 0.85;
      // angled top panel (tilts back toward the pilot, faces up+aft)
      const fl = [-hw, base + 0.35, z1], fr = [hw, base + 0.35, z1];
      const bl = [-hw, top, z0],         br = [hw, top, z0];
      M.box([-hw, base, z1 - 0.12], [hw, base + 0.4, z1], MAT.console); // lower lip
      M.quad(fl, fr, br, bl, MAT.console);               // angled face
      // glowing accent seams across the console face (running lights)
      for (let k = 0; k <= 3; k++) {
        const t = k / 3;
        const lx = -hw + 0.1, rx = hw - 0.1;
        const ay = base + 0.35 + (top - (base + 0.35)) * t;
        const az = z1 + (z0 - z1) * t;
        B.seg([lx, ay + 0.01, az], [rx, ay + 0.01, az]);
      }
      // two side stalk panels angled inward
      M.box([-hw - 0.05, base, z0], [-hw + 0.18, top, z0 + 0.5], MAT.console);
      M.box([ hw - 0.18, base, z0], [ hw + 0.05, top, z0 + 0.5], MAT.console);
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
