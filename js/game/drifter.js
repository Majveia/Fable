'use strict';
/* ============================================================
   FABLE: DRIFTER — game state (js/game/drifter.js -> globalThis.Drifter)
   The bounty board, the discovery codex, scan progress, and the
   serialization that lets a save remember what you've seen and who
   you're hunting. Pure-ish: leans on globalThis.Lore / POI when
   present, degrades gracefully when not (so it loads in Node).
   ============================================================ */
(function () {
  const SCAN_TIME = 1.0;   // seconds of sustained scan to log a POI

  function rngFrom(key) {
    let h = 0x811c9dc5;
    const s = '' + key;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    let a = h >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const Drifter = {
    bounties: [],
    discoveries: [],         // { kind, name, blurb, nodeId }
    scanProgress: 0,
    _scanned: {},            // id -> true (dedupe across session)
    activeBounty: null,

    // Build a board of bounties, each pinned to a target system id drawn
    // from the provided candidate ids (landmark + nearby system ids).
    refreshBounties(seed, targetIds) {
      const L = globalThis.Lore;
      const ids = (targetIds && targetIds.length) ? targetIds : ['u/g0/s0'];
      const out = [];
      for (let i = 0; i < 6; i++) {
        const key = 'bounty/' + seed + '/' + i;
        const tid = ids[i % ids.length];
        const b = L ? L.bounty(key) : { name: 'Drifter ' + i, alias: '', crime: 'jaywalking spacetime',
          reward: 10000 + i * 5000, danger: (i % 5) + 1, flavor: '' };
        b.targetId = tid;
        b.systemHint = tid.split('/').pop();
        b.done = false;
        out.push(b);
      }
      this.bounties = out;
      return out;
    },

    acceptBounty(b) { this.activeBounty = b || null; return this.activeBounty; },

    // Call when the active bounty's target node is reached & scanned.
    completeBountyIfAt(nodeId) {
      const b = this.activeBounty;
      if (b && !b.done && b.targetId === nodeId) {
        b.done = true; this.activeBounty = null; return b;
      }
      return null;
    },

    // Accumulate scan; returns a discovery payload when a POI completes,
    // else null. `poi` is the POI currently under the reticle (or null).
    tickScan(dtSec, poi, holding) {
      if (!holding || !poi) { this.scanProgress = 0; return null; }
      this.scanProgress += dtSec / SCAN_TIME;
      if (this.scanProgress >= 1) {
        this.scanProgress = 0;
        return this.logDiscovery(poi);
      }
      return null;
    },

    logDiscovery(poi, nodeId) {
      const id = poi.id != null ? poi.id : (poi.kind + ':' + poi.name);
      const first = !this._scanned[id];
      if (globalThis.POI && typeof POI.scan === 'function') { try { POI.scan(poi); } catch (e) {} }
      if (first) {
        this._scanned[id] = true;
        this.discoveries.push({ kind: poi.kind, name: poi.name, blurb: poi.blurb, nodeId: nodeId || poi.nodeId });
      }
      return { kind: poi.kind, name: poi.name, blurb: poi.blurb, first };
    },

    serialize() {
      return {
        discoveries: this.discoveries.slice(0, 500),
        bountySeed: this._bountySeed || 0,
        activeBountyId: this.activeBounty ? this.activeBounty.targetId : null,
      };
    },

    load(data) {
      if (!data) return;
      this.discoveries = Array.isArray(data.discoveries) ? data.discoveries : [];
      for (const d of this.discoveries) {
        const id = d.id || (d.kind + ':' + d.name);
        this._scanned[id] = true;
      }
    },
  };

  globalThis.Drifter = Drifter;
  globalThis.Drifter._rngFrom = rngFrom;  // exposed for tests
})();
