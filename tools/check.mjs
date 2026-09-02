// Invariant suite. Generates a matrix of preset × seed worlds and checks the
// claims the generator makes, re-deriving each one independently of the
// pipeline code paths where possible (fresh BFS, fresh rule evaluation).
//
//   node tools/check.mjs
//
// Exits 1 on any failure. Expectations marked [rig: M] are measured at size
// M (200×150) with default dials — resize the rig, remeasure the numbers.

import { generate, makeParams, PRESETS, C } from "../js/generate.js";
import { CLASS_INFO, metersAbove, METERS_SPAN } from "../js/classify.js";
import { DIRS8 } from "../js/hydrology.js";
import { terrainJson, buildGlb, metersElev, buildSurface, MANNING_BY_CLASS } from "../js/export3d.js";
import { b64decode } from "../js/b64.js";

const SEEDS = ["first-light-42", "alpha", "bravo"];
const SIZE = { width: 200, height: 150 };
const failures = [];
let checksRun = 0;

function check(name, run, cond, detail = "") {
  checksRun++;
  if (!cond) failures.push(`${run} · ${name}${detail ? " — " + detail : ""}`);
}

function neighbors(i, w, h) {
  const x = i % w, y = (i / w) | 0;
  const out = [];
  for (const [dx, dy] of DIRS8) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < w && ny < h) out.push(ny * w + nx);
  }
  return out;
}

