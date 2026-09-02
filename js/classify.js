// The rule table. Classification is an ordered list of rules; the first rule
// that matches a cell names it. The same order is shown in the UI's RULES
// panel and documented in the README — if you change one, change all three.
//
// Elevation h is normalised [0,1]; metres = (h − sea) * METERS_SPAN.
// One cell = CELL_M metres on a side.

import { DIRS8 } from "./hydrology.js";
import { hash01 } from "./rng.js";

export const METERS_SPAN = 2500;
export const CELL_M = 50;

export const C = {
  DEEP: 0, OCEAN: 1, LAKE: 2, RIVER: 3, BEACH: 4, SAND: 5,
  SCRUB: 6, GRASS: 7, FOREST: 8, ROCK: 9, SNOW: 10, PLAYA: 11,
};

export const CLASS_INFO = [
  { key: "DEEP", name: "deep ocean", glyph: "≈" },
  { key: "OCEAN", name: "ocean", glyph: "~" },
  { key: "LAKE", name: "lake", glyph: "=" },
  { key: "RIVER", name: "river", glyph: "/" },
  { key: "BEACH", name: "beach", glyph: "." },
  { key: "SAND", name: "barrens", glyph: ":" },
  { key: "SCRUB", name: "scrub", glyph: "," },
  { key: "GRASS", name: "grass", glyph: '"' },
  { key: "FOREST", name: "forest", glyph: "T" },
  { key: "ROCK", name: "rock", glyph: "^" },
  { key: "SNOW", name: "snow", glyph: "*" },
  { key: "PLAYA", name: "playa", glyph: "_" },
];

export function metersAbove(h, sea) { return (h - sea) * METERS_SPAN; }

// Max elevation difference to a 4-neighbour, in metres per cell.
export function slopeM(elev, w, h, x, y) {
  const c = elev[y * w + x];
  let s = 0;
  if (x > 0) s = Math.max(s, Math.abs(c - elev[y * w + x - 1]));
  if (x < w - 1) s = Math.max(s, Math.abs(c - elev[y * w + x + 1]));
  if (y > 0) s = Math.max(s, Math.abs(c - elev[(y - 1) * w + x]));
  if (y < h - 1) s = Math.max(s, Math.abs(c - elev[(y + 1) * w + x]));
  return s * METERS_SPAN;
}

export function classify(p, elev, ocean, lake, playa, river, moist, w, h) {
  const n = w * h;
  const cls = new Uint8Array(n);
  const trees = new Uint8Array(n);
  const seed = p.seedInt;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const hm = metersAbove(elev[i], p.sea);

      // 1–3: water bodies
      if (ocean[i]) { cls[i] = hm < -p.deepM ? C.DEEP : C.OCEAN; continue; }
      if (lake[i]) { cls[i] = C.LAKE; continue; }
      if (river[i]) { cls[i] = C.RIVER; continue; }

      // 4: dry basin floor (an ephemeral wash may already have claimed it)
      if (playa[i]) { cls[i] = C.PLAYA; continue; }

      // 5: beach — low land touching the ocean
      if (hm < p.beachM) {
        let shore = false;
        for (let k = 0; k < 8 && !shore; k++) {
          const nx = x + DIRS8[k][0], ny = y + DIRS8[k][1];
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && ocean[ny * w + nx]) shore = true;
        }
        if (shore) { cls[i] = C.BEACH; continue; }
      }

      // 6: cliffs — too steep for soil, at any altitude
      if (slopeM(elev, w, h, x, y) > p.cliffSlopeM) { cls[i] = C.ROCK; continue; }

      // 7–8: altitude bands
      if (hm > p.snowM) { cls[i] = C.SNOW; continue; }
      if (hm > p.rockM) { cls[i] = C.ROCK; continue; }

      // 9–12: moisture bands
      const m = moist[i];
      if (m > p.mForest) cls[i] = C.FOREST;
      else if (m > p.mGrass) cls[i] = C.GRASS;
      else if (m > p.mScrub) cls[i] = C.SCRUB;
      else cls[i] = C.SAND;

      // Trees: vegetation classes below the treeline, density from moisture.
      if (hm < p.treelineM) {
        let prob = 0;
        if (cls[i] === C.FOREST) prob = 0.50 + 0.40 * m;
        else if (cls[i] === C.GRASS) prob = 0.10 * m;
        else if (cls[i] === C.SCRUB) prob = 0.025;
        prob *= p.treeMult;
        if (prob > 0 && hash01(seed, x, y, 777) < prob) trees[i] = 1;
      }
    }
  }
  return { cls, trees };
}

export function census(world) {
  const { cls, trees, w, h } = world;
  const n = w * h;
  const counts = new Array(CLASS_INFO.length).fill(0);
  let treeCount = 0;
  for (let i = 0; i < n; i++) {
    counts[cls[i]]++;
    if (trees[i]) treeCount++;
  }
  const water = counts[C.DEEP] + counts[C.OCEAN] + counts[C.LAKE] + counts[C.RIVER];
  return {
    counts,
    trees: treeCount,
    cells: n,
    waterFrac: water / n,
    riverCells: counts[C.RIVER],
    lakeCells: counts[C.LAKE],
  };
}
