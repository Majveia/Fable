'use strict';
/* ============================================================
   FABLE: DRIFTER — NPCs (js/game/npc.js)  -> globalThis.NPC

   A deterministic NPC roster you can MEET at stations and landmarks.
   DOM-free: attaches to globalThis only, loadable in Node via
   indirect-eval (see test/smoke.js, test/lore.test.js, test/npc.test.js).

   Voice: Cowboy Bebop x Rick & Morty x No Man's Sky — bounty hunters,
   drifters, traders, weird aliens, washed-up pilots. Smoke and debt,
   dimensional residue, catalogue-poetry. Tasteful: no slurs, no cruelty
   for its own sake, just lounge-room fatalism and absurd cosmic shrugs.

   Determinism: ONE landmark name/id -> the SAME roster, forever. Each
   NPC's lines/greeting/farewell/bark are keyed off the NPC's stable id,
   so they never drift between calls. Every draw routes through a
   mulberry32 stream seeded by an FNV-1a hash of a salted key — the same
   hash/RNG contract as cosmos.js / lore.js / landmarks.js, so an NPC key
   and a cosmos id mix the same way.

   No external deps, no DOM, no Math.random in any generative path. Every
   template fully resolves — no undefined / NaN / "[object Object]" leaks.
   ============================================================ */
