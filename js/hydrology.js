// Hydrology on the grid, done the way DEM processing actually does it:
//
//  1. priorityFill — priority-flood + epsilon (Barnes et al. 2014): raises
//     every depression to its spill level plus a tiny per-step gradient, so
//     every interior cell has a strictly descending path to the map edge.
//  2. oceanMask — cells below sea level connected to the edge (raw elevation;
//     a below-sea basin that never touches the edge is a lake, not ocean).
//  3. lakeMask — depression cells (filled − elev > minDepth) that aren't ocean.
//  4. flowDirs — D8 steepest descent on the FILLED surface.
//  5. accumulate — rain-weighted flow accumulation, upstream before
//     downstream via the priority-flood pop order.
//
// Rivers fall out of accumulate: any non-ocean, non-lake cell whose catchment
// exceeds a threshold. Because lakes are filled with an epsilon gradient
// toward their outlet, rivers route into a lake and re-emerge at its spill
// point with the whole lake catchment behind them — no special casing.

import { hash01 } from "./rng.js";

export const DIRS8 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];
export const DIST8 = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

// Small enough that a chain across the whole map (< ~500 steps) stays well
// under minLakeDepth; large enough to survive float32 rounding near 1.0.
const EPS = 1e-6;

export function priorityFill(elev, w, h) {
  const n = w * h;
  const filled = new Float32Array(elev);
  const visited = new Uint8Array(n);
  const heap = new Int32Array(n);
  let hs = 0;

  function push(i) {
    heap[hs++] = i;
    let c = hs - 1;
    while (c > 0) {
      const par = (c - 1) >> 1;
      if (filled[heap[par]] <= filled[heap[c]]) break;
      const t = heap[par]; heap[par] = heap[c]; heap[c] = t;
      c = par;
    }
  }
  function pop() {
    const top = heap[0];
    heap[0] = heap[--hs];
    let c = 0;
    for (;;) {
      const l = 2 * c + 1, r = l + 1;
      let m = c;
      if (l < hs && filled[heap[l]] < filled[heap[m]]) m = l;
      if (r < hs && filled[heap[r]] < filled[heap[m]]) m = r;
      if (m === c) break;
      const t = heap[m]; heap[m] = heap[c]; heap[c] = t;
      c = m;
    }
    return top;
  }

  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const i = y * w + x;
      if (!visited[i]) { visited[i] = 1; push(i); }
    }
  }
  for (let y = 1; y < h - 1; y++) {
    for (const x of [0, w - 1]) {
      const i = y * w + x;
      if (!visited[i]) { visited[i] = 1; push(i); }
    }
  }

  // Pop order is non-decreasing in filled[], recorded for accumulate().
  const order = new Int32Array(n);
  let oi = 0;
  while (hs > 0) {
    const c = pop();
    order[oi++] = c;
    const cx = c % w, cy = (c / w) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = cx + DIRS8[k][0], ny = cy + DIRS8[k][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nb = ny * w + nx;
      if (visited[nb]) continue;
      visited[nb] = 1;
      const raise = filled[c] + EPS;
      filled[nb] = elev[nb] > raise ? elev[nb] : raise;
      push(nb);
    }
  }

  return { filled, order };
}

