// Elevation field: domain-warped fBm blended with ridged noise, an optional
// large-scale mask (island bowl / coastal gradient), percentile-normalised to
// [0, 1], then reshaped by a relief exponent (>1 favours lowlands, <1 lifts
// the interior). Badlands-style terracing is applied last so the terraces cut
// the final hypsometry, not the raw noise.

import { fbm, ridged } from "./noise.js";

function percentileNormalize(arr, lo = 0.01, hi = 0.99) {
  const sorted = Float32Array.from(arr).sort();
  const a = sorted[Math.floor(lo * (sorted.length - 1))];
  const b = sorted[Math.floor(hi * (sorted.length - 1))];
  const span = Math.max(1e-9, b - a);
  for (let i = 0; i < arr.length; i++) {
    const v = (arr[i] - a) / span;
    arr[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
}

export function buildHeight(p) {
  const { width: w, height: h, seedInt: seed } = p;
  const elev = new Float32Array(w * h);
  const inv = 1 / p.noiseScale;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx = x * inv, ny = y * inv;

      if (p.warp > 0) {
        const wx = fbm(seed, 900, nx * 0.6, ny * 0.6, 3);
        const wy = fbm(seed, 901, nx * 0.6 + 7.31, ny * 0.6 + 2.97, 3);
        nx += wx * p.warp * 1.7;
        ny += wy * p.warp * 1.7;
      }

      const base = fbm(seed, 100, nx, ny, p.octaves);
      const rid = ridged(seed, 200, nx * 0.9, ny * 0.9, Math.max(3, p.octaves - 2));
      let v = (1 - p.ridgeMix) * base + p.ridgeMix * rid * 0.8;

      if (p.maskType === "island") {
        const dx = (x - w * 0.5) / (w * 0.5);
        const dy = (y - h * 0.5) / (h * 0.5);
        const d = Math.sqrt(dx * dx + dy * dy);
        const jit = fbm(seed, 300, nx * 0.55, ny * 0.55, 3) * 0.5;
        let m = 0.72 - d + jit;
        m = Math.max(-0.6, Math.min(0.35, m));
        v += m * p.maskStrength;
      } else if (p.maskType === "coast") {
        const sgn = (seed & 1) ? 1 : -1;
        v += sgn * ((x / w) - 0.5) * 0.9 * p.maskStrength;
      }

      elev[y * w + x] = v;
    }
  }

  percentileNormalize(elev);

  for (let i = 0; i < elev.length; i++) {
    let v = Math.pow(elev[i], p.reliefExp);
    if (p.terraceSteps > 0) {
      const t = Math.round(v * p.terraceSteps) / p.terraceSteps;
      v = v + (t - v) * p.terraceMix;
    }
    elev[i] = v;
  }

  return elev;
}
