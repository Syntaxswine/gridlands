// Moisture: a one-pass orographic sweep. A humidity front marches across the
// grid in the wind direction, picking up over water, raining out over land —
// more where the ground rises against the wind (orographic lift), leaving a
// rain shadow behind ridges. The sweep is blended with a noise field for
// texture and percentile-normalised over land.
//
// Cells are processed in ascending (x·dx + y·dy): for any of the 8 wind
// directions, a cell's upwind neighbour has a strictly smaller key, so the
// front is always propagated from finished cells.

import { fbm } from "./noise.js";

export const WINDS = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
export const WIND_NAMES = ["→E", "→SE", "→S", "→SW", "→W", "→NW", "→N", "→NE"];

export function orographicMoisture(p, filled, ocean, lake, w, h) {
  const n = w * h;
  const [dx, dy] = WINDS[p.windIdx];
  const seed = p.seedInt;

  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const key = (i) => (i % w) * dx + ((i / w) | 0) * dy;
  order.sort((a, b) => key(a) - key(b));

  const hum = new Float32Array(n);
  const moist = new Float32Array(n);

  for (let oi = 0; oi < n; oi++) {
    const c = order[oi];
    const x = c % w, y = (c / w) | 0;
    const ux = x - dx, uy = y - dy;
    const inMap = ux >= 0 && uy >= 0 && ux < w && uy < h;
    const u = uy * w + ux;
    let air = inMap ? hum[u] : 0.55; // fronts enter the map half-charged

    if (ocean[c] || lake[c]) {
      air = Math.min(1, air + (ocean[c] ? 0.22 : 0.10));
      moist[c] = 0.85;
    } else {
      const upElev = inMap ? filled[u] : filled[c];
      const uplift = Math.max(0, filled[c] - upElev);
      const rain = air * (0.015 + uplift * 14);
      moist[c] = rain;
      air = Math.max(0, air - rain - 0.003);
    }
    hum[c] = air;
  }

  // Percentile-normalise over land only, then blend in noise + bias.
  const landVals = [];
  for (let i = 0; i < n; i++) if (!ocean[i] && !lake[i]) landVals.push(moist[i]);
  if (landVals.length > 16) {
    landVals.sort((a, b) => a - b);
    const lo = landVals[Math.floor(0.05 * (landVals.length - 1))];
    const hi = landVals[Math.floor(0.95 * (landVals.length - 1))];
    const span = Math.max(1e-9, hi - lo);
    const inv = 1 / p.noiseScale;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (ocean[i] || lake[i]) continue;
        let m = (moist[i] - lo) / span;
        const tex = fbm(seed, 500, x * inv * 1.8, y * inv * 1.8, 4) + 0.5;
        m = 0.72 * m + 0.28 * tex + p.moistureBias;
        moist[i] = m < 0 ? 0 : m > 1 ? 1 : m;
      }
    }
  }
  return moist;
}

// After rivers exist: green the corridors. Applied in place.
export function riparianBonus(moist, distWater, ocean, lake) {
  for (let i = 0; i < moist.length; i++) {
    if (ocean[i] || lake[i]) continue;
    const d = distWater[i];
    if (d > 0) {
      const m = moist[i] + 0.35 * Math.exp(-d / 5);
      moist[i] = m > 1 ? 1 : m;
    }
  }
}
