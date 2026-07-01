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

  // ===========================================================================
  // v13 LIVING WORLDS — biome / flora / rock / outpost helpers. All DOM-free,
  // all deterministic from the seed (no Math.random). The flora & structures
  // are baked as flat-shaded vertex-coloured triangles into ONE propMesh buffer
  // (same 9-float layout as the terrain mesh) so the renderer draws them with
  // the terrain shader in a single pass. Emissive channels (>1) are allowed for
  // bioluminescent flora and outpost lights.
  // ===========================================================================

  // Gielis superformula radius for angle phi (the cheap "alien silhouette" eqn
  // NMS uses). Sweep phi 0..2PI for a closed organic profile.
  function superRadius(phi, m, n1, n2, n3) {
    const t1 = Math.pow(Math.abs(Math.cos(m * phi / 4)), n2);
    const t2 = Math.pow(Math.abs(Math.sin(m * phi / 4)), n3);
    let r = Math.pow(t1 + t2, -1 / n1);
    if (!isFinite(r)) r = 0;
    return r;
  }

  // Deterministic per-cell hash -> [0,1). Stable for (i,j,salt+seed).
  function hash2i(i, j, s) {
    let h = (Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ (s | 0)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // A tiny triangle-soup builder: accumulates verts/normals/colors then bakes a
  // single {tris,norms,triColor} on demand. Triangles are pushed in SURFACE
  // SPACE with face normals computed from the winding (forced up/out-ish only
  // when flagged for ground props).
  function makeSoup() {
    const T = [], NM = [], C = [];
    function pushTri(ax, ay, az, bx, by, bz, cx, cy, cz, col) {
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const wx = cx - ax, wy = cy - ay, wz = cz - az;
      let nx = uy * wz - uz * wy;
      let ny = uz * wx - ux * wz;
      let nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      T.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      NM.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
      C.push(col[0], col[1], col[2]);
    }
    // a quad (a,b,c,d) -> two tris, both sharing the quad's vertex colour.
    function pushQuad(a, b, c, d, col) {
      pushTri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], col);
      pushTri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], col);
    }
    return {
      pushTri, pushQuad,
      get triCount() { return C.length; },
      bake() {
        return {
          tris: Float32Array.from(T),
          norms: Float32Array.from(NM),
          triColor: Float32Array.from(C),
        };
      },
    };
  }

  // A vertical n-gon prism/cylinder/cone from (cx,baseY,cz) up by `h`, bottom
  // radius r0, top radius r1 (0 => cone), `sides` faces, rotated by rot, with an
  // optional lean (radians toward +x). Colour `col` for sides, `capCol` (or col)
  // for the top cap. Triangles pushed into the soup.
  function bakeCyl(S, cx, baseY, cz, h, r0, r1, sides, rot, lean, col, capCol) {
    capCol = capCol || col;
    const leanX = Math.sin(lean) * h, ringTopY = baseY + Math.cos(lean) * h;
    const ring0 = [], ring1 = [];
    for (let s = 0; s < sides; s++) {
      const a = rot + (s / sides) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      ring0.push([cx + ca * r0, baseY, cz + sa * r0]);
      ring1.push([cx + ca * r1 + leanX, ringTopY, cz + sa * r1]);
    }
    for (let s = 0; s < sides; s++) {
      const n = (s + 1) % sides;
      if (r1 > 1e-4) {
        S.pushQuad(ring0[s], ring1[s], ring1[n], ring0[n], col);
      } else {
        const tip = [cx + leanX, ringTopY, cz];
        S.pushTri(ring0[s][0], ring0[s][1], ring0[s][2], tip[0], tip[1], tip[2], ring0[n][0], ring0[n][1], ring0[n][2], col);
      }
    }
    // top cap fan (only if it has area)
    if (r1 > 1e-4) {
      const cTop = [cx + leanX, ringTopY, cz];
      for (let s = 0; s < sides; s++) {
        const n = (s + 1) % sides;
        S.pushTri(cTop[0], cTop[1], cTop[2], ring1[s][0], ring1[s][1], ring1[s][2], ring1[n][0], ring1[n][1], ring1[n][2], capCol);
      }
    }
  }

  // An axis-aligned box centred at (cx,cy,cz) with half-extents (hx,hy,hz),
  // colour col. Optionally `litFaces` (array of 6 bools, +x -x +y -y +z -z) swap
  // to `litCol` for emissive accents.
  function bakeBox(S, cx, cy, cz, hx, hy, hz, col, litCol, litFaces) {
    const x0 = cx - hx, x1 = cx + hx, y0 = cy - hy, y1 = cy + hy, z0 = cz - hz, z1 = cz + hz;
    const v = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    const faces = [
      [1, 5, 6, 2], // +x
      [4, 0, 3, 7], // -x
      [3, 2, 6, 7], // +y
      [4, 5, 1, 0], // -y
      [5, 4, 7, 6], // +z
      [0, 1, 2, 3], // -z
    ];
    for (let f = 0; f < 6; f++) {
      const c = (litFaces && litFaces[f]) ? litCol : col;
      const fc = faces[f];
      S.pushQuad(v[fc[0]], v[fc[1]], v[fc[2]], v[fc[3]], c);
    }
  }

  // A faceted boulder: a low icosa-ish blob approximated by a jittered n-gon
  // bipyramid. Cheap (~2*sides tris) and reads as faceted basalt when flat-shaded.
  function bakeRock(S, cx, baseY, cz, r, h, sides, hashFn, col) {
    const ring = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const jr = r * (0.7 + 0.6 * hashFn(s, 0));
      const jy = baseY + h * 0.4 * (0.4 + 0.6 * hashFn(s, 1));
      ring.push([cx + Math.cos(a) * jr, jy, cz + Math.sin(a) * jr]);
    }
    const top = [cx + (hashFn(99, 2) - 0.5) * r * 0.4, baseY + h * (0.8 + 0.4 * hashFn(99, 3)), cz + (hashFn(99, 4) - 0.5) * r * 0.4];
    const bot = [cx, baseY - h * 0.15, cz];
    for (let s = 0; s < sides; s++) {
      const n = (s + 1) % sides;
      S.pushTri(ring[s][0], ring[s][1], ring[s][2], top[0], top[1], top[2], ring[n][0], ring[n][1], ring[n][2], col);
      S.pushTri(ring[s][0], ring[s][1], ring[s][2], ring[n][0], ring[n][1], ring[n][2], bot[0], bot[1], bot[2], col);
    }
  }

  // ---- biome palettes (sRGB-ish 0..1; ground/rock/flora/accent). Accent may be
  // emissive for bioluminescent / toxic biomes. Anchored to real-planet colours.
  function rgb(r, g, b) { return [r / 255, g / 255, b / 255]; }
  const BIOMES = {
    verdant:  { ground: rgb(78, 102, 54),  rock: rgb(96, 92, 84),   flora: rgb(60, 140, 70),  accent: rgb(180, 220, 120), kind: 'tree',    emis: 0.0 },
    desert:   { ground: rgb(178, 126, 72), rock: rgb(150, 96, 58),  flora: rgb(150, 120, 60), accent: rgb(220, 180, 90),  kind: 'crystal', emis: 0.0 },
    crimson:  { ground: rgb(120, 40, 48),  rock: rgb(80, 30, 40),   flora: rgb(200, 40, 70),  accent: rgb(255, 90, 120),  kind: 'frond',   emis: 0.6 },
    toxic:    { ground: rgb(40, 90, 84),   rock: rgb(34, 60, 62),   flora: rgb(40, 200, 170), accent: rgb(120, 255, 210), kind: 'crystal', emis: 1.6 },
    ice:      { ground: rgb(210, 224, 235),rock: rgb(150, 165, 180),flora: rgb(150, 195, 220),accent: rgb(200, 240, 255), kind: 'crystal', emis: 0.2 },
    barren:   { ground: rgb(120, 118, 114),rock: rgb(88, 86, 84),   flora: rgb(100, 100, 96), accent: rgb(160, 160, 158), kind: 'rock',    emis: 0.0 },
    volcanic: { ground: rgb(58, 56, 60),   rock: rgb(40, 40, 46),   flora: rgb(90, 80, 90),   accent: rgb(255, 110, 40),  kind: 'crystal', emis: 1.8 },
  };

  // archetype -> dominant biome key + flora base density + weather + atmosphere.
  // Kept aligned to the existing ARCHETYPES look so worlds still read the same.
  const ARCH_LIVING = {
    rocky:  { biome: 'verdant',  density: 0.34, weather: { kind: 'none', density: 0.0,  color: rgb(200, 200, 200), wind: [0.2, 0.1] },
              atmosphere: { rayleigh: rgb(90, 130, 200),  mie: 0.012, sunIntensity: 1.0, nightTint: rgb(20, 26, 44) }, water: false },
    lava:   { biome: 'volcanic', density: 0.16, weather: { kind: 'ash',  density: 0.55, color: rgb(60, 40, 36),    wind: [0.4, 0.2] },
              atmosphere: { rayleigh: rgb(150, 50, 36),   mie: 0.05,  sunIntensity: 0.8, nightTint: rgb(40, 10, 8) },  water: false },
    ice:    { biome: 'ice',      density: 0.10, weather: { kind: 'snow', density: 0.6,  color: rgb(235, 245, 255), wind: [0.3, -0.2] },
              atmosphere: { rayleigh: rgb(150, 180, 220), mie: 0.02,  sunIntensity: 0.9, nightTint: rgb(30, 40, 60) }, water: false },
    desert: { biome: 'desert',   density: 0.14, weather: { kind: 'dust', density: 0.5,  color: rgb(210, 170, 110), wind: [0.6, 0.3] },
              atmosphere: { rayleigh: rgb(180, 130, 80),  mie: 0.03,  sunIntensity: 1.1, nightTint: rgb(40, 30, 22) }, water: false },
    ocean:  { biome: 'verdant',  density: 0.30, weather: { kind: 'rain', density: 0.4,  color: rgb(140, 160, 180), wind: [0.3, 0.4] },
              atmosphere: { rayleigh: rgb(80, 140, 210),  mie: 0.015, sunIntensity: 1.0, nightTint: rgb(16, 24, 40) }, water: true },
    gas:    { biome: 'toxic',    density: 0.18, weather: { kind: 'none', density: 0.0,  color: rgb(200, 190, 210), wind: [0.5, 0.3] },
              atmosphere: { rayleigh: rgb(160, 140, 180), mie: 0.06,  sunIntensity: 0.7, nightTint: rgb(36, 30, 48) }, water: false },
    barren: { biome: 'barren',   density: 0.05, weather: { kind: 'none', density: 0.0,  color: rgb(150, 150, 150), wind: [0.1, 0.1] },
              atmosphere: { rayleigh: rgb(60, 60, 70),    mie: 0.005, sunIntensity: 1.0, nightTint: rgb(6, 6, 10) },   water: false },
  };

  // A deterministic outpost name from a seed (so NPC.atLandmark(name) -> crew).
  const OUTPOST_PREFIX = ['Halcyon', 'Drift', 'Cinder', 'Verge', 'Solace', 'Tycho', 'Marrow', 'Kestrel', 'Ardent', 'Pale', 'Hollow', 'Veil', 'Ember', 'Wren', 'Calder', 'Mire'];
  const OUTPOST_SUFFIX = ['Station', 'Outpost', 'Reach', 'Hold', 'Landing', 'Post', 'Camp', 'Watch', 'Refuge', 'Claim'];
  function outpostName(rng) {
    const p = OUTPOST_PREFIX[(rng() * OUTPOST_PREFIX.length) | 0];
    const s = OUTPOST_SUFFIX[(rng() * OUTPOST_SUFFIX.length) | 0];
    return p + ' ' + s;
  }
  const OUTPOST_KINDS = ['homestead', 'relay', 'prospector camp', 'crashed ship'];

  // Apply emissive scaling + a small hue jitter to a biome colour.
  function floraColor(base, emis, jitter) {
    const e = 1 + emis;
    return [
      Math.max(0, base[0] * e * (1 + jitter)),
      Math.max(0, base[1] * e * (1 + jitter)),
      Math.max(0, base[2] * e * (1 + jitter)),
    ];
  }

  // Bake ONE flora/rock instance at (x,gy,z). Shape chosen by biome.kind, with
  // per-instance variation from the cell hash. All deterministic.
  function bakeFlora(S, x, gy, z, ix, iz, seed, biome) {
    const h = (k) => hash2i(ix, iz, seed + 10 + k); // local hashes
    const scale = 0.7 + h(0) * 1.6;
    const rot = h(1) * Math.PI * 2;
    const jit = (h(2) - 0.5) * 0.18;
    const kind = biome.kind;

    if (kind === 'tree') {
      // parametric tree/mushroom: cylinder trunk + superformula canopy.
      const hgt = (5 + h(3) * 7) * scale;
      const trunkCol = [biome.flora[0] * 0.45, biome.flora[1] * 0.4, biome.flora[2] * 0.4];
      bakeCyl(S, x, gy, z, hgt * 0.6, 0.5 * scale, 0.35 * scale, 5, rot, 0, trunkCol);
      // canopy: superformula lathe cap as a 1-ring n-gon disk pushed up + a low
      // cone for volume.
      const capCol = floraColor(biome.flora, 0.0, jit);
      const accCol = floraColor(biome.accent, biome.emis, jit);
      const cy = gy + hgt * 0.6;
      const segs = 8;
      const ring = [];
      for (let s = 0; s < segs; s++) {
        const phi = (s / segs) * Math.PI * 2;
        const rad = (2.2 + h(4) * 1.6) * scale * (0.6 + 0.6 * superRadius(phi, 6, 1, 1, 1));
        ring.push([x + Math.cos(phi + rot) * rad, cy, z + Math.sin(phi + rot) * rad]);
      }
      const tip = [x, cy + (2.5 + h(5) * 2) * scale, z];
      for (let s = 0; s < segs; s++) {
        const n = (s + 1) % segs;
        S.pushTri(ring[s][0], ring[s][1], ring[s][2], tip[0], tip[1], tip[2], ring[n][0], ring[n][1], ring[n][2], capCol);
        S.pushTri(ring[s][0], ring[s][1], ring[s][2], ring[n][0], ring[n][1], ring[n][2], x, cy - 0.6 * scale, z, accCol);
      }
      return;
    }

    if (kind === 'crystal') {
      // 2..4 tapered prisms leaning out from a shared base — emissive accent.
      const n = 2 + ((h(3) * 3) | 0);
      const col = floraColor(biome.flora, biome.emis * 0.3, jit);
      const tipCol = floraColor(biome.accent, biome.emis, jit);
      for (let k = 0; k < n; k++) {
        const a = rot + (k / n) * Math.PI * 2 + h(6 + k) * 0.6;
        const off = (0.4 + h(7 + k) * 1.2) * scale;
        const cx = x + Math.cos(a) * off, cz = z + Math.sin(a) * off;
        const ch = (2.5 + h(8 + k) * 4.5) * scale;
        const lean = (h(9 + k) - 0.5) * 0.5;
        bakeCyl(S, cx, gy, cz, ch, (0.5 + h(10 + k) * 0.5) * scale, 0, 5, a, lean, col, tipCol);
      }
      return;
    }

    if (kind === 'frond') {
      // cross-quad fronds: 3 intersecting vertical cards, bottom dark -> top glow.
      const n = 3;
      const ch = (3 + h(3) * 5) * scale;
      const w = (0.8 + h(4) * 0.8) * scale;
      const lowCol = floraColor(biome.flora, 0.0, jit);
      const topCol = floraColor(biome.accent, biome.emis, jit);
      for (let k = 0; k < n; k++) {
        const a = rot + (k / n) * Math.PI;
        const ca = Math.cos(a), sa = Math.sin(a);
        const bend = (0.4 + h(5 + k) * 0.4) * w;
        const a0 = [x - ca * w, gy, z - sa * w];
        const b0 = [x + ca * w, gy, z + sa * w];
        const a1 = [x - ca * w * 0.3 + bend, gy + ch, z - sa * w * 0.3];
        const b1 = [x + ca * w * 0.3 + bend, gy + ch, z + sa * w * 0.3];
        // gradient: emit as two tris, bottom uses lowCol, top uses topCol.
        S.pushTri(a0[0], a0[1], a0[2], b0[0], b0[1], b0[2], b1[0], b1[1], b1[2], lowCol);
        S.pushTri(a0[0], a0[1], a0[2], b1[0], b1[1], b1[2], a1[0], a1[1], a1[2], topCol);
      }
      return;
    }

    // default: rock / boulder (barren & fallback).
    const rr = (1.2 + h(3) * 2.4) * scale;
    const rh = (1.0 + h(4) * 2.0) * scale;
    const col = floraColor(biome.rock, 0.0, jit * 0.5);
    bakeRock(S, x, gy, z, rr, rh, 6, (a, b) => hash2i(ix * 7 + a, iz * 7 + b, seed + 20), col);
  }

  // Bake one outpost structure: landing pad + dome habitat + antenna, plus a
  // couple of cargo boxes and emissive lights, all snapped to the terrain at
  // (x,gy,z). Variation by kind. Deterministic via the passed rng.
  function bakeOutpost(S, x, gy, z, yaw, kind, rng, biome) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    // local-to-world helper (offset in the outpost's facing frame, y is up).
    function L(ox, oy, oz) {
      return [x + ox * cy - oz * sy, gy + oy, z + ox * sy + oz * cy];
    }
    const pad = [0.36, 0.37, 0.4];
    const hull = [0.6, 0.62, 0.65];
    const lit = [0.5, 1.4, 2.4];      // emissive blue window/light
    const mark = [2.6, 1.8, 0.4];     // emissive amber rim marker
    const blink = [2.6, 0.3, 0.2];    // emissive red antenna blink
    const cargoCol = [0.7, 0.55, 0.25];

    // LANDING PAD — wide low octagonal cylinder.
    const pc = L(0, 0.3, 0);
    bakeCyl(S, pc[0], gy, pc[2], 0.6, 7, 6.6, 8, yaw, 0, pad, pad);
    // rim markers (emissive) around the pad.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const m = L(Math.cos(a) * 6.4, 0.7, Math.sin(a) * 6.4);
      bakeBox(S, m[0], m[1], m[2], 0.35, 0.25, 0.35, mark);
    }

    if (kind === 'crashed ship') {
      // tilted hull cylinder + scattered debris boxes + an emissive breach.
      const hb = L(0, 2.2, 2);
      bakeCyl(S, hb[0], gy + 1.0, hb[2], 9, 2.4, 1.6, 7, yaw + 0.3, 0.9, hull, hull);
      const br = L(1.5, 3.5, 3);
      bakeBox(S, br[0], br[1], br[2], 0.9, 0.9, 0.9, hull, lit, [true, false, true, false, true, false]);
      for (let i = 0; i < 4; i++) {
        const dx = (rng() * 2 - 1) * 7, dz = (rng() * 2 - 1) * 7;
        const d = L(dx, 0.6, dz);
        bakeBox(S, d[0], d[1], d[2], 0.6 + rng() * 0.5, 0.5, 0.6 + rng() * 0.5, cargoCol);
      }
      return;
    }

    // DOME HABITAT — short cylinder ring + a low cap dome on top.
    const dome = L(0, 0.6, 0);
    bakeCyl(S, dome[0], gy + 0.6, dome[2], 2.2, 3.0, 2.8, 8, yaw, 0, hull, hull);
    // dome cap (cone-ish) on top.
    const cap = L(0, 2.8, 0);
    bakeCyl(S, cap[0], gy + 2.8, cap[2], 2.4, 2.8, 0.4, 8, yaw, 0, hull, hull);
    // emissive windows on the ring.
    for (let i = 0; i < 4; i++) {
      const a = yaw + (i / 4) * Math.PI * 2;
      const w = L(Math.cos(a - yaw) * 3.0, 1.6, Math.sin(a - yaw) * 3.0);
      bakeBox(S, w[0], w[1], w[2], 0.5, 0.5, 0.2, lit, lit, [true, true, true, true, true, true]);
    }

    if (kind === 'relay') {
      // tall antenna mast + dish housing + blink lights.
      const mast = L(4, 0, 0);
      bakeCyl(S, mast[0], gy, mast[2], 11, 0.3, 0.18, 5, yaw, 0, hull, hull);
      const dish = L(4, 11, 0);
      bakeBox(S, dish[0], dish[1], dish[2], 0.8, 0.8, 0.8, hull);
      const bl = L(4, 12, 0);
      bakeBox(S, bl[0], bl[1], bl[2], 0.3, 0.3, 0.3, blink, blink, [true, true, true, true, true, true]);
    } else {
      // homestead / prospector camp: a couple of cargo containers + a short mast.
      const nC = 2 + ((rng() * 2) | 0);
      for (let i = 0; i < nC; i++) {
        const a = (i / nC) * Math.PI * 2;
        const c = L(Math.cos(a) * 4.5, 0.8, Math.sin(a) * 4.5);
        bakeBox(S, c[0], c[1], c[2], 1.0, 0.8, 0.6, cargoCol, mark, [true, false, false, false, false, false]);
      }
      const mast = L(-3.5, 0, 1);
      bakeCyl(S, mast[0], gy, mast[2], 6, 0.22, 0.14, 5, yaw, 0, hull, hull);
      const bl = L(-3.5, 6, 1);
      bakeBox(S, bl[0], bl[1], bl[2], 0.25, 0.25, 0.25, blink, blink, [true, true, true, true, true, true]);
    }
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

    // =========================================================================
    // v13 LIVING WORLDS — water / weather / atmosphere / biome flora + outposts.
    // All derived deterministically from the same seed (uses makeRng(rng) and
    // the cell hash hash2i; no Math.random). Everything additive — the existing
    // mesh/markers/sky/spawn/heightAt above are untouched.
    // =========================================================================
    const living = ARCH_LIVING[archetype] || ARCH_LIVING.rocky;
    const biome = BIOMES[living.biome] || BIOMES.verdant;

    // WATER — ocean worlds get a flat plane at the archetype waterLevel.
    const water = (def.water && living.water)
      ? { present: true, level: def.waterLevel || 0, color: (def.waterCol || [0.1, 0.34, 0.5]).slice() }
      : { present: false, level: def.waterLevel || 0, color: (def.waterCol || [0.1, 0.34, 0.5]).slice() };

    // WEATHER & ATMOSPHERE — per archetype (deep-copied so callers can't mutate
    // the shared table).
    const weather = {
      kind: living.weather.kind,
      density: living.weather.density,
      color: living.weather.color.slice(),
      wind: living.weather.wind.slice(),
    };
    const atmosphere = {
      rayleigh: living.atmosphere.rayleigh.slice(),
      mie: living.atmosphere.mie,
      sunIntensity: living.atmosphere.sunIntensity,
      nightTint: living.atmosphere.nightTint.slice(),
    };

    // Approximate slope (0 flat .. 1 steep) at (x,z) from the height gradient.
    function slopeAt(x, z) {
      const e = cell;
      const hx = heightAt(x + e, z) - heightAt(x - e, z);
      const hz = heightAt(x, z + e) - heightAt(x, z - e);
      const g = Math.hypot(hx, hz) / (2 * e);
      return clamp01(g); // |gradient| already ~0..1 for our amps/cell
    }

    // ---- OUTPOSTS: 1..3 on reasonably flat ground, baked as small structures
    // into the prop soup. Each carries a deterministic name so NPC.atLandmark
    // yields its crew. ----
    const orng = makeRng((seed ^ 0x51ED7) >>> 0);
    const soup = makeSoup();
    const outposts = [];
    const nOut = 1 + ((orng() * 3) | 0); // 1..3
    let placed = 0, tries = 0;
    while (placed < nOut && tries < 200) {
      tries++;
      const x = (orng() * 2 - 1) * extent * 0.7;
      const z = (orng() * 2 - 1) * extent * 0.7;
      const gy = heightAt(x, z);
      // skip steep ground and (on ocean worlds) anything under/near water.
      if (slopeAt(x, z) > 0.22) continue;
      if (water.present && gy < water.level + 6) continue;
      const yaw = orng() * Math.PI * 2;
      const name = outpostName(orng);
      const kind = OUTPOST_KINDS[(orng() * OUTPOST_KINDS.length) | 0];
      bakeOutpost(soup, x, gy, z, yaw, kind, orng, biome);
      outposts.push({ pos: [x, gy, z], yaw, kind, name });
      placed++;
    }
    // guarantee at least one outpost even on pathologically steep worlds.
    if (outposts.length === 0) {
      const x = extent * 0.2, z = -extent * 0.15, gy = heightAt(x, z);
      const yaw = orng() * Math.PI * 2;
      const name = outpostName(orng);
      const kind = OUTPOST_KINDS[(orng() * OUTPOST_KINDS.length) | 0];
      bakeOutpost(soup, x, gy, z, yaw, kind, orng, biome);
      outposts.push({ pos: [x, gy, z], yaw, kind, name });
    }

    // ---- FLORA + ROCKS: deterministic grid-jitter scatter, density gated by
    // slope/height and clustered by a low-freq patch field. Baked into the same
    // soup. Budget-capped so the single buffer stays performant. ----
    {
      const SCAT_GRID = 96;                 // scatter cells across the extent
      const sc = (extent * 2) / SCAT_GRID;  // world units per scatter cell
      const MAX_INSTANCES = 1600;
      const baseDensity = living.density;
      // avoid placing flora right on top of an outpost.
      function nearOutpost(x, z) {
        for (let i = 0; i < outposts.length; i++) {
          const o = outposts[i].pos;
          if (Math.hypot(x - o[0], z - o[2]) < 22) return true;
        }
        return false;
      }
      let count = 0;
      for (let iz = 0; iz < SCAT_GRID && count < MAX_INSTANCES; iz++) {
        for (let ix = 0; ix < SCAT_GRID && count < MAX_INSTANCES; ix++) {
          const r = hash2i(ix, iz, seed);
          // clustering: low-freq patch noise squared -> clumps with bare gaps.
          const patch = noise.vnoise(ix * 0.10, iz * 0.10);
          let d = baseDensity * (0.25 + patch * patch * 1.9);
          if (r > d) continue;
          // jitter inside the cell.
          const x = -extent + (ix + hash2i(ix, iz, seed + 1)) * sc;
          const z = -extent + (iz + hash2i(ix, iz, seed + 2)) * sc;
          if (Math.abs(x) > extent || Math.abs(z) > extent) continue;
          const gy = heightAt(x, z);
          if (water.present && gy < water.level + 1.5) continue; // not in water
          if (slopeAt(x, z) > 0.45) continue;                    // not on cliffs
          if (nearOutpost(x, z)) continue;
          bakeFlora(soup, x, gy, z, ix, iz, seed, biome);
          count++;
        }
      }
    }

    const propMesh = soup.triCount > 0 ? soup.bake() : null;

    return {
      archetype,
      extent,
      mesh: { tris, norms, triColor },
      markers,
      sky,
      spawn,
      heightAt,
      // ---- v13 LIVING WORLDS additive fields ----
      propMesh,
      water,
      weather,
      atmosphere,
      outposts,
    };
  }

  const Surface = {
    archetypes: Object.keys(ARCHETYPES),
    generate,
  };

  globalThis.Surface = Surface;
})();
