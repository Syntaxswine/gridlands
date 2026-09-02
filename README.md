# GRIDLANDS

Rule-based grid terrain generator. A seed string and a preset go in; a
deterministic map of land, water, trees, and elevation comes out, classified
by an ordered rule table that is shown live in the UI.

One cell = 50 m. Default map 200×150 cells = 10.0 × 7.5 km.
Elevation span 2,500 m, metres measured from sea level.

## Run

```
node tools/serve.mjs        # http://localhost:8137  (ES modules need http)
node tools/check.mjs        # invariant suite, exits 1 on any failure
```

No dependencies, no build. `js/` modules run identically in the browser and
in node; only `render.js`/`main.js` touch the DOM.

## Pipeline

1. **Elevation** — domain-warped fBm gradient noise blended with ridged
   noise, optional island/coast mask, percentile-normalised, relief exponent,
   optional terracing (badlands).
2. **Depression filling** — priority-flood + epsilon (Barnes et al. 2014).
   Every interior cell gets a strictly descending path to the map edge.
3. **Ocean** — cells below sea level connected to the map edge. A below-sea
   basin that never reaches the edge is a lake, not ocean.
4. **Lakes** — depression cells deeper than 10 m, at the fill's spill level.
5. **Moisture** — a one-pass orographic sweep: a humidity front marches
   downwind, charges over water, rains out against rising ground, leaves a
   rain shadow behind ridges. Blended with noise, riparian bonus near water.
6. **Rivers** — D8 steepest descent on the filled surface, rain-weighted flow
   accumulation (upstream-first via the priority-flood pop order); cells with
   catchment over threshold are rivers. Rivers route into lakes and re-emerge
   at the spill point with the whole catchment behind them.
7. **Playas** — a closed basin keeps its lake only when inflow beats
   evaporation over its area: `arid shore ∧ inflow < k×area → dry flat`.
   Wet-shored tarns always persist; an arid basin fed by a big mountain river
   stays a lake (Pyramid Lake); a starved pan dries out (Death Valley, at map
   scale). Washes entering a playa die into sheetflow — no channel across.
8. **Classification + trees** — the rule table below, first match wins.
   Trees are per-cell Bernoulli draws keyed by cell identity (order-
   independent), density from moisture, only below the treeline.

## The rule table

| # | rule (defaults) | class |
|---|---|---|
| 1 | h < 0 m | ocean (deep below −150 m) |
| 2 | basin floods, depth > 10 m | lake |
| 3 | arid basin, inflow < 3×area | playa |
| 4 | catchment ≥ 180–220 cells | river |
| 5 | shore ∧ h < 8 m | beach |
| 6 | slope > 95 m/cell | rock |
| 7 | h > 1150 m | snow |
| 8 | h > 950 m | rock |
| 9 | wet > 0.55 | forest + trees |
| 10 | wet > 0.30 | grass, copses |
| 11 | wet > 0.16 | scrub |
| 12 | else | barrens |

The cliff threshold (95 m/cell) is calibrated to the 50 m mesh, not to
real-world cliff grades: per-cell diffs carry unresolved noise octaves that
read as slope (at 55 m/cell, 60% of a continent classified as rock).

## Presets

continent · island · archipelago · highlands · wetlands · badlands — each is
a parameter set over the same pipeline (mask, sea level, ridge mix, relief
exponent, moisture bias, terracing). Snow/rock/treeline are absolute
altitudes, so archipelagos correctly never reach the snowline while
highlands wear it low.

## Determinism

Same seed + params ⇒ same map, fingerprinted as the **map id** (FNV-1a over
elevation, moisture, accumulation, classes, trees) in the header. All draws
flow from the seed; per-cell draws are keyed by cell identity, never
iteration order. Float math is deterministic per JS engine (node and Chrome
share V8; other engines may differ in `pow`/`exp` rounding).

## Verification

`tools/check.mjs` generates 6 presets × 3 seeds at 200×150 and re-derives
the generator's claims independently (fresh BFS, fresh rule evaluation):
classification totals, ocean connectivity, fill domination, flat lake
surfaces, strictly descending drainage, legal outlets, rivers reaching
water, river/playa definitions both ways, tree legality, beaches touching
ocean, value ranges, double-generation determinism, distinct map ids across
the matrix, per-preset water fractions and existence floors (rig: size M,
default dials), plus the 3D-export invariants: byte-exact base64
round-trips, surface semantics (0 on ocean, spill on lakes, ==bed when
dry), exactly-flat lake surfaces, the Manning table, glyph/legend
round-trip, glb well-formedness (header, chunk alignment, accessor and
triangle counts), and byte-identical re-export. 288 checks at last count.

## Files

```
index.html           UI shell (field-guide styling inline)
js/rng.js            seeding, per-cell hashing, fingerprint
js/noise.js          gradient noise, fBm, ridged
js/heightmap.js      elevation field
js/hydrology.js      priority-flood, ocean/lakes/playas, D8 flow, accumulation
js/moisture.js       orographic sweep, riparian bonus
js/classify.js       the rule table, trees, census
js/generate.js       pipeline orchestration, presets
js/render.js         canvas painting (hillshade, contours, trees)
js/export3d.js       terrain.json + binary glTF exporters (DOM-free)
js/b64.js            portable base64 (browser/node byte-identical)
js/main.js           controls, inspector, exports
tools/check.mjs      invariant suite
tools/serve.mjs      zero-dep static server
tools/export.mjs     headless exporter CLI
tools/glb-view.html  three.js smoke-test viewer for exported .glb
docs/                TERRAIN-FORMAT.md spec + water-simulator proposal
```

## Exports

- **PNG** of the canvas; **ASCII map** (`.txt`, legend included); **params
  JSON** (enough to regenerate the exact map).
- **TERRAIN.JSON** — the `gridlands-terrain` v1 interchange: bed elevation
  and standing-water surface in metres (float32, base64, exact), classes,
  tree mask, per-cell Manning n. Spec: [docs/TERRAIN-FORMAT.md](docs/TERRAIN-FORMAT.md).
- **MESH.GLB** — binary glTF 2.0 heightmesh (terrain + translucent water,
  per-vertex class colours, metres, north at −Z). Opens in engines and
  viewers directly; smoke-tested against three.js GLTFLoader
  (`tools/glb-view.html?url=…`).
- Headless: `node tools/export.mjs --preset X --seed Y --out dir`.

The water-simulator bridge — same beds, its solver, lakes arriving exactly
at rest — is specced in
[docs/PROPOSAL-WATER-IMPORT.md](docs/PROPOSAL-WATER-IMPORT.md).

See [BACKLOG.md](BACKLOG.md) for the roads not yet taken.