function verifyWorld(world, run) {
  const { w, h, p, elev, filled, ocean, lake, playa, river, dir, acc, moist, cls, trees, census } = world;
  const n = w * h;
  const isBorder = (i) => {
    const x = i % w, y = (i / w) | 0;
    return x === 0 || y === 0 || x === w - 1 || y === h - 1;
  };

  // 1. every cell classified, counts sum
  let bad = 0, sum = 0;
  for (let i = 0; i < n; i++) if (cls[i] > C.PLAYA) bad++;
  for (const c of census.counts) sum += c;
  check("classified", run, bad === 0 && sum === n, `bad=${bad} sum=${sum}/${n}`);

  // 2. class ⟺ mask consistency
  let mism = 0;
  for (let i = 0; i < n; i++) {
    const isOceanCls = cls[i] === C.DEEP || cls[i] === C.OCEAN;
    if (isOceanCls !== !!ocean[i]) mism++;
    if ((cls[i] === C.LAKE) !== !!(lake[i] && !ocean[i])) mism++;
    if (cls[i] === C.RIVER && !(river[i] && !ocean[i] && !lake[i])) mism++;
    if (cls[i] === C.PLAYA && !(playa[i] && !ocean[i] && !lake[i] && !river[i])) mism++;
  }
  check("water-class-consistency", run, mism === 0, `mismatches=${mism}`);

  // 2b. playas are genuine dry basins: depressions, mutually exclusive
  // with wet lakes, never below the sea's reach
  let badPlaya = 0;
  for (let i = 0; i < n; i++) {
    if (playa[i] && (filled[i] - elev[i] <= p.minLakeDepth || ocean[i] || lake[i])) badPlaya++;
  }
  check("playas-are-dry-basins", run, badPlaya === 0, `cells=${badPlaya}`);

  // 3. ocean == fresh edge-BFS through elev < sea
  const ref = new Uint8Array(n);
  const queue = [];
  for (let i = 0; i < n; i++) {
    if (isBorder(i) && elev[i] < p.sea) { ref[i] = 1; queue.push(i); }
  }
  while (queue.length) {
    const c = queue.pop();
    for (const nb of neighbors(c, w, h)) {
      if (!ref[nb] && elev[nb] < p.sea) { ref[nb] = 1; queue.push(nb); }
    }
  }
  let oceanDiff = 0;
  for (let i = 0; i < n; i++) if (ref[i] !== ocean[i]) oceanDiff++;
  check("ocean-connected", run, oceanDiff === 0, `diff=${oceanDiff}`);

  // 4. filled dominates terrain
  let sink = 0;
  for (let i = 0; i < n; i++) if (filled[i] < elev[i] - 1e-6) sink++;
  check("filled-dominates", run, sink === 0, `cells=${sink}`);

  // 5. each lake component sits at one surface level (±ε chain slack)
  const seen = new Uint8Array(n);
  let worstVar = 0;
  for (let i = 0; i < n; i++) {
    if (!lake[i] || seen[i]) continue;
    let lo = Infinity, hi = -Infinity;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop();
      lo = Math.min(lo, filled[c]); hi = Math.max(hi, filled[c]);
      for (const nb of neighbors(c, w, h)) {
        if (lake[nb] && !seen[nb]) { seen[nb] = 1; stack.push(nb); }
      }
    }
    worstVar = Math.max(worstVar, hi - lo);
  }
  check("lake-surface-flat", run, worstVar < 1.5e-3, `var=${worstVar.toExponential(2)}`);

  // 6. flow strictly descends the filled surface
  let uphill = 0;
  for (let i = 0; i < n; i++) {
    if (!ocean[i] && dir[i] >= 0 && !(filled[dir[i]] < filled[i])) uphill++;
  }
  check("drainage-descends", run, uphill === 0, `uphill=${uphill}`);

  // 7. only oceans and border cells may lack a downstream
  let strandedSinks = 0;
  for (let i = 0; i < n; i++) {
    if (dir[i] < 0 && !ocean[i] && !isBorder(i)) strandedSinks++;
  }
  check("outlets-legal", run, strandedSinks === 0, `cells=${strandedSinks}`);

  // 8. every river cell drains to ocean or off the map
  let strandedRivers = 0;
  for (let i = 0; i < n; i++) {
    if (!river[i]) continue;
    let c = i, steps = 0, ok = false;
    while (steps++ <= n) {
      if (ocean[c]) { ok = true; break; }
      const d = dir[c];
      if (d < 0) { ok = isBorder(c); break; }
      c = d;
    }
    if (!ok) strandedRivers++;
  }
  check("rivers-reach-water", run, strandedRivers === 0, `cells=${strandedRivers}`);

  // 9. river definition holds both ways (washes die on playas)
  let rdef = 0;
  for (let i = 0; i < n; i++) {
    const should = !ocean[i] && !lake[i] && !playa[i] && acc[i] >= p.riverThresh;
    if (should !== !!river[i]) rdef++;
  }
  check("rivers-defined", run, rdef === 0, `diff=${rdef}`);

  // 10. trees only on vegetation classes below the treeline
  let illegalTrees = 0;
  for (let i = 0; i < n; i++) {
    if (!trees[i]) continue;
    const veg = cls[i] === C.SCRUB || cls[i] === C.GRASS || cls[i] === C.FOREST;
    if (!veg || metersAbove(elev[i], p.sea) >= p.treelineM) illegalTrees++;
  }
  check("trees-legal", run, illegalTrees === 0, `cells=${illegalTrees}`);

  // 11. beaches touch the ocean
  let dryBeach = 0;
  for (let i = 0; i < n; i++) {
    if (cls[i] !== C.BEACH) continue;
    if (!neighbors(i, w, h).some((nb) => ocean[nb])) dryBeach++;
  }
  check("beaches-touch-ocean", run, dryBeach === 0, `cells=${dryBeach}`);

  // 12. ranges + finiteness
  let rangeBad = 0;
  for (let i = 0; i < n; i++) {
    if (!(elev[i] >= 0 && elev[i] <= 1)) rangeBad++;
    if (!(moist[i] >= 0 && moist[i] <= 1)) rangeBad++;
    if (!(acc[i] >= 0 && Number.isFinite(acc[i]))) rangeBad++;
  }
  check("ranges", run, rangeBad === 0, `violations=${rangeBad}`);
}

// ---- run the matrix ----------------------------------------------------