export function oceanMask(elev, w, h, sea) {
  const n = w * h;
  const ocean = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;

  const trySeed = (i) => {
    if (!ocean[i] && elev[i] < sea) { ocean[i] = 1; queue[qt++] = i; }
  };
  for (let x = 0; x < w; x++) { trySeed(x); trySeed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { trySeed(y * w); trySeed(y * w + w - 1); }

  while (qh < qt) {
    const c = queue[qh++];
    const cx = c % w, cy = (c / w) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = cx + DIRS8[k][0], ny = cy + DIRS8[k][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nb = ny * w + nx;
      if (!ocean[nb] && elev[nb] < sea) { ocean[nb] = 1; queue[qt++] = nb; }
    }
  }
  return ocean;
}

export function lakeMask(elev, filled, ocean, minDepth) {
  const lake = new Uint8Array(elev.length);
  for (let i = 0; i < elev.length; i++) {
    if (!ocean[i] && filled[i] - elev[i] > minDepth) lake[i] = 1;
  }
  return lake;
}

// Closed basins only hold water where the climate lets them. A lake persists
// when inflow beats evaporation over its area; otherwise the basin dries to a
// playa (flat lakebed), the Great Basin way. Inflow is read straight off the
// flow accumulation (max acc inside the basin ≈ everything its catchment
// delivers, rain-weighted), evaporation demand scales with basin area, and
// the arid test uses shoreline moisture — so a wet-shored tarn always keeps
// its water, and an arid basin fed by a big mountain river stays a lake
// (Pyramid Lake) while a starved pan dries (Death Valley at map scale).
// Splits the basin mask into wet lakes and playas per connected component.
export function splitPlayas(basins, acc, moist, ocean, w, h, playaWet, playaInflow) {
  const n = w * h;
  const lake = new Uint8Array(n);
  const playa = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const comp = [];

  for (let i = 0; i < n; i++) {
    if (!basins[i] || seen[i]) continue;
    comp.length = 0;
    let shoreSum = 0, shoreCount = 0, inflow = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      if (acc[c] > inflow) inflow = acc[c];
      const cx = c % w, cy = (c / w) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DIRS8[k][0], ny = cy + DIRS8[k][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nb = ny * w + nx;
        if (basins[nb]) {
          if (!seen[nb]) { seen[nb] = 1; stack.push(nb); }
        } else if (!ocean[nb]) {
          shoreSum += moist[nb];
          shoreCount++;
        }
      }
    }
    // A basin with no land shore (ringed by ocean) stays a lake.
    const arid = shoreCount > 0 && shoreSum / shoreCount < playaWet;
    const starved = inflow < playaInflow * comp.length;
    const mask = (arid && starved) ? playa : lake;
    for (const c of comp) mask[c] = 1;
  }
  return { lake, playa };
}

// dir[i] = index of the steepest-descent neighbour on the filled surface,
// or -1 for ocean cells and border outlets (water leaves the map there).
//
// On epsilon-graded flats (filled lake floors, terrace treads) every descent
// is EPS-scale and pure steepest-descent beelines dead straight at the
// outlet; there, any strictly-descending neighbour is hydrologically
// equivalent, so the choice is a per-cell hash — washes wander like washes.
// Real slopes (≥ FLAT_S) keep exact steepest descent.
const FLAT_S = 1e-4;

export function flowDirs(filled, w, h, ocean, seed) {
  const n = w * h;
  const dir = new Int32Array(n).fill(-1);
  const cand = new Int32Array(8);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = y * w + x;
      if (ocean[c]) continue;
      let best = -1, bestS = 0, nc = 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + DIRS8[k][0], ny = y + DIRS8[k][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nb = ny * w + nx;
        const s = (filled[c] - filled[nb]) / DIST8[k];
        if (s > 0) cand[nc++] = nb;
        if (s > bestS) { bestS = s; best = nb; }
      }
      dir[c] = (best >= 0 && bestS < FLAT_S && nc > 1)
        ? cand[(hash01(seed, x, y, 555) * nc) | 0]
        : best;
    }
  }
  return dir;
}

// Upstream-before-downstream traversal: walk the pop order backwards
// (descending filled), so every cell is finished before the cell it drains to.
export function accumulate(dir, rain, order, ocean) {
  const n = order.length;
  const acc = new Float32Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const c = order[i];
    if (ocean[c]) continue;
    acc[c] += rain[c];
    const d = dir[c];
    if (d >= 0) acc[d] += acc[c];
  }
  return acc;
}

// 8-neighbour BFS distance (in cells) from any water cell; used for the
// riparian moisture bonus and the inspector.
export function waterDistance(isWater, w, h) {
  const n = w * h;
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  for (let i = 0; i < n; i++) {
    if (isWater[i]) { dist[i] = 0; queue[qt++] = i; }
  }
  while (qh < qt) {
    const c = queue[qh++];
    const cx = c % w, cy = (c / w) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = cx + DIRS8[k][0], ny = cy + DIRS8[k][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nb = ny * w + nx;
      if (dist[nb] < 0) { dist[nb] = dist[c] + 1; queue[qt++] = nb; }
    }
  }
  return dist;
}
