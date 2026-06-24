'use strict';
/* ============================================================
   FABLE: DRIFTER — js/game/poi.js  -> globalThis.POI
   DOM-free; attaches via globalThis only. Loadable in Node via
   indirect-eval (see test/smoke.js, test/cosmos.test.js).

   Deterministic points of interest for a cosmos node. A POI is a
   scannable landmark in a node's LOCAL frame — a station, a
   derelict, an anomaly, a portal, a beacon. Counts and kinds are
   weighted by node.kind (systems are richest; galaxies sparse
   beacons; the universe has none); portals and anomalies are RARE,
   the Rick-and-Morty weirdness you stumble onto once in a while.

   Determinism is keyed on node.id: forNode(node) generates and
   CACHES (node._pois) the same POIs every time for the same node.
   Names/blurbs come from globalThis.Lore when present (key =
   node.id + '/' + poi.id); otherwise the module degrades to plain
   generated strings so it works standalone.
   ============================================================ */
(function () {

  // ---- Seeded RNG (mulberry32), copied from js/scenarios.js. -------------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // FNV-1a 32-bit string hash -> a stable seed for any key string.
  function hashStr(str) {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // ---- POI kind weighting, per node.kind. --------------------------------
  // Each entry: { range:[min,max], weights:{kind:weight,...} }.
  // 'station'/'derelict'/'beacon' are the common furniture; 'anomaly' and
  // 'portal' are deliberately rare. The universe node gets nothing (you fly
  // to galaxies first), galaxies get a sparse scatter of beacons.
  const PROFILES = {
    universe: { range: [0, 0], weights: {} },
    galaxy: {
      range: [1, 3],
      weights: { beacon: 7, station: 1, anomaly: 1, derelict: 0, portal: 0.4 },
    },
    system: {
      range: [3, 7],
      weights: { station: 5, derelict: 4, beacon: 3, anomaly: 1.2, portal: 0.5 },
    },
    planet: {
      range: [1, 3],
      weights: { derelict: 4, station: 3, beacon: 2, anomaly: 1, portal: 0.3 },
    },
  };

  // POI radius as a fraction of the node's viewRadius (so markers scale
  // with the level you're flying in). Anomalies/portals read big; beacons
  // are pinpricks.
  const KIND_RADIUS = {
    station: 0.018,
    derelict: 0.010,
    anomaly: 0.025,
    portal: 0.020,
    beacon: 0.008,
  };

  // ---- Standalone fallback text (when globalThis.Lore is absent). ---------
  const FALLBACK_NAME = {
    station: ['Waypoint', 'Depot', 'Outpost', 'Relay', 'Dock'],
    derelict: ['Hulk', 'Wreck', 'Drifter', 'Husk', 'Ghost'],
    anomaly: ['Rift', 'Distortion', 'Smear', 'Fold', 'Bloom'],
    portal: ['Gate', 'Aperture', 'Throat', 'Seam', 'Door'],
    beacon: ['Marker', 'Pulse', 'Signal', 'Pip', 'Tag'],
  };
  const FALLBACK_BLURB = {
    station: 'A working station, lights on, nobody answering the hail.',
    derelict: 'A dead hull tumbling slow. Something chewed through the spine.',
    anomaly: 'Readings refuse to hold still. The instruments are nervous.',
    portal: 'A hole in the local geometry. It hums in a key that does not exist.',
    beacon: 'An automated marker, looping the same tired coordinates.',
  };

  function fallbackName(kind, rng) {
    const bank = FALLBACK_NAME[kind] || ['Object'];
    const word = bank[(rng() * bank.length) | 0];
    const num = 1 + ((rng() * 999) | 0);
    return word + '-' + num;
  }
  function fallbackBlurb(kind) {
    return FALLBACK_BLURB[kind] || 'An unidentified contact in the dark.';
  }

  // Weighted pick from { kind: weight } using rng() in [0,1).
  function pickWeighted(weights, rng) {
    let total = 0;
    const keys = [];
    for (const k in weights) {
      const w = weights[k];
      if (w > 0) { keys.push(k); total += w; }
    }
    if (total <= 0) return null;
    let r = rng() * total;
    for (let i = 0; i < keys.length; i++) {
      r -= weights[keys[i]];
      if (r < 0) return keys[i];
    }
    return keys[keys.length - 1];
  }

  // Uniform point inside a ball of the given radius: a random direction on
  // the unit sphere (Marsaglia) times a cube-root radius for uniform volume
  // density. Guaranteed finite and magnitude <= radius.
  function pointInBall(radius, rng) {
    let x, y, z;
    for (;;) {
      const u = rng() * 2 - 1;
      const v = rng() * 2 - 1;
      const s = u * u + v * v;
      if (s >= 1 || s === 0) continue;
      const f = 2 * Math.sqrt(1 - s);
      x = u * f; y = v * f; z = 1 - 2 * s;
      break;
    }
    const r = radius * Math.cbrt(rng());
    return [x * r, y * r, z * r];
  }

  const POI = {
    // Inspectable weighting tables (read-only by convention).
    _profiles: PROFILES,

    // forNode(node) -> POI[]   (cached on node._pois; deterministic by node.id)
    forNode: function (node) {
      if (!node) return [];
      if (node._pois) return node._pois;

      const kind = node.kind || 'system';
      const profile = PROFILES[kind] || PROFILES.system;
      // viewRadius is the finite populated interior extent. Guard against a
      // missing/zero value so localPos stays finite & bounded regardless.
      let vr = node.viewRadius;
      if (!(vr > 0) || !isFinite(vr)) vr = node.radius;
      if (!(vr > 0) || !isFinite(vr)) vr = 1;

      const seed = hashStr('poi:' + node.id);
      const rng = mulberry32(seed);

      const [lo, hi] = profile.range;
      let count = 0;
      if (hi > 0) count = lo + ((rng() * (hi - lo + 1)) | 0);

      const list = [];
      for (let i = 0; i < count; i++) {
        const pkind = pickWeighted(profile.weights, rng);
        if (!pkind) break;
        const id = 'poi' + i;
        const localPos = pointInBall(vr, rng);
        const radius = (KIND_RADIUS[pkind] || 0.012) * vr;

        const lore = globalThis.Lore;
        const key = node.id + '/' + id;
        let name, blurb;
        if (lore && typeof lore.poiName === 'function') {
          name = lore.poiName(key, pkind);
        }
        if (lore && typeof lore.poiBlurb === 'function') {
          blurb = lore.poiBlurb(key, pkind);
        }
        if (typeof name !== 'string' || name.length === 0) name = fallbackName(pkind, rng);
        if (typeof blurb !== 'string' || blurb.length === 0) blurb = fallbackBlurb(pkind);

        list.push({
          id: id,
          kind: pkind,
          localPos: localPos,
          radius: radius,
          name: name,
          blurb: blurb,
          scanned: false,
        });
      }

      node._pois = list;
      return list;
    },

    // scan(poi) -> { kind, name, blurb, first }   (marks scanned; first once)
    scan: function (poi) {
      if (!poi) return { kind: null, name: '', blurb: '', first: false };
      const first = !poi.scanned;
      poi.scanned = true;
      return { kind: poi.kind, name: poi.name, blurb: poi.blurb, first: first };
    },
  };

  globalThis.POI = POI;
})();
