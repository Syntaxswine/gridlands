# gridlands-terrain format, version 1

The canonical hand-off from gridlands to other tools and games. One JSON
document, self-describing, deterministic byte-for-byte per map id. Produced
by the TERRAIN.JSON button or:

```
node tools/export.mjs --preset continent --seed first-light-42 --out out
```

## Envelope

```json
{
  "format": "gridlands-terrain",
  "version": 1,
  "meta":  { "tool", "mapId", "preset", "seed", "spec" },
  "grid":  { "width", "height", "cellMeters", "rowOrder": "north-first" },
  "datum": { "verticalUnit": "m", "zero": "mean sea level", "bedPositiveUp": true },
  "layers": { ... },
  "stats":  { ... }
}
```

Consumers should assert `format` and `version` before reading anything else.
`meta.mapId` is the generation fingerprint — echo it in whatever you build
from the file so provenance survives the crossing.

## Grid conventions

- Row-major, **row 0 = north edge**, `index = row*width + col`.
- Cell centres at `((col+0.5)·cellMeters, (row+0.5)·cellMeters)` from the
  north-west corner. `cellMeters` is 50 for stock gridlands maps.
- All elevations are metres relative to mean sea level, positive up.

## Encodings

- `b64f32le` — base64 of the raw little-endian float32 array, length
  `width·height·4` bytes. Decode: base64 → bytes → `Float32Array` view.
  Values are exact (no decimal round-trip loss).
- `b64u8` — base64 of one byte per cell.
- `glyph-rows` — `height` strings of `width` single-character glyphs plus a
  `legend` mapping glyph → `{ key, name, color, manning }`.

## Layers

| layer | encoding | meaning |
|---|---|---|
| `bedM` | b64f32le | ground/bed elevation. Negative = below sea level. This is the 3D map: land surface AND submarine bed in one field. |
| `surfaceM` | b64f32le | standing-water surface. `0` over ocean, the spill level over each lake (**exactly constant per lake** — flattened to the basin outlet's level), and `== bedM` wherever dry (playas and rivers included), so `depth = max(0, surfaceM − bedM)` needs no sentinels. |
| `manningN` | b64f32le | per-cell Manning roughness from the class table (Chow-style: playa 0.020 … forest 0.100). |
| `class` | glyph-rows | terrain class per cell; the legend carries names, palette hex, and the Manning table. |
| `trees` | b64u8 | 1 where the cell holds a tree. Density/species are the consumer's business — scatter your own art. |

`stats` carries the census (`waterFrac`, `trees`, `minBedM`, `maxBedM`) and
`suggestedManningScalar` (land-area mean) for solvers that take a single n.

## Invariants the exporter guarantees (enforced in tools/check.mjs)

1. Base64 layers round-trip byte-exact.
2. `surfaceM == 0` on ocean, `>= bedM` on lakes, `== bedM` exactly when dry.
3. Every lake's `surfaceM` is exactly constant, and strictly above every one
   of its bed cells — imported still water starts at rest.
4. `manningN` values come only from the documented table.
5. Glyph rows reproduce the class grid through the legend.
6. Two exports of the same seed+params are byte-identical.

## The sibling .glb

`MESH.GLB` / `--glb` emits the same map as binary glTF 2.0: a terrain
heightmesh (vertex per cell centre, per-vertex class colours) plus a
translucent water-surface mesh over wet cells. Metres; +X east, +Y up,
north at −Z (map is not mirrored). No baked normals — importers compute
flat normals; no baked lighting. Verified against a third-party importer
(three.js GLTFLoader) in `tools/glb-view.html`.
