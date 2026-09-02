// Deterministic randomness. Everything the generator draws flows from a seed
// string through these functions — no Math.random anywhere in the pipeline.
//
// Two kinds of draw:
//  - sfc32: a sequential stream (rarely used; parameter jitter only)
//  - hash01: per-cell draws keyed by cell identity (x, y, salt), never by
//    iteration order — so a cell's tree/jitter draw survives any refactor
//    of loop order.

export function cyrb128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export function sfc32(a, b, c, d) {
  return function () {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

function mix(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

// Order-independent per-cell hash in [0, 1).
export function hash01(seed, x, y, salt) {
  return mix(
    (seed | 0) ^
    Math.imul(x | 0, 0x9e3779b1) ^
    Math.imul(y | 0, 0x85ebca77) ^
    Math.imul(salt | 0, 0xc2b2ae3d)
  ) / 4294967296;
}

// FNV-1a fingerprint over typed arrays — the "map id". Same seed + params
// must reproduce the same id (per JS engine; float math is deterministic
// within an engine).
export function fnv1a(arrs) {
  let h = 0x811c9dc5;
  for (const a of arrs) {
    const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < b.length; i++) {
      h ^= b[i];
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
