'use strict';
/* ============================================================
   FABLE UNIVERSE v6 — persistence (js/cosmos/persist.js)

   The universe is one seed plus a clock. We persist { seed,
   clockMyr, lastVisitMs, edits } to IndexedDB and, on the next
   visit, advance the clock by the real time elapsed while away —
   so the cosmos genuinely AGES between sessions (galaxies rotate,
   stars evolve) without storing a single body.

   DOM-free-friendly: when indexedDB is absent (Node, tests, or a
   locked-down browser) an in-memory shim stands in, so save/load
   are always callable and never throw.
   ============================================================ */
(function () {
  const DB_NAME = 'fable-universe';
  const STORE = 'state';
  const KEY = 'universe';

  // 1 real hour away ages the universe by 200 Myr, capped at 5000 Myr
  // (≈ a galactic half-turn) so a months-long absence is dramatic but
  // not a degenerate fast-forward.
  const AGE_RATE_MYR_PER_MS = 200 / (60 * 60 * 1000);
  const AGE_CAP_MYR = 5000;

  let mem = null;   // in-memory fallback record

  const haveIDB = (() => {
    try { return typeof indexedDB !== 'undefined' && indexedDB !== null; }
    catch { return false; }
  })();

  function openDB() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const Persist = {
    AGE_CAP_MYR,

    /* Real-time-elapsed → Myr to advance, clamped. */
    ageDelta(lastVisitMs, nowMs) {
      if (!lastVisitMs || !nowMs || nowMs <= lastVisitMs) return 0;
      return Math.min((nowMs - lastVisitMs) * AGE_RATE_MYR_PER_MS, AGE_CAP_MYR);
    },

    /* -> { seed, clockMyr, edits, lastVisitMs } | null */
    async load() {
      if (!haveIDB) return mem ? { ...mem } : null;
      try {
        const db = await openDB();
        return await new Promise((resolve) => {
          const tx = db.transaction(STORE, 'readonly');
          const rq = tx.objectStore(STORE).get(KEY);
          rq.onsuccess = () => resolve(rq.result || null);
          rq.onerror = () => resolve(null);
        });
      } catch { return mem ? { ...mem } : null; }
    },

    /* record = { seed, clockMyr, edits } — lastVisitMs is stamped here. */
    async save(record) {
      const rec = {
        seed: record.seed >>> 0,
        clockMyr: +record.clockMyr || 0,
        edits: Array.isArray(record.edits) ? record.edits : [],
        lastVisitMs: Date.now(),
      };
      mem = rec;
      if (!haveIDB) return true;
      try {
        const db = await openDB();
        return await new Promise((resolve) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(rec, KEY);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        });
      } catch { return false; }
    },

    /* Wipe persisted state (a fresh universe on next boot). */
    async reset() {
      mem = null;
      if (!haveIDB) return true;
      try {
        const db = await openDB();
        return await new Promise((resolve) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(KEY);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        });
      } catch { return false; }
    },

    // Test hook: force the in-memory path regardless of environment.
    _useMemory() { return !haveIDB; },
  };

  globalThis.Persist = Persist;
})();