const runs = [];
for (const presetName of Object.keys(PRESETS)) {
  for (const seed of SEEDS) {
    const world = generate(makeParams({ preset: presetName, seed, ...SIZE }));
    const run = `${presetName}/${seed}`;
    verifyWorld(world, run);

    const [lo, hi] = PRESETS[presetName].waterFrac;
    check("waterfrac-in-bounds", run,
      world.census.waterFrac >= lo && world.census.waterFrac <= hi,
      `water=${world.census.waterFrac.toFixed(3)} expected [${lo}, ${hi}] [rig: M]`);

    runs.push({ run, world });
    const c = world.census;
    console.log(
      `${run.padEnd(26)} #${world.mapId}  water ${(c.waterFrac * 100).toFixed(1).padStart(5)}%` +
      `  rivers ${String(c.riverCells).padStart(4)}  lakes ${String(c.lakeCells).padStart(4)}` +
      `  trees ${String(c.trees).padStart(5)}  ${world.genMs.toFixed(0)} ms`
    );
  }
}

// 13. existence expectations [rig: M, default dials]
for (const { run, world } of runs) {
  const preset = run.split("/")[0];
  if (["continent", "island", "wetlands"].includes(preset)) {
    check("trees-exist", run, world.census.trees >= 50, `trees=${world.census.trees} [rig: M]`);
  }
  if (["continent", "highlands", "wetlands"].includes(preset)) {
    check("rivers-exist", run, world.census.riverCells >= 25, `river cells=${world.census.riverCells} [rig: M]`);
  }
}

// 14. determinism: regenerate three combos, ids must match
for (const combo of [["continent", "first-light-42"], ["archipelago", "alpha"], ["badlands", "bravo"]]) {
  const [preset, seed] = combo;
  const again = generate(makeParams({ preset, seed, ...SIZE }));
  const orig = runs.find((r) => r.run === `${preset}/${seed}`).world;
  check("deterministic", `${preset}/${seed}`, again.mapId === orig.mapId,
    `${orig.mapId} vs ${again.mapId}`);
}

// 15. the fingerprint discriminates: all runs distinct
const ids = new Set(runs.map((r) => r.world.mapId));
check("maps-distinct", "matrix", ids.size === runs.length, `${ids.size}/${runs.length} unique`);

// ---- 3D export invariants (two representative worlds: one oceanic, one
// arid with playas + terminal lakes) ------------------------------------

const f32 = (layer) => new Float32Array(b64decode(layer.data).buffer);