(() => {

  /* ---------------------------------------------------------------
     FNV-1a 32-bit string hash -> mulberry32 seed. Same constants as
     cosmos.js / lore.js so keys mix identically across the codebase.
     --------------------------------------------------------------- */
  function hashStringToU32(s) {
    s = String(s);
    let h = 0x811c9dc5;                 // FNV offset basis
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);     // FNV prime, 32-bit wrap via imul
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Namespaced RNG: a salt per stream so npc-name and npc-line draws on the
  // same key don't collide, while each stays deterministic for that key.
  function rngFor(key, salt) {
    return mulberry32(hashStringToU32(salt + ' ' + String(key)));
  }

  // Tiny RNG helpers — every draw routes through these.
  const pick = (rng, arr) => arr[(rng() * arr.length) | 0];
  const int = (rng, lo, hi) => lo + ((rng() * (hi - lo + 1)) | 0); // inclusive
  const chance = (rng, p) => rng() < p;
  function weighted(rng, weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = rng() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }
  // Draw `n` distinct items from an array (or all of it if n >= length).
  function sampleDistinct(rng, arr, n) {
    const pool = arr.slice();
    const out = [];
    n = Math.min(n, pool.length);
    for (let i = 0; i < n; i++) {
      const j = (rng() * pool.length) | 0;
      out.push(pool.splice(j, 1)[0]);
    }
    return out;
  }

  /* ===============================================================
     SPECIES — varied, with a small per-species name flavour so an
     insectoid doesn't read like a human. portraitColorIdx draws
     from the 0..17 cosmos palette, biased per species for a hint of
     visual identity (energy-beings glow blue/white, etc.).
     =============================================================== */
  const SPECIES = [
    {
      key: 'human',
      label: 'human',
      // weight of how often this species appears in a crowd
      weight: 6,
      colors: [4, 5, 6, 7, 8, 11, 13],
      desc: ['transplant', 'belter', 'core-worlder', 'station-rat', 'spacer'],
    },
    {
      key: 'synthetic',
      label: 'synthetic',
      weight: 4,
      colors: [0, 1, 2, 12, 14, 17],
      desc: ['retired servitor', 'unlicensed android', 'ghost in a hull',
        'decommissioned unit', 'free-running construct'],
    },
    {
      key: 'insectoid',
      label: 'insectoid',
      weight: 3,
      colors: [3, 5, 6, 9, 15],
      desc: ['hive-castoff', 'molt-singer', 'chitin trader', 'swarm-exile'],
    },
    {
      key: 'cephalopod',
      label: 'cephalopod',
      weight: 3,
      colors: [10, 12, 13, 14, 16],
      desc: ['tide-reader', 'ink-merchant', 'deep diver', 'pressure mystic'],
    },
    {
      key: 'energy-being',
      label: 'energy-being',
      weight: 2,
      colors: [0, 9, 10, 14, 16, 17],
      desc: ['standing waveform', 'polite plasma', 'sentient gas cloud',
        'coherent field', 'opinionated light'],
    },
  ];

  /* ===============================================================
     ROLES — each role carries its own line bank so a bartender
     never reads like a bounty broker. Roles weight differently per
     venue (a bar skews bartender/fixer; a galaxy beacon skews
     drifter/mystic) but every role can appear anywhere.
     =============================================================== */
  const ROLES = [
    'bounty broker', 'fuel trader', 'fixer', 'bartender',
    'fugitive', 'mystic', 'mechanic',
  ];

  /* ===============================================================
     NAME BANK — curated parts + procedural assembly so names feel
     hand-written, not random gibberish. A human gets first+last; a
     synthetic gets a designation; an insectoid a clicking syllable
     name; a cephalopod a tide-name; an energy-being a glyph-tag.
     =============================================================== */

  const HUMAN_FIRST = ['Vince', 'Mao', 'Dario', 'Rocco', 'Cobalt', 'Lin',
    'Faye', 'Julia', 'Annie', 'Domino', 'Punch', 'Judy', 'Asa', 'Mira',
    'Renko', 'Sol', 'Greta', 'Hollis', 'Cass', 'Bishop', 'Wren', 'Tariq',
    'Nadia', 'Esek', 'Loto', 'Quill', 'Vesper', 'Marlow'];

  const HUMAN_LAST = ['Volaju', 'Wong', 'Black', 'Solensan', 'Garcia',
    'Kowalski', 'Murata', 'Cortez', 'Behn', 'Pao', 'Ortiz', 'Ono', 'Vance',
    'Okafor', 'Sandoval', 'Reyes', 'Hale', 'Drummond', 'Sato', 'Mercer',
    'Calloway', 'Nazari', 'Petrov', 'Okoye'];

  // Synthetic designations: a name-word + a model tag, e.g. "Ash-7 'Mox'".
  const SYNTH_NAME = ['Ash', 'Cinder', 'Verdigris', 'Pewter', 'Halftone',
    'Static', 'Lacquer', 'Tally', 'Ferrous', 'Dim', 'Echo', 'Nickel',
    'Glint', 'Solder', 'Rivet', 'Quartz'];
  const SYNTH_HANDLE = ['Mox', 'Bit', 'Coil', 'Hex', 'Wick', 'Fuse',
    'Spool', 'Cog', 'Dross', 'Nil'];

  // Insectoid: clicking consonant-cluster syllables, joined.
  const BUG_SYL = ['Kth', 'Zik', 'Rax', 'Vexx', 'Chit', 'Skar', 'Tzu',
    'Krl', 'Vask', 'Nyx', 'Zev', 'Klik', 'Threx', 'Vorn', 'Sszt'];
  const BUG_TITLE = ['the Molt', 'Third-Instar', 'of No Hive', 'Wing-Bare',
    'the Unswarmed', 'Drone-Lost'];

  // Cephalopod: liquid, tidal names.
  const CEPH_NAME = ['Oolu', 'Marenka', 'Sib', 'Pelagia', 'Vouli', 'Nauth',
    'Coralei', 'Brume', 'Sargasso', 'Undine', 'Mirelle', 'Tethys'];
  const CEPH_EPITHET = ['of the Long Tide', 'Inkwell', 'Eight-Quiet',
    'the Pressure-Born', 'Saltvein', 'who-counts-the-deep'];

  // Energy-being: a glyph/letter tag + a hum-word.
  const NRG_GLYPH = ['Æ', 'Ø', 'Ψ', 'Σ', 'Ω', 'Λ', 'Ξ', 'Φ'];
  const NRG_HUM = ['Hum', 'Shimmer', 'Drone', 'Aurora', 'Flicker', 'Resonance',
    'Glow', 'Halo', 'Static', 'Pulse'];

  function makeName(rng, speciesKey) {
    if (speciesKey === 'human') {
      return pick(rng, HUMAN_FIRST) + ' ' + pick(rng, HUMAN_LAST);
    }
    if (speciesKey === 'synthetic') {
      const tag = pick(rng, SYNTH_NAME) + '-' + int(rng, 2, 99);
      return chance(rng, 0.6) ? tag + ' "' + pick(rng, SYNTH_HANDLE) + '"' : tag;
    }
    if (speciesKey === 'insectoid') {
      const syl = pick(rng, BUG_SYL) + (chance(rng, 0.5) ? '-' + pick(rng, BUG_SYL).toLowerCase() : '');
      return chance(rng, 0.5) ? syl + ', ' + pick(rng, BUG_TITLE) : syl;
    }
    if (speciesKey === 'cephalopod') {
      return chance(rng, 0.55)
        ? pick(rng, CEPH_NAME) + ' ' + pick(rng, CEPH_EPITHET)
        : pick(rng, CEPH_NAME);
    }
    // energy-being
    return pick(rng, NRG_GLYPH) + '-' + pick(rng, NRG_HUM)
      + (chance(rng, 0.4) ? ' ' + pick(rng, NRG_GLYPH) : '');
  }

  /* ===============================================================
     TRAITS — short, evocative tags. Drawn distinct per NPC.
     =============================================================== */
  const TRAITS = [
    'owes everyone', 'pays no one', 'smiles too much', 'never blinks',
    'quotes dead poets', 'smells of ozone', 'carries an old debt',
    'whistles when nervous', 'too calm under fire', 'allergic to silence',
    'keeps a ghost on retainer', 'flinches at sirens', 'wanted in three systems',
    'trades only in favors', 'speaks in tides', 'hums between words',
    'collects bad luck', 'lies fluently, badly', 'tips like a saint',
    'reads palms and warrants', 'half a step out of time', 'counts everything',
    'soft heart, hard ledger', 'one good eye, two bad habits',
    'remembers your face', 'forgets on purpose', 'misses a planet that burned',
    'fluent in static', 'overcharges, apologizes', 'born owing money'];

  /* ===============================================================
     DIALOGUE — one bank per role, each line in the right voice. Lines
     are short, spoken, leak-free. atLandmark draws 2..4 DISTINCT lines
     per NPC. greeting/farewell/bark draw from role-aware banks too.
     Curated so the assembly reads hand-written, not random.
     =============================================================== */
  const LINES = {
    'bounty broker': [
      'Got a face for you. Three systems want it, two will pay.',
      'Dead or alive — the poster says alive, the ledger disagrees.',
      'Reward’s good. Mark’s mean. Math’s your problem.',
      'I broker the names. You break the legs. Clean split.',
      'Skip-trace fee’s up front. Funerals are extra.',
      'Everyone’s worth something. Most of ’em, not much.',
    ],
    'fuel trader': [
      'Hydrogen’s cheap. Getting it to you out here isn’t.',
      'Top off before the next jump. The dark doesn’t coast.',
      'I sell fuel and bad directions. The fuel’s honest.',
      'Price went up while you were reading the price.',
      'Empty tank, empty drifter. Don’t be either.',
      'Refined, filtered, only slightly stolen. Cash or favor.',
    ],
    'fixer': [
      'Whatever you need, I know a guy. I’m usually the guy.',
      'Problems are just transactions that haven’t closed yet.',
      'Don’t ask where it came from. Ask what it costs.',
      'I move things. People, cargo, blame. Mostly blame.',
      'You didn’t hear it from me. You didn’t hear anything.',
      'Discretion’s free. The job isn’t.',
    ],
    'bartender': [
      'Drink’s on the house. The house is on fire, but still.',
      'I pour two things: the cheap stuff and the truth. Pick one.',
      'Everybody’s running from something. Sit. Run later.',
      'You look like a long story and a short tab.',
      'House rule: no shooting till after last call.',
      'I hear everything in here. I forget most of it. For a price.',
    ],
    'fugitive': [
      'You didn’t see me. Tell ’em I went the other way.',
      'They put a number on my head. I think they rounded up.',
      'I’m not hiding. I’m just very, very early to leaving.',
      'Whatever they’re paying for me, I’ll pay you not to.',
      'Three names, two faces, one bad night. Long story.',
      'If a hunter asks — I’m a saint, and I tip well.',
    ],
    'mystic': [
      'The void hums in a key your instruments can’t hear. I can.',
      'I read the dark the way you read a fuel gauge. We’re both low.',
      'Every jump leaves a scar in the geometry. Yours are healing.',
      'The stars don’t care, child. That’s the comfort of it.',
      'I saw your ending once. It was kinder than you’d expect.',
      'Coordinates are a kind of prayer. Most go unanswered.',
    ],
    'mechanic': [
      'Your drive’s held together with hope and bad welds. I can fix one.',
      'She’ll fly. Whether she stops is a separate invoice.',
      'Found the rattle. It’s your whole ship. Sit down.',
      'I can make her fast or make her safe. You’ve got the budget for neither.',
      'Torque it till it sings, then back off a quarter. That’s the trick.',
      'Bring me parts, I’ll bring her back. Bring me money, faster.',
    ],
  };

  // Absurd/cosmic spice lines, sprinkled in regardless of role for the
  // Rick-and-Morty register. Drawn at most once per NPC's line set.
  const SPICE = [
    'Burp — statistically, neither of us should be here.',
    'Don’t drink the blue stuff. It drinks back.',
    'I’m technically illegal in nine realities. Friendly in this one.',
    'The physics out here is more of a suggestion, honestly.',
    'Met myself once at a station like this. We didn’t get along.',
    'Reality’s a rental. Tip the universe and it leaves you alone.',
    'A Federation auditor came through. We don’t talk about the auditor.',
    'This whole sector’s a tax dodge that grew a sun. Cozy, though.',
  ];

  // Greetings & farewells: role-flavoured, deterministic per NPC.
  const GREET = {
    'bounty broker': ['You buying or selling? Either way, somebody bleeds.',
      'Sit. I’ve got a name that’ll fit your hands.'],
    'fuel trader':   ['Tank low? You came to the right rust.',
      'Step up, drifter. Cheapest hydrogen in the dark — allegedly.'],
    'fixer':         ['Look who needs a guy. Lucky you, I’m a guy.',
      'Talk quiet, pay loud. What do you need gone?'],
    'bartender':     ['Welcome to the end of the bar and the edge of nowhere.',
      'Sit anywhere the blood’s dry. What’ll it be?'],
    'fugitive':      ['— Oh. You’re not them. Good. Good.',
      'Keep your voice down and your eyes elsewhere, yeah?'],
    'mystic':        ['Ah. The dark sent you. It usually does.',
      'I felt your engine’s wake before I saw your face.'],
    'mechanic':      ['That your bucket on the pad? We need to talk.',
      'Mind the grease. Now — what’s broken this time?'],
  };
  const FAREWELL = {
    'bounty broker': ['Bring me a body, I’ll bring you a fortune.',
      'Don’t die owing me. It’s rude.'],
    'fuel trader':   ['Burn clean. Come back thirsty.',
      'Mind the gauge, drifter. The dark doesn’t coast.'],
    'fixer':         ['You were never here. Neither was I.',
      'Need anything else gone, you know the frequency.'],
    'bartender':     ['Door’s that way. So’s the trouble. Choose.',
      'Tip jar’s the dented one. Safe burns.'],
    'fugitive':      ['If anyone asks — I went the other way.',
      'Thanks. I’ll remember this. Briefly, then never.'],
    'mystic':        ['Go well into the dark. It remembers the polite ones.',
      'Your coordinates are a prayer. Mean it this time.'],
    'mechanic':      ['She’ll hold. Probably. Don’t test the probably.',
      'Fly easy. Bring her back in one invoice.'],
  };
  // Ambient barks — short overheard one-liners.
  const BARK = [
    'Anybody seen my ship? Smaller than yours, twice as honest.',
    'Last call was an hour ago. I’m savoring the denial.',
    'They say the next jump’s cursed. They say that about every jump.',
    'I’m not lost. The destination is.',
    'Woolongs don’t spend themselves, but I keep hoping.',
    'Heard a beacon out past the verge, singing the wrong song.',
    'Two drinks from a confession, one from a fight. Buy me one.',
    'Space is big. My problems found me anyway.',
    'If you see a synthetic named Mox, you owe me. Long story.',
    'The universe blinked at me yesterday. I blinked back. Rude of both of us.',
  ];

  /* ===============================================================
     ROLE WEIGHTING by venue. atLandmark biases the role mix by a
     coarse venue hint derived from the name/kind, but every role can
     still surface. Order matches ROLES[].
     ramp:           broker fuel fixer bar  fug  myst mech
     =============================================================== */
  const ROLE_WEIGHTS = {
    bar:     [2, 1, 3, 6, 3, 1, 1],
    station: [3, 5, 4, 3, 2, 1, 4],
    galaxy:  [2, 2, 2, 1, 3, 5, 2],
    system:  [4, 4, 3, 3, 3, 2, 3],
    // v13: frontier planet OUTPOSTS — prospectors/mechanics, hermits (mystic),
    // fugitives lying low, the odd fixer. Fewer brokers, almost no bar crowd.
    outpost: [2, 3, 4, 1, 4, 4, 5],
    default: [3, 3, 3, 3, 3, 2, 3],
  };

  // Guess a venue profile from a landmark name/id string.
  function venueFor(s) {
    const t = String(s).toLowerCase();
    if (/(bar|lounge|cantina|saloon|last call|cold comfort|the wake)/.test(t)) return 'bar';
    if (/(station|depot|relay|dock|port|float|outpost|waystation|spire|terminal)/.test(t)) return 'station';
    if (/(galaxy|nursery|cluster|nebula|antennae|dawn|omega|orion)/.test(t)) return 'galaxy';
    if (/(sol|cygnus|maw|end|system|sector)/.test(t)) return 'system';
    return 'default';
  }

  /* ===============================================================
     buildNPC(landmarkKey, index) -> one fully-resolved NPC.
     The NPC's STABLE id is landmarkKey + '#' + index, and ALL of its
     text (name/species/role/traits/lines) is keyed off that id, so the
     same landmark always yields the same person in slot `index`.
     =============================================================== */
  function buildNPC(landmarkKey, index, venue) {
    const id = String(landmarkKey) + '#' + index;

    // Species: weighted pick from SPECIES[].
    const srng = rngFor(id, 'npc-species');
    const sIdx = weighted(srng, SPECIES.map((s) => s.weight));
    const species = SPECIES[sIdx];

    // Role: weighted by venue.
    const rrng = rngFor(id, 'npc-role');
    const rw = ROLE_WEIGHTS[venue] || ROLE_WEIGHTS.default;
    const role = ROLES[weighted(rrng, rw)];

    // Name (species-flavoured).
    const name = makeName(rngFor(id, 'npc-name'), species.key);

    // Portrait colour: a palette index 0..17, biased per species.
    const crng = rngFor(id, 'npc-color');
    let portraitColorIdx = pick(crng, species.colors);
    // Hard clamp into [0,17] regardless of palette edits.
    portraitColorIdx = Math.max(0, Math.min(17, portraitColorIdx | 0));

    // Traits: 2..3 distinct tags + a species descriptor flavour.
    const trng = rngFor(id, 'npc-traits');
    const traits = sampleDistinct(trng, TRAITS, int(trng, 2, 3));
    traits.push(pick(trng, species.desc)); // a species-coloured descriptor

    // Lines: 2..4 distinct, role-voiced, with a small chance of one spice line.
    const lrng = rngFor(id, 'npc-lines');
    const bank = LINES[role] || LINES.fixer;
    const nLines = int(lrng, 2, 4);
    const lines = sampleDistinct(lrng, bank, nLines);
    // Roughly one in three gets an absurd/cosmic aside, replacing the last line
    // so the count stays in [2,4]. Energy-beings & synthetics lean weirder.
    const spiceChance = (species.key === 'energy-being' || species.key === 'synthetic') ? 0.45 : 0.28;
    if (lines.length >= 2 && chance(lrng, spiceChance)) {
      lines[lines.length - 1] = pick(lrng, SPICE);
    }

    return {
      id,
      name,
      species: species.label,
      role,
      portraitColorIdx,
      homeLandmark: String(landmarkKey),
      traits,
      lines,
    };
  }

  /* ===============================================================
     Public surface.
     =============================================================== */
  const NPC = {
    /* atLandmark(nameOrId, count) -> NPC[]
       Deterministic for a given landmark string. `count` defaults to a
       venue-dependent 3..6 (also deterministic for the landmark), so the
       same place always has the same crowd. Pass an explicit count to
       force a roster size. */
    atLandmark(nameOrId, count) {
      const key = (nameOrId === undefined || nameOrId === null || nameOrId === '')
        ? 'unknown-station' : String(nameOrId);
      const venue = venueFor(key);

      let n;
      if (typeof count === 'number' && isFinite(count)) {
        n = Math.max(1, Math.min(12, count | 0));
      } else {
        // Deterministic roster size for this landmark (3..6).
        const nrng = rngFor(key, 'npc-count');
        n = int(nrng, 3, 6);
      }

      const roster = [];
      for (let i = 0; i < n; i++) roster.push(buildNPC(key, i, venue));
      return roster;
    },

    /* atOutpost(nameOrId, kind, count) -> NPC[]  (v13 LIVING WORLDS)
       The frontier souls at a planet-surface outpost — lonelier crews than a
       station (default 1..3), biased toward prospectors/mechanics, hermits and
       fugitives. Deterministic per (name, kind): the same outpost always holds
       the same people. `kind` (homestead|relay|prospector camp|crashed ship)
       folds into the key so a relay and a wreck at the same name differ. */
    atOutpost(nameOrId, kind, count) {
      const base = (nameOrId === undefined || nameOrId === null || nameOrId === '')
        ? 'lonely-outpost' : String(nameOrId);
      const key = base + (kind ? ' :: ' + String(kind) : '');
      let n;
      if (typeof count === 'number' && isFinite(count)) {
        n = Math.max(1, Math.min(8, count | 0));
      } else {
        const nrng = rngFor(key, 'npc-count');
        n = int(nrng, 1, 3);
      }
      const roster = [];
      for (let i = 0; i < n; i++) {
        const npc = buildNPC(key, i, 'outpost');
        npc.outpostKind = kind ? String(kind) : '';
        roster.push(npc);
      }
      return roster;
    },

    /* greeting(npc) -> one deterministic line for that NPC. */
    greeting(npc) {
      if (!npc) return 'Well. Look what the dark dragged in.';
      const role = (npc.role && GREET[npc.role]) ? npc.role : 'fixer';
      const rng = rngFor(npc.id || npc.name || 'npc', 'npc-greet');
      const bank = GREET[role] || GREET.fixer;
      const line = pick(rng, bank);
      return (typeof line === 'string' && line.length) ? line
        : 'Well. Look what the dark dragged in.';
    },

    /* farewell(npc) -> one deterministic line for that NPC. */
    farewell(npc) {
      if (!npc) return 'Safe burns, drifter.';
      const role = (npc.role && FAREWELL[npc.role]) ? npc.role : 'fixer';
      const rng = rngFor(npc.id || npc.name || 'npc', 'npc-farewell');
      const bank = FAREWELL[role] || FAREWELL.fixer;
      const line = pick(rng, bank);
      return (typeof line === 'string' && line.length) ? line : 'Safe burns, drifter.';
    },

    /* bark(npc) -> one deterministic ambient one-liner for that NPC. */
    bark(npc) {
      const seed = (npc && (npc.id || npc.name)) ? (npc.id || npc.name) : 'npc';
      const rng = rngFor(seed, 'npc-bark');
      const line = pick(rng, BARK);
      return (typeof line === 'string' && line.length) ? line : 'Space is big. My problems found me anyway.';
    },

    // ---- exposed for tests / tools / reuse ----
    SPECIES,
    ROLES,
    _hash: hashStringToU32,
    _build: buildNPC,
    _venueFor: venueFor,
  };

  globalThis.NPC = NPC;
  if (typeof module !== 'undefined' && module.exports) module.exports = NPC;

})();
