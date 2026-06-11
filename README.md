# FABLE UNIVERSE

A real-time **3D** N-body universe in a single page of vanilla JavaScript.
No frameworks, no build step, no dependencies. Open `index.html` — or visit
the live deployment — and you're orbiting up to ~500,000 gravitating bodies.

**Live: https://majveia.github.io/Fable/**

![Spiral galaxy with a lensing black hole at its core](docs/spiral-galaxy.png)

**v4 — deeper physics, deeper immersion:**
- **DKD leapfrog integrator** (2nd-order symplectic) on both engines —
  a GPU-integrated circular orbit holds its radius to 0.0% over two
  full periods (CI-verified in headless Chromium)
- **Dark-matter halos**: cored isothermal spheres give every galaxy its
  flat rotation curve; press `d` to switch dark matter off and watch
  the outskirts unbind — the observational argument, live
- **HDR bloom + ACES tone mapping**: cores glow instead of clipping
- **Async fenced GPU readback**: +30 fps at 147k bodies (42 → 72 fps
  even under software rendering)
- **Click-to-focus**: click any star, planet, or black hole to track it
  (`esc` releases); supernovae now leave **expanding remnant shells**
  and ring a soft chime (`m` mutes the ambient soundscape)
- **Shareable URLs**: scenario, seed, dark matter, and time speed live
  in the address bar — send a link, share the exact same universe

**v3 — GPU compute, lensing, evolution, scale:**
- **GPU N-body engine**: the CPU rebuilds a Barnes-Hut octree over the
  ~15k massive bodies each frame and flattens it into a texture with
  stackless escape-pointer links; a fragment shader integrates up to
  **524,288 bodies** against it in parallel. Positions never leave the
  GPU — the renderer reads them straight from the physics textures.
  Falls back to the CPU engine automatically.
- **Gravitational lensing**: screen-space Einstein deflection
  (β = θ·(1−θE²/θ²)) around up to 8 black holes — photon ring, shadow
  disc, inverted inner images.
- **Stellar evolution**: hot stars leave the main sequence, swell into
  red giants, go supernova, and leave white dwarfs, neutron stars, or
  black holes that immediately start feeding.
- **Moons to superclusters**: Earth's Moon, the Galilean moons, and
  Titan on Hill-stable orbits; a new Supercluster scenario strings ~50
  dwarf galaxies along cosmic-web filaments (~500k bodies in GPU mode).

![Black hole gravitationally lensing its galaxy](docs/black-hole-lensing.png)
![Supercluster: dwarf galaxies along cosmic-web filaments](docs/supercluster.png)

## What's inside

Every star, planet, dust grain, and black hole attracts every massive body
through Newtonian gravity, solved with a **Barnes-Hut octree** (O(n log n)) —
the same family of algorithm used in astrophysics research codes. Massless
tracers (dust, gas) ride the gravitational field of the massive bodies and
are kicked on alternating steps with a doubled timestep (subcycling), which
halves their cost with no first-order trajectory change. The opening angle
adapts at runtime to hold the frame rate on any machine.

Rendering is WebGL2: perspective point sprites with GPU glow, volumetric
gas billboards, sphere impostors for planets (real day/night terminator from
the scene light), black holes with halos, and a far starfield sphere for
parallax. The interface is deliberately minimal — everything fades away
after three seconds and leaves you alone with the universe.

| Scenario | What you'll see |
|---|---|
| **Spiral Galaxy** | Exponential thin disk + central bulge + stellar halo + dust lanes + arm gas, around a supermassive black hole |
| **Galaxy Collision** | Two galaxies on inclined planes merge: tidal tails, bridges, core coalescence |
| **Solar System** | Eight planets with true orbital inclinations, **Saturn's rings as particles orbiting inside its Hill sphere**, asteroid belt, Kuiper belt, scattered disc, comets |
| **Stellar Nursery** | A collapsing molecular cloud with embedded newborn star clusters |
| **Globular Cluster** | A 3D Plummer sphere relaxing under self-gravity |
| **Big Bang** | Near-critical Hubble expansion collapsing into filaments |
| **Binary Black Holes** | Two black holes orbiting their barycenter, shredding accretion disks on *different* orbital planes |

![Solar system](docs/solar-system.png)
![Stellar nursery](docs/stellar-nursery.png)

## Controls

| Input | Action |
|---|---|
| drag | orbit |
| shift-drag / right-drag | pan |
| scroll / pinch | zoom |
| `1`–`8` or `←` `→` | scenarios |
| `space` | pause |
| `[` `]` | time speed |
| `t` | motion trails |
| `b` | drop a black hole at the cursor |
| `g` (hold) | gravity well at the cursor |
| click / `esc` | track a body / release |
| `d` | dark matter on/off |
| `m` | sound on/off |
| `r` | reset · `f` fullscreen · `h` help |

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Plain script-tag modules:
DOM-free physics core (`js/core/`) that runs headless in Node, a WebGL2
render layer (`js/render/`), scenario definitions, and a thin main loop.

## Tests

```sh
node test/core.test.js      # octree vs brute force (1e-15 exact-mode), orbits,
                            # tracer semantics, accretion conservation, perf
node test/treepack.test.js  # GPU tree flattening vs reference traversal
node test/evolution.test.js # determinism, class ordering, remnants, mass loss
node test/smoke.js          # every scenario: stability, bounds, perf budget,
                            # moon-boundness, interleaved evolution
node test/gpu.browser.test.js  # REAL GPU engine in headless Chromium:
                               # analytic orbit accuracy, all scenarios
```

Both run in CI on every push; deployment to GitHub Pages is automatic.
