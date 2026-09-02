# BACKLOG

Roads not taken yet, roughly ordered by pull.

- **Erosion.** The honest fix for noise-terrain's everywhere-depressions is
  carving, not just filling: thermal + stream-power erosion passes would give
  integrated drainage, real valleys, and fewer/better lakes. Priority-flood
  breaching (Lindsay 2016) is the cheap half-step.
- **Temperature axis.** Latitude + lapse rate would split the moisture bands
  into proper biomes (tundra vs desert vs steppe) and make the snowline
  seed-dependent rather than a constant.
- **River width.** Accumulation is already there; draw order-2+ rivers wider
  and mark deltas where they meet the sea.
- **Meanders.** D8 on smooth slopes runs straight; a curvature-biased walk
  or post-hoc displacement would read more alluvial.
- **Tile/autotile export.** terrain.json + .glb ship (docs/TERRAIN-FORMAT.md);
  still open: Tiled/Godot autotile JSON, a cropped/downsampled window export,
  and river-mouth discharge estimates for solvers that want inflow.
- **Named features.** Flood-fill regions (this bay, that range) + the seed
  word-list = automatic gazetteer in field-guide style.
- **Mutation-test the checker.** Break each invariant on purpose (skip the
  epsilon, misroute one flow dir) and confirm the suite catches it.
- **Wind rose control.** The wind direction is seed-derived; expose it as a
  dial and show the rain-shadow flip live.
