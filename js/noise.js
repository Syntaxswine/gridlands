// Gradient (Perlin-style) lattice noise + fBm + ridged variant.
// Gradients come from a fixed 16-direction table indexed by hash01, so the
// field is fully determined by (seed, salt) with no trig at runtime.

import { hash01 } from "./rng.js";

// 16 unit vectors at 22.5° steps, hardcoded so output is table-exact.
const GRAD = [
  [1, 0],
  [0.9238795325112867, 0.3826834323650898],
  [0.7071067811865476, 0.7071067811865476],
  [0.3826834323650898, 0.9238795325112867],
  [0, 1],
  [-0.3826834323650898, 0.9238795325112867],
  [-0.7071067811865476, 0.7071067811865476],
  [-0.9238795325112867, 0.3826834323650898],
  [-1, 0],
  [-0.9238795325112867, -0.3826834323650898],
  [-0.7071067811865476, -0.7071067811865476],
  [-0.3826834323650898, -0.9238795325112867],
  [0, -1],
  [0.3826834323650898, -0.9238795325112867],
  [0.7071067811865476, -0.7071067811865476],
  [0.9238795325112867, -0.3826834323650898],
];

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + (b - a) * t; }

function dotg(seed, salt, ix, iy, dx, dy) {
  const g = GRAD[(hash01(seed, ix, iy, salt) * 16) | 0];
  return g[0] * dx + g[1] * dy;
}

// Single octave, roughly [-0.7, 0.7].
export function perlin2(seed, salt, x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const n00 = dotg(seed, salt, ix, iy, fx, fy);
  const n10 = dotg(seed, salt, ix + 1, iy, fx - 1, fy);
  const n01 = dotg(seed, salt, ix, iy + 1, fx, fy - 1);
  const n11 = dotg(seed, salt, ix + 1, iy + 1, fx - 1, fy - 1);
  const u = fade(fx), v = fade(fy);
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
}

// Fractal Brownian motion, roughly [-0.75, 0.75].
export function fbm(seed, salt, x, y, oct, lac = 2.0, gain = 0.5) {
  let a = 0.5, f = 1, s = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += a * perlin2(seed, salt + i * 101, x * f, y * f);
    norm += a;
    a *= gain;
    f *= lac;
  }
  return s / norm;
}

// Ridged multifractal-ish: sharp crests, good for mountain chains.
export function ridged(seed, salt, x, y, oct) {
  let a = 0.5, f = 1, s = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(perlin2(seed, salt + i * 131, x * f, y * f)) * 1.9;
    s += a * n;
    norm += a;
    a *= 0.5;
    f *= 2.05;
  }
  return s / norm;
}
