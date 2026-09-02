// Pipeline: heightmap → priority-flood fill → ocean/lakes → orographic
// moisture → rain-weighted flow accumulation → rivers → riparian greening →
// rule-table classification + trees → census + fingerprint.
//
// Moisture is computed before rivers on purpose: rainfall drives the flow
// accumulation (wet uplands spawn more rivers), and the riparian bonus is
// added back after rivers exist. One pass each way, no fixpoint needed.

import { cyrb128, fnv1a } from "./rng.js";
import {
  priorityFill, oceanMask, lakeMask, splitPlayas, flowDirs, accumulate, waterDistance,
} from "./hydrology.js";
import { buildHeight } from "./heightmap.js";
import { orographicMoisture, riparianBonus } from "./moisture.js";
import { classify, census, C } from "./classify.js";

export const DEFAULTS = {
  preset: "continent",
  seed: "first-light-42",
  width: 200,
  height: 150,
  noiseScale: 70,
  octaves: 5,
  warp: 0.45,
  ridgeMix: 0.30,
  maskType: "none",
  maskStrength: 0.55,
  sea: 0.42,
  reliefExp: 1.15,
  terraceSteps: 0,
  terraceMix: 0,
  moistureBias: 0,
  treeMult: 1.0,
  riverThresh: 220,
  windIdx: -1, // -1 = derive from seed
  // rule thresholds (metres / moisture units) — mirrored in the RULES panel
  deepM: 150,
  beachM: 8,
  // Per-cell elevation diffs at 50 m sampling carry unresolved noise octaves
  // that read as slope, so the cliff threshold is calibrated to the mesh,
  // not to real-world cliff grades (55 m/cell classified 60% of land as rock).
  cliffSlopeM: 95,
  snowM: 1150,
  rockM: 950,
  treelineM: 900,
  minLakeDepth: 0.004, // ≈10 m
  playaWet: 0.30, // a basin with drier shores than this may dry into a playa…
  playaInflow: 3.0, // …unless its inflow ≥ this × its area (river-fed lakes)
  mForest: 0.55,
  mGrass: 0.30,
  mScrub: 0.16,
};

// waterFrac bounds are invariant-suite expectations, measured at size M over
// seeds {first-light-42, alpha, bravo, charlie} — generous on purpose.
export const PRESETS = {
  continent: {
    label: "continent",
    params: { maskType: "none", sea: 0.38, warp: 0.50, ridgeMix: 0.35, noiseScale: 85, reliefExp: 1.40, riverThresh: 180 },
    waterFrac: [0.15, 0.75],
  },
  island: {
    label: "island",
    params: { maskType: "island", maskStrength: 0.55, sea: 0.50, noiseScale: 60 },
    waterFrac: [0.25, 0.85],
  },
  archipelago: {
    label: "archipelago",
    params: { maskType: "island", maskStrength: 0.35, sea: 0.60, noiseScale: 42, warp: 0.55, reliefExp: 1.0 },
    waterFrac: [0.45, 0.97],
  },
  highlands: {
    label: "highlands",
    params: { sea: 0.30, ridgeMix: 0.60, warp: 0.65, reliefExp: 0.85, noiseScale: 75, snowM: 900, rockM: 780, treelineM: 720, riverThresh: 160, minLakeDepth: 0.016 },
    waterFrac: [0.03, 0.60],
  },
  wetlands: {
    label: "wetlands",
    params: { sea: 0.46, ridgeMix: 0.15, reliefExp: 1.60, noiseScale: 90, warp: 0.30, moistureBias: 0.18, riverThresh: 120 },
    waterFrac: [0.25, 0.85],
  },
  badlands: {
    label: "badlands",
    params: { sea: 0.22, ridgeMix: 0.55, warp: 0.70, noiseScale: 65, terraceSteps: 7, terraceMix: 0.55, moistureBias: -0.22, treeMult: 0.4 },
    waterFrac: [0.02, 0.55],
  },
};

export function makeParams(overrides = {}) {
  const presetName = overrides.preset ?? DEFAULTS.preset;
  const preset = PRESETS[presetName] ?? PRESETS.continent;
  const p = { ...DEFAULTS, ...preset.params, ...overrides, preset: presetName };
  p.seedInt = cyrb128(String(p.seed))[0];
  if (p.windIdx == null || p.windIdx < 0) p.windIdx = p.seedInt % 8;
  return p;
}

export function generate(overrides = {}) {
  const p = overrides.seedInt ? overrides : makeParams(overrides);
  const t0 = (globalThis.performance?.now() ?? Date.now());
  const { width: w, height: h } = p;
  const n = w * h;

  const elev = buildHeight(p);
  const { filled, order } = priorityFill(elev, w, h);
  const ocean = oceanMask(elev, w, h, p.sea);
  const basins = lakeMask(elev, filled, ocean, p.minLakeDepth);

  // Moisture sees every basin as wet (playas do flood seasonally); the
  // lake/playa split needs moisture AND inflow, so it comes after both.
  const moist = orographicMoisture(p, filled, ocean, basins, w, h);

  // Rain field normalised so acc is roughly "cells of catchment".
  const rain = new Float32Array(n);
  for (let i = 0; i < n; i++) rain[i] = 0.3 + 1.4 * moist[i];

  const dir = flowDirs(filled, w, h, ocean, p.seedInt);
  const acc = accumulate(dir, rain, order, ocean);

  const { lake, playa } = splitPlayas(
    basins, acc, moist, ocean, w, h, p.playaWet, p.playaInflow);

  // No channel across open water or a playa: a wash entering the pan spreads
  // into sheetflow and dies there (its catchment still passes through acc).
  const river = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!ocean[i] && !lake[i] && !playa[i] && acc[i] >= p.riverThresh) river[i] = 1;
  }

  const isWater = new Uint8Array(n);
  for (let i = 0; i < n; i++) isWater[i] = (ocean[i] | lake[i] | river[i]);
  const distWater = waterDistance(isWater, w, h);
  riparianBonus(moist, distWater, ocean, lake);

  const { cls, trees } = classify(p, elev, ocean, lake, playa, river, moist, w, h);

  const world = {
    p, w, h, elev, filled, order, ocean, lake, playa, river, dir, acc, moist,
    distWater, cls, trees,
  };
  world.census = census(world);
  world.mapId = fnv1a([elev, moist, acc, cls, trees]);
  world.genMs = (globalThis.performance?.now() ?? Date.now()) - t0;
  return world;
}

export { C };
