'use strict';
/* ============================================================
   FABLE: DRIFTER — PLANET-SURFACE TERRAIN GENERATOR
   (js/game/surface.js -> globalThis.Surface). DOM-free; attaches
   via globalThis only and loads in Node via indirect-eval (the
   same pattern as js/game/shipmodel.js / test/smoke.js).

   AGENT A — TERRAIN. Produces the Surface descriptor consumed by
   the renderer surface path, the flight model (Ship.surface*),
   and the orchestrator.

   SURFACE SPACE (the shared contract):
     +Y is UP (opposite gravity). The terrain is centred at
     x=z=0 and spans a square of half-width EXTENT. Ground height
     varies with y. The ship/avatar move in X/Z and fall in -Y.
     The scene is rendered with a normal perspective camera in
     this same frame.

   Surface.generate({ archetype, seed, radius, colorIdx }) ->
     {
       archetype, extent,
       mesh: { tris, norms, triColor },  // SURFACE SPACE
       markers: [ { x,y,z, colorIdx, size } ],
       sky: { horizon, zenith, fog, fogDensity, sun, sunColor, ambient },
       spawn: { pos:[x,y,z], yaw },
       heightAt(x,z) -> number
     }

   DETERMINISM. mulberry32 (the repo RNG) + value-noise/fbm built
   from the seed. No Math.random anywhere — same seed yields the
   byte-for-byte identical mesh, markers and sky.

   GRID. The terrain is a GRID x GRID cell heightfield over the
   EXTENT square (so (GRID+1) x (GRID+1) vertices). Each cell is two
   triangles with face normals from the cross product. heightAt(x,z)
   evaluates the SAME analytic noise field the vertices were built
   from (no bilinear lookup table needed) so collision exactly
   matches the visible ground — see field() below.
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

  // ---- FNV-1a string hash (matches cosmos.js) so a string seed/archetype
  // can be folded into the numeric seed deterministically. ----
  function hashStringToU32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // ---------------------------------------------------------------------------
  // VALUE NOISE. A seeded hash over integer lattice points -> [0,1), smoothed
  // with a quintic fade and bilinearly interpolated. Deterministic for a given
  // seed; identical whether sampled at a vertex or via heightAt(). fbm() layers
  // several octaves. We hash with the seed mixed in so two surfaces with
  // different seeds get genuinely different fields.
  // ---------------------------------------------------------------------------
  function makeNoise(seed) {
    const S = seed >>> 0;
    // hash a 2D integer lattice point -> [0,1)
    function hash2(ix, iz) {
      let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ S) >>> 0;
      h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h >>>= 0;
      h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h >>>= 0;
      h ^= h >>> 15;
      return (h >>> 0) / 4294967296;
    }
    function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
    // value noise at continuous (x,z)
    function vnoise(x, z) {
      const x0 = Math.floor(x), z0 = Math.floor(z);
      const fx = x - x0, fz = z - z0;
      const ux = fade(fx), uz = fade(fz);
      const v00 = hash2(x0,     z0);
      const v10 = hash2(x0 + 1, z0);
      const v01 = hash2(x0,     z0 + 1);
      const v11 = hash2(x0 + 1, z0 + 1);
      const a = v00 + (v10 - v00) * ux;
      const b = v01 + (v11 - v01) * ux;
      return a + (b - a) * uz; // [0,1)
    }
    // fractional Brownian motion: octaves of value noise, returns ~[0,1)
    function fbm(x, z, octaves, lacunarity, gain) {
      let amp = 1, freq = 1, sum = 0, norm = 0;
      for (let o = 0; o < octaves; o++) {
        sum += amp * vnoise(x * freq, z * freq);
        norm += amp;
        amp *= gain;
        freq *= lacunarity;
      }
      return sum / (norm || 1); // ~[0,1)
    }
    return { vnoise, fbm };
  }

  // ---------------------------------------------------------------------------
  // ARCHETYPE TABLE. Each archetype defines a height shaping function over the
  // normalized fbm field, base/peak colours, sky, and marker palette index.
  // height(field01, x, z, noise) returns a world-Y in SURFACE SPACE.
  // The marker palette index references the renderer's 0..17 sprite palette.
  // ---------------------------------------------------------------------------
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function mix3(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  const ARCHETYPES = {
    rocky: {
      amp: 220, ridged: true,
      lowCol:  [0.30, 0.27, 0.24], // brown rock
      highCol: [0.52, 0.50, 0.47], // pale grey ridge
      slopeCol:[0.20, 0.18, 0.16], // dark cliff
      snow: null,
      sky: { horizon: [0.55, 0.50, 0.45], zenith: [0.22, 0.28, 0.40], fog: [0.50, 0.46, 0.42],
             fogDensity: 0.00065, sun: [0.4, 0.7, 0.5], sunColor: [1.0, 0.92, 0.78], ambient: 0.34 },
      markerIdx: 6, markerCount: 7, markerSize: 8,
    },
    lava: {
      amp: 260, ridged: true, lava: true,
      lowCol:  [0.10, 0.07, 0.06], // dark crust
      highCol: [0.20, 0.13, 0.10], // basalt
      slopeCol:[0.06, 0.04, 0.03], // black cliff
      crackCol:[2.4, 0.7, 0.12],   // glowing hot crack (emissive >1)
      sky: { horizon: [0.45, 0.12, 0.06], zenith: [0.10, 0.04, 0.05], fog: [0.30, 0.08, 0.05],
             fogDensity: 0.0011, sun: [0.3, 0.5, 0.6], sunColor: [1.0, 0.45, 0.25], ambient: 0.22 },
      markerIdx: 2, markerCount: 9, markerSize: 7,
    },
    ice: {
      amp: 90, ridged: false, snow: [0.92, 0.96, 1.0],
      lowCol:  [0.70, 0.82, 0.92], // pale blue
      highCol: [0.92, 0.96, 1.00], // white cap
      slopeCol:[0.55, 0.68, 0.82], // blue ice cliff
      sky: { horizon: [0.78, 0.88, 0.95], zenith: [0.40, 0.62, 0.82], fog: [0.80, 0.88, 0.94],
             fogDensity: 0.0009, sun: [0.2, 0.8, 0.4], sunColor: [0.95, 0.97, 1.0], ambient: 0.45 },
      markerIdx: 0, markerCount: 8, markerSize: 9,
    },
    desert: {
      amp: 130, ridged: false, dunes: true,
      lowCol:  [0.62, 0.48, 0.30], // warm tan
      highCol: [0.82, 0.68, 0.44], // bright sand crest
      slopeCol:[0.50, 0.36, 0.22], // shaded dune
      sky: { horizon: [0.88, 0.74, 0.52], zenith: [0.42, 0.55, 0.72], fog: [0.85, 0.74, 0.56],
             fogDensity: 0.0008, sun: [0.5, 0.6, 0.4], sunColor: [1.0, 0.90, 0.70], ambient: 0.40 },
      markerIdx: 8, markerCount: 6, markerSize: 10,
    },
    ocean: {
      amp: 40, ridged: false, water: true, waterLevel: 6,
      lowCol:  [0.12, 0.30, 0.42], // sea floor / shallows
      highCol: [0.45, 0.55, 0.42], // island green
      slopeCol:[0.30, 0.36, 0.30], // shore rock
      waterCol:[0.10, 0.34, 0.50], // bluish water plane
      sky: { horizon: [0.55, 0.72, 0.82], zenith: [0.20, 0.42, 0.68], fog: [0.55, 0.72, 0.82],
             fogDensity: 0.0007, sun: [0.3, 0.7, 0.5], sunColor: [1.0, 0.95, 0.85], ambient: 0.42 },
      markerIdx: 4, markerCount: 5, markerSize: 9,
    },
    gas: {
      amp: 70, ridged: false, gas: true,
      lowCol:  [0.55, 0.52, 0.62], // pale band
      highCol: [0.80, 0.74, 0.82], // light band
      slopeCol:[0.62, 0.56, 0.68], // mid band
      sky: { horizon: [0.78, 0.70, 0.80], zenith: [0.50, 0.46, 0.66], fog: [0.74, 0.68, 0.80],
             fogDensity: 0.0014, sun: [0.2, 0.6, 0.5], sunColor: [1.0, 0.92, 0.95], ambient: 0.50 },
      markerIdx: 12, markerCount: 4, markerSize: 11,
    },
    barren: {
      amp: 110, ridged: false, crater: true,
      lowCol:  [0.30, 0.30, 0.32], // grey regolith
      highCol: [0.52, 0.52, 0.54], // pale grey
      slopeCol:[0.20, 0.20, 0.22], // crater wall shadow
      sky: { horizon: [0.30, 0.30, 0.34], zenith: [0.04, 0.04, 0.07], fog: [0.20, 0.20, 0.24],
             fogDensity: 0.0006, sun: [0.4, 0.7, 0.5], sunColor: [1.0, 0.98, 0.92], ambient: 0.28 },
      markerIdx: 1, markerCount: 5, markerSize: 8,
    },
  };

  function normalizeArchetype(a) {
    if (typeof a === 'string' && ARCHETYPES[a]) return a;
    return 'rocky';
  }

  function unit3(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  // ---------------------------------------------------------------------------
  // generate() — build the full Surface descriptor.
  // ---------------------------------------------------------------------------
  function generate(opts) {
    opts = opts || {};
    const archetype = normalizeArchetype(opts.archetype);
    const def = ARCHETYPES[archetype];

    // seed: fold numeric seed + archetype + colorIdx into one u32 so different
    // worlds diverge and the same inputs reproduce exactly.
    let seed = (opts.seed === undefined || opts.seed === null) ? 0 : opts.seed;
    if (typeof seed === 'string') seed = hashStringToU32(seed);
    seed = (seed >>> 0) ^ hashStringToU32('surf:' + archetype) ^ ((opts.colorIdx | 0) * 0x9e3779b1);
    seed >>>= 0;

    const rng = makeRng(seed || 0xA11CE);
    const noise = makeNoise(seed);

    // EXTENT: half-width of the playable square. Scale gently with the planet
    // radius if provided, clamped to a sane band (~900..1500).
    const radius = (opts.radius && isFinite(opts.radius)) ? opts.radius : 1;
    let extent = 1200;
    if (opts.radius && isFinite(opts.radius)) {
      extent = Math.max(900, Math.min(1500, 1100 + radius * 8));
    }

    // grid resolution: cells across the EXTENT square. 80 => 6400 cells =>
    // 12800 tris, well within budget.
    const GRID = 80;
    const cell = (extent * 2) / GRID; // world units per cell

    // noise frequency: how many feature wavelengths fit across the terrain.
    // Larger => smaller features. Keep modest so terrain reads as landscape.
    const FEATURES = 4.0;           // base wavelengths across full extent
    const nFreq = FEATURES / (extent * 2);

    // ---- the shared height field. heightAt() calls this exact function so
    // collision matches the rendered vertices. ----
    function field(x, z) {
      // base fbm in [0,1)
      let f = noise.fbm(x * nFreq, z * nFreq, 5, 2.0, 0.5);
      if (def.ridged) {
        // ridged: fold the field to make sharp crests/valleys
        f = 1 - Math.abs(f * 2 - 1);
        f = f * f; // sharpen
      } else if (def.dunes) {
        // dunes: wavy ridges in one direction layered on fbm
        const w = 0.5 + 0.5 * Math.sin((x * nFreq) * Math.PI * 3.0 + f * 2.0);
        f = 0.6 * f + 0.4 * w;
      } else if (def.crater) {
        // craters: subtract circular dimples from a smooth base (handled below
        // via craterField); base here is gentle.
        f = 0.4 + 0.6 * f;
      }
      let y = (f - 0.5) * 2 * def.amp; // centre around 0, +/- amp

      if (def.crater) y += craterDepth(x, z);
      if (def.gas) {
        // gas: soft banded cloud deck — gentle sinusoidal bands in Z
        const band = Math.sin(z * nFreq * Math.PI * 4.0) * 18;
        y = (f - 0.5) * 2 * def.amp * 0.5 + band;
      }
      if (def.water) {
        // ocean: clamp the low terrain so most of it sits below water level;
        // islands poke above. waterLevel applied at render as flat plane.
        y = y * 0.6;
      }
      return y;
    }

    // ---- craters (barren): a deterministic set of circular depressions with
    // raised rims. Precompute centres so field() is cheap & stable. ----
    const craters = [];
    if (def.crater) {
      const nC = 14;
      for (let i = 0; i < nC; i++) {
        craters.push({
          cx: (rng() * 2 - 1) * extent * 0.85,
          cz: (rng() * 2 - 1) * extent * 0.85,
          r:  40 + rng() * 130,
          d:  25 + rng() * 60,
        });
      }
    }
    function craterDepth(x, z) {
      let acc = 0;
      for (let i = 0; i < craters.length; i++) {
        const c = craters[i];
        const dx = x - c.cx, dz = z - c.cz;
        const dist = Math.hypot(dx, dz);
        if (dist < c.r * 1.4) {
          const t = dist / c.r;
          if (t < 1) {
            // bowl: deeper toward centre, with a slight rim lift near edge
            acc += -c.d * (1 - t * t) + c.d * 0.25 * Math.max(0, 1 - Math.abs(t - 0.9) * 8);
          } else {
            // rim just outside
            acc += c.d * 0.25 * Math.max(0, 1 - (t - 1) * 4);
          }
        }
      }
      return acc;
    }

    // ---- build the heightfield vertex grid ----
    const N = GRID + 1;
    const heights = new Float32Array(N * N);
    for (let iz = 0; iz < N; iz++) {
      const z = -extent + iz * cell;
      for (let ix = 0; ix < N; ix++) {
        const x = -extent + ix * cell;
        heights[iz * N + ix] = field(x, z);
      }
    }
    function vx(ix) { return -extent + ix * cell; }
    function vz(iz) { return -extent + iz * cell; }
    function vy(ix, iz) { return heights[iz * N + ix]; }

    // ---- triangulate into the mesh arrays ----
    const nCells = GRID * GRID;
    const nTris = nCells * 2;
    const tris = new Float32Array(nTris * 9);
    const norms = new Float32Array(nTris * 9);
    const triColor = new Float32Array(nTris * 3);

    // colour for a triangle based on archetype + height + slope (steepness).
    function pickColor(midY, normalY, x, z, slopeFrac) {
      // height fraction normalized to [-1,1]-ish band
      const hf = clamp01((midY / def.amp) * 0.5 + 0.5);
      let col;
      if (def.water && midY < (def.waterLevel || 0)) {
        col = mix3(def.lowCol, def.waterCol, 0.5);
      } else {
        col = mix3(def.lowCol, def.highCol, hf);
      }
      // slope: steep faces use the cliff/slope colour
      col = mix3(col, def.slopeCol, clamp01(slopeFrac));
      // snow cap on high, flat-ish areas (ice + occasionally rocky highs)
      if (def.snow && hf > 0.62 && normalY > 0.78) {
        col = mix3(col, def.snow, clamp01((hf - 0.62) * 3));
      }
      // lava glowing cracks: low valley cells get an emissive hot colour
      if (def.lava && hf < 0.22) {
        const glow = clamp01((0.22 - hf) * 5);
        col = mix3(col, def.crackCol, glow);
      }
      return col;
    }

    let t = 0; // triangle index
    const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
    function emit(ax, az, bx, bz, cx, cz) {
      A[0] = vx(ax); A[1] = vy(ax, az); A[2] = vz(az);
      B[0] = vx(bx); B[1] = vy(bx, bz); B[2] = vz(bz);
      C[0] = vx(cx); C[1] = vy(cx, cz); C[2] = vz(cz);
      // face normal = (B-A) x (C-A), then make it point up-ish (+Y).
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
      const wx = C[0] - A[0], wy = C[1] - A[1], wz = C[2] - A[2];
      let nx = uy * wz - uz * wy;
      let ny = uz * wx - ux * wz;
      let nz = ux * wy - uy * wx;
      let l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; } // outward / up-ish
      const o = t * 9;
      tris[o]     = A[0]; tris[o + 1] = A[1]; tris[o + 2] = A[2];
      tris[o + 3] = B[0]; tris[o + 4] = B[1]; tris[o + 5] = B[2];
      tris[o + 6] = C[0]; tris[o + 7] = C[1]; tris[o + 8] = C[2];
      norms[o]     = nx; norms[o + 1] = ny; norms[o + 2] = nz;
      norms[o + 3] = nx; norms[o + 4] = ny; norms[o + 5] = nz;
      norms[o + 6] = nx; norms[o + 7] = ny; norms[o + 8] = nz;
      const midY = (A[1] + B[1] + C[1]) / 3;
      const midX = (A[0] + B[0] + C[0]) / 3;
      const midZ = (A[2] + B[2] + C[2]) / 3;
      const slopeFrac = clamp01((1 - ny) * 2.2); // 0 flat -> 1 steep
      const col = pickColor(midY, ny, midX, midZ, slopeFrac);
      const co = t * 3;
      triColor[co] = col[0]; triColor[co + 1] = col[1]; triColor[co + 2] = col[2];
      t++;
    }

    for (let iz = 0; iz < GRID; iz++) {
      for (let ix = 0; ix < GRID; ix++) {
        // cell corners: (ix,iz) (ix+1,iz) (ix+1,iz+1) (ix,iz+1)
        // two triangles wound CCW when viewed from +Y (above).
        emit(ix, iz, ix, iz + 1, ix + 1, iz + 1);
        emit(ix, iz, ix + 1, iz + 1, ix + 1, iz);
      }
    }

    // ---- heightAt(x,z): the collision query. Sample the SAME field, with an
    // ocean water-level floor. Bilinear over the grid where x,z fall inside the
    // built grid so it matches mesh vertices exactly at lattice points; outside
    // the extent we evaluate the field directly (finite everywhere). ----
    function heightAt(x, z) {
      let y;
      // inside the built grid? bilinear over stored vertex heights so the
      // collision surface is exactly the rendered triangles.
      if (x >= -extent && x <= extent && z >= -extent && z <= extent) {
        const gx = (x + extent) / cell;
        const gz = (z + extent) / cell;
        let ix = Math.floor(gx), iz = Math.floor(gz);
        if (ix >= GRID) ix = GRID - 1;
        if (iz >= GRID) iz = GRID - 1;
        if (ix < 0) ix = 0; if (iz < 0) iz = 0;
        const fx = gx - ix, fz = gz - iz;
        const h00 = heights[iz * N + ix];
        const h10 = heights[iz * N + (ix + 1)];
        const h01 = heights[(iz + 1) * N + ix];
        const h11 = heights[(iz + 1) * N + (ix + 1)];
        const a = h00 + (h10 - h00) * fx;
        const b = h01 + (h11 - h01) * fx;
        y = a + (b - a) * fz;
      } else {
        y = field(x, z);
      }
      if (!isFinite(y)) y = 0;
      if (def.water && y < (def.waterLevel || 0)) y = def.waterLevel || 0;
      return y;
    }

    // ---- markers: scatter archetype-appropriate props at terrain height. ----
    const markers = [];
    {
      const n = def.markerCount;
      for (let i = 0; i < n; i++) {
        const x = (rng() * 2 - 1) * extent * 0.8;
        const z = (rng() * 2 - 1) * extent * 0.8;
        const y = heightAt(x, z) + 4 + rng() * 6;
        markers.push({
          x, y, z,
          colorIdx: def.markerIdx & 0xff,
          size: def.markerSize * (0.7 + rng() * 0.8),
        });
      }
    }

    // ---- sky: per-archetype, with a unit sun direction. ----
    const sun = unit3(def.sky.sun);
    const sky = {
      horizon: def.sky.horizon.slice(),
      zenith:  def.sky.zenith.slice(),
      fog:     def.sky.fog.slice(),
      fogDensity: def.sky.fogDensity,
      sun,
      sunColor: def.sky.sunColor.slice(),
      ambient: def.sky.ambient,
    };

    // ---- spawn: comfortably above the centre, looking forward (yaw 0). ----
    const centreH = heightAt(0, 0);
    const spawn = {
      pos: [0, centreH + 180, 0],
      yaw: 0,
    };

    return {
      archetype,
      extent,
      mesh: { tris, norms, triColor },
      markers,
      sky,
      spawn,
      heightAt,
    };
  }

  const Surface = {
    archetypes: Object.keys(ARCHETYPES),
    generate,
  };

  globalThis.Surface = Surface;
})();