for (const comboRun of ["continent/first-light-42", "badlands/alpha"]) {
  const world = runs.find((r) => r.run === comboRun).world;
  const { w, h, p, ocean, lake, playa, filled, cls } = world;
  const n = w * h;
  const run = comboRun + " export";

  const doc = JSON.parse(terrainJson(world));
  const bed = f32(doc.layers.bedM);
  const surf = f32(doc.layers.surfaceM);
  const man = f32(doc.layers.manningN);
  const treesDecoded = b64decode(doc.layers.trees.data);

  // E1. base64 round-trip is byte-exact against freshly built layers
  const bedRef = metersElev(world);
  const surfRef = buildSurface(world, bedRef);
  let diff = 0;
  for (let i = 0; i < n; i++) {
    if (bed[i] !== bedRef[i] || surf[i] !== surfRef[i]) diff++;
    if (treesDecoded[i] !== world.trees[i]) diff++;
  }
  check("export-b64-roundtrip", run, diff === 0 && bed.length === n && surf.length === n,
    `diffs=${diff} len=${bed.length}/${n}`);

  // E2. surface semantics: ==bed when dry, 0 on ocean, >=bed on lakes
  let semBad = 0;
  for (let i = 0; i < n; i++) {
    if (ocean[i]) { if (surf[i] !== 0) semBad++; }
    else if (lake[i]) { if (!(surf[i] >= bed[i])) semBad++; }
    else if (surf[i] !== bed[i]) semBad++;
  }
  check("export-surface-semantics", run, semBad === 0, `cells=${semBad}`);

  // E3. each exported lake surface is EXACTLY constant (flattened to spill),
  // and every lake cell stays submerged under that level
  const seen = new Uint8Array(n);
  let lakeBad = 0;
  for (let i = 0; i < n; i++) {
    if (!lake[i] || seen[i]) continue;
    const level = surf[i];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop();
      if (surf[c] !== level || bed[c] >= level) lakeBad++;
      const cx = c % w, cy = (c / w) | 0;
      for (const [dx, dy] of DIRS8) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nb = ny * w + nx;
        if (lake[nb] && !seen[nb]) { seen[nb] = 1; stack.push(nb); }
      }
    }
  }
  check("export-lakes-at-rest", run, lakeBad === 0, `cells=${lakeBad}`);

  // E4. Manning values come from the documented table
  let manBad = 0;
  for (let i = 0; i < n; i++) if (man[i] !== Math.fround(MANNING_BY_CLASS[cls[i]])) manBad++;
  check("export-manning-table", run, manBad === 0, `cells=${manBad}`);

  // E5. glyph rows reproduce the class grid through the legend
  let glyphBad = 0;
  for (let y = 0; y < h; y++) {
    const row = doc.layers.class.rows[y];
    for (let x = 0; x < w; x++) {
      if (doc.layers.class.legend[row[x]].key !== CLASS_INFO[cls[y * w + x]].key) glyphBad++;
    }
  }
  check("export-class-rows", run, glyphBad === 0, `cells=${glyphBad}`);

  // E6. glb is well-formed: header, chunk layout, accessor/index sanity
  const glb = buildGlb(world);
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const magicOK = dv.getUint32(0, true) === 0x46546c67 && dv.getUint32(4, true) === 2;
  const totalOK = dv.getUint32(8, true) === glb.byteLength;
  const jsonLen = dv.getUint32(12, true);
  const gj = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  const binLen = dv.getUint32(20 + jsonLen, true);
  const binStart = 20 + jsonLen + 8;
  const chunksOK = binStart + binLen === glb.byteLength && gj.buffers[0].byteLength === binLen;
  let viewsOK = true;
  for (const bv of gj.bufferViews) {
    if (bv.byteOffset % 4 !== 0 || bv.byteOffset + bv.byteLength > binLen) viewsOK = false;
  }
  const posAcc = gj.accessors[0];
  const idxView = gj.bufferViews[2];
  const tIdx = new Uint32Array(glb.buffer.slice(
    glb.byteOffset + binStart + idxView.byteOffset,
    glb.byteOffset + binStart + idxView.byteOffset + idxView.byteLength));
  let idxMax = 0;
  for (const ix of tIdx) if (ix > idxMax) idxMax = ix;
  const triOK = tIdx.length === (w - 1) * (h - 1) * 6 && idxMax === w * h - 1;
  let wet = 0;
  for (let i = 0; i < n; i++) if (ocean[i] | lake[i]) wet++;
  const waterOK = wet === 0
    ? gj.meshes[0].primitives.length === 1
    : gj.accessors[5].count === wet * 6 && gj.accessors[3].count === wet * 4;
  check("export-glb-wellformed", run,
    magicOK && totalOK && chunksOK && viewsOK && triOK && waterOK && posAcc.count === n,
    `magic=${magicOK} total=${totalOK} chunks=${chunksOK} views=${viewsOK} tri=${triOK} water=${waterOK}`);

  // E7. exports are deterministic byte-for-byte
  const again = generate(makeParams({ preset: comboRun.split("/")[0], seed: comboRun.split("/")[1], ...SIZE }));
  const jsonSame = terrainJson(again) === terrainJson(world);
  const glb2 = buildGlb(again);
  let glbSame = glb2.byteLength === glb.byteLength;
  if (glbSame) for (let i = 0; i < glb.byteLength; i++) if (glb[i] !== glb2[i]) { glbSame = false; break; }
  check("export-deterministic", run, jsonSame && glbSame, `json=${jsonSame} glb=${glbSame}`);
}

// ---- report ------------------------------------------------------------

console.log("");
if (failures.length) {
  console.log(`FAIL — ${failures.length} of ${checksRun} checks:`);
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
} else {
  console.log(`PASS — ${checksRun} checks green across ${runs.length} worlds ` +
    `(${Object.keys(PRESETS).length} presets × ${SEEDS.length} seeds, 200×150)`);
}
