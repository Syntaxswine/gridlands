// 3D interchange exports. Two artefacts, both deterministic per map id:
//
//   terrainJson(world) — "gridlands-terrain" v1: bed elevation and standing-
//     water surface in metres vs mean sea level (float32, base64), classes as
//     glyph rows, tree mask, per-cell Manning n. The canonical hand-off for
//     other tools; docs/TERRAIN-FORMAT.md is the spec and the water-simulator
//     adapter in docs/PROPOSAL-WATER-IMPORT.md consumes exactly this.
//
//   buildGlb(world) — a binary glTF 2.0 heightmesh (terrain + translucent
//     water surface, per-vertex class colours, metres, +X east / +Y up /
//     north at -Z) that engines and viewers open directly.
//
// DOM-free on purpose: node (tools/export.mjs, tools/check.mjs) and the
// browser buttons share these code paths byte-for-byte.

import { b64encode } from "./b64.js";
import { C, CLASS_INFO, METERS_SPAN, CELL_M } from "./classify.js";
import { DIRS8 } from "./hydrology.js";
import { PAL } from "./render.js";

export const FORMAT_VERSION = 1;

// Little-endian float32 layout is what the spec promises; refuse loudly on
// exotic hosts rather than emit silently byte-swapped terrain.
(() => {
  const probe = new Uint8Array(new Float32Array([1]).buffer);
  if (probe[3] !== 0x3f) throw new Error("gridlands export requires a little-endian host");
})();

// Manning's n by class, Chow-style representative values [s/m^(1/3)].
// Submerged classes describe the bed material a flood would run over.
export const MANNING_BY_CLASS = {
  [C.DEEP]: 0.025, [C.OCEAN]: 0.025, [C.LAKE]: 0.025, [C.RIVER]: 0.030,
  [C.BEACH]: 0.025, [C.SAND]: 0.030, [C.SCRUB]: 0.050, [C.GRASS]: 0.035,
  [C.FOREST]: 0.100, [C.ROCK]: 0.040, [C.SNOW]: 0.030, [C.PLAYA]: 0.020,
};

const f32b64 = (f32) => b64encode(new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength));

export function metersElev(world) {
  const { elev, p } = world;
  const bedM = new Float32Array(elev.length);
  for (let i = 0; i < elev.length; i++) bedM[i] = (elev[i] - p.sea) * METERS_SPAN;
  return bedM;
}

// Standing-water surface in metres vs MSL: 0 over ocean, the spill level over
// each lake (flattened to the component MINIMUM of the filled surface — the
// outlet's level — so an imported lake is exactly at rest; the epsilon
// drainage grade inside priority-flood is a solver artefact, not water).
// Dry land (playas and rivers included) carries surface == bed, so
// h = max(0, surface - bed) is zero there without sentinel values.
export function buildSurface(world, bedM) {
  const { w, h, lake, ocean, filled, p } = world;
  const n = w * h;
  const surf = new Float32Array(bedM);
  for (let i = 0; i < n; i++) if (ocean[i]) surf[i] = 0;

  const seen = new Uint8Array(n);
  const comp = [];
  for (let i = 0; i < n; i++) {
    if (!lake[i] || seen[i]) continue;
    comp.length = 0;
    let level = Infinity;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      if (filled[c] < level) level = filled[c];
      const cx = c % w, cy = (c / w) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DIRS8[k][0], ny = cy + DIRS8[k][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nb = ny * w + nx;
        if (lake[nb] && !seen[nb]) { seen[nb] = 1; stack.push(nb); }
      }
    }
    const levelM = Math.fround((level - p.sea) * METERS_SPAN);
    for (const c of comp) surf[c] = levelM;
  }
  return surf;
}

export function terrainJson(world) {
  const { w, h, cls, trees, p, census, mapId } = world;
  const n = w * h;

  const bedM = metersElev(world);
  const surfaceM = buildSurface(world, bedM);

  const manning = new Float32Array(n);
  for (let i = 0; i < n; i++) manning[i] = MANNING_BY_CLASS[cls[i]];

  const classRows = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) row += CLASS_INFO[cls[y * w + x]].glyph;
    classRows.push(row);
  }

  const legend = {};
  for (let k = 0; k < CLASS_INFO.length; k++) {
    legend[CLASS_INFO[k].glyph] = {
      key: CLASS_INFO[k].key, name: CLASS_INFO[k].name,
      color: PAL[k], manning: MANNING_BY_CLASS[k],
    };
  }

  let landManning = 0, landCells = 0, minBed = Infinity, maxBed = -Infinity;
  for (let i = 0; i < n; i++) {
    if (bedM[i] < minBed) minBed = bedM[i];
    if (bedM[i] > maxBed) maxBed = bedM[i];
    if (surfaceM[i] === bedM[i]) { landManning += manning[i]; landCells++; }
  }

  const doc = {
    format: "gridlands-terrain",
    version: FORMAT_VERSION,
    meta: {
      tool: "gridlands",
      mapId,
      preset: p.preset,
      seed: p.seed,
      spec: "docs/TERRAIN-FORMAT.md @ https://github.com/Syntaxswine/gridlands",
    },
    grid: {
      width: w, height: h, cellMeters: CELL_M,
      rowOrder: "north-first",
      note: "row 0 = north edge; index = row*width + col; cell centre at ((col+0.5)*cellMeters, (row+0.5)*cellMeters) from the NW corner",
    },
    datum: { verticalUnit: "m", zero: "mean sea level", bedPositiveUp: true },
    layers: {
      bedM: { encoding: "b64f32le", data: f32b64(bedM) },
      surfaceM: {
        encoding: "b64f32le",
        note: "standing water surface; equals bedM where dry, 0 over ocean, spill level over lakes (exactly constant per lake)",
        data: f32b64(surfaceM),
      },
      manningN: { encoding: "b64f32le", note: "Chow-style, from class", data: f32b64(manning) },
      class: { encoding: "glyph-rows", legend, rows: classRows },
      trees: { encoding: "b64u8", note: "1 = tree in cell", data: b64encode(trees) },
    },
    stats: {
      waterFrac: census.waterFrac,
      trees: census.trees,
      minBedM: minBed,
      maxBedM: maxBed,
      suggestedManningScalar: landCells ? +(landManning / landCells).toFixed(4) : 0.03,
    },
  };
  return JSON.stringify(doc);
}

// ---- binary glTF ------------------------------------------------------

function hexRgb(hx) {
  return [parseInt(hx.slice(1, 3), 16), parseInt(hx.slice(3, 5), 16), parseInt(hx.slice(5, 7), 16)];
}

// Terrain vertices sit at cell centres; water quads span whole wet cells at
// the standing surface, so shorelines resolve where the plane meets the
// terrain triangles. Geographic sanity: +X east, +Y up, row direction +Z, so
// north is -Z and east x north = up (right-handed, map not mirrored).
export function buildGlb(world) {
  const { w, h, cls, ocean, lake } = world;
  const bedM = metersElev(world);
  const surfaceM = buildSurface(world, bedM);

  const nT = w * h;
  const pos = new Float32Array(nT * 3);
  const col = new Uint8Array(nT * 3);
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const px = (x + 0.5) * CELL_M, py = bedM[i], pz = (y + 0.5) * CELL_M;
      pos[i * 3] = px; pos[i * 3 + 1] = py; pos[i * 3 + 2] = pz;
      if (px < mn[0]) mn[0] = px; if (px > mx[0]) mx[0] = px;
      if (py < mn[1]) mn[1] = py; if (py > mx[1]) mx[1] = py;
      if (pz < mn[2]) mn[2] = pz; if (pz > mx[2]) mx[2] = pz;
      const [r, g, b] = hexRgb(PAL[cls[i]]);
      col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b;
    }
  }
  const tIdx = new Uint32Array((w - 1) * (h - 1) * 6);
  let ti = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const a = y * w + x, b = a + 1, c = a + w, d = a + w + 1;
      tIdx[ti++] = a; tIdx[ti++] = d; tIdx[ti++] = b;
      tIdx[ti++] = a; tIdx[ti++] = c; tIdx[ti++] = d;
    }
  }

  // water: one quad per wet cell
  let wet = 0;
  for (let i = 0; i < nT; i++) if (ocean[i] | lake[i]) wet++;
  const wPos = new Float32Array(wet * 4 * 3);
  const wCol = new Uint8Array(wet * 4 * 3);
  const wIdx = new Uint32Array(wet * 6);
  let wmn = [Infinity, Infinity, Infinity], wmx = [-Infinity, -Infinity, -Infinity];
  let v = 0, q = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!(ocean[i] | lake[i])) continue;
      const s = surfaceM[i];
      const x0 = x * CELL_M, x1 = x0 + CELL_M, z0 = y * CELL_M, z1 = z0 + CELL_M;
      const corners = [[x0, z0], [x1, z0], [x0, z1], [x1, z1]];
      const [r, g, b] = hexRgb(PAL[lake[i] ? C.LAKE : C.OCEAN]);
      for (const [cx, cz] of corners) {
        wPos[v * 3] = cx; wPos[v * 3 + 1] = s; wPos[v * 3 + 2] = cz;
        wCol[v * 3] = r; wCol[v * 3 + 1] = g; wCol[v * 3 + 2] = b;
        if (cx < wmn[0]) wmn[0] = cx; if (cx > wmx[0]) wmx[0] = cx;
        if (s < wmn[1]) wmn[1] = s; if (s > wmx[1]) wmx[1] = s;
        if (cz < wmn[2]) wmn[2] = cz; if (cz > wmx[2]) wmx[2] = cz;
        v++;
      }
      const base = v - 4;
      wIdx[q * 6] = base; wIdx[q * 6 + 1] = base + 3; wIdx[q * 6 + 2] = base + 1;
      wIdx[q * 6 + 3] = base; wIdx[q * 6 + 4] = base + 2; wIdx[q * 6 + 5] = base + 3;
      q++;
    }
  }

  // pack the BIN chunk, 4-aligned views
  const parts = [
    new Uint8Array(pos.buffer), col, new Uint8Array(tIdx.buffer),
    new Uint8Array(wPos.buffer), wCol, new Uint8Array(wIdx.buffer),
  ];
  const offsets = [];
  let off = 0;
  for (const pt of parts) {
    offsets.push(off);
    off += pt.byteLength;
    off = (off + 3) & ~3;
  }
  const bin = new Uint8Array(off);
  parts.forEach((pt, k) => bin.set(pt, offsets[k]));

  const bufferViews = parts.map((pt, k) => ({ buffer: 0, byteOffset: offsets[k], byteLength: pt.byteLength }));
  const accessors = [
    { bufferView: 0, componentType: 5126, count: nT, type: "VEC3", min: mn, max: mx },
    { bufferView: 1, componentType: 5121, count: nT, type: "VEC3", normalized: true },
    { bufferView: 2, componentType: 5125, count: tIdx.length, type: "SCALAR" },
    { bufferView: 3, componentType: 5126, count: wet * 4, type: "VEC3", min: wet ? wmn : [0, 0, 0], max: wet ? wmx : [0, 0, 0] },
    { bufferView: 4, componentType: 5121, count: wet * 4, type: "VEC3", normalized: true },
    { bufferView: 5, componentType: 5125, count: wIdx.length, type: "SCALAR" },
  ];

  const primitives = [
    { attributes: { POSITION: 0, COLOR_0: 1 }, indices: 2, material: 0 },
  ];
  if (wet > 0) primitives.push({ attributes: { POSITION: 3, COLOR_0: 4 }, indices: 5, material: 1 });

  const gltf = {
    asset: { version: "2.0", generator: `gridlands v${FORMAT_VERSION}` },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: `gridlands-${world.p.preset}-${world.p.seed}` }],
    meshes: [{ primitives }],
    materials: [
      {
        name: "terrain", doubleSided: true,
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
      },
      {
        name: "water", doubleSided: true, alphaMode: "BLEND",
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.62], metallicFactor: 0, roughnessFactor: 0.4 },
      },
    ],
    bufferViews,
    accessors,
    buffers: [{ byteLength: bin.byteLength }],
  };

  const enc = new TextEncoder();
  let jsonBytes = enc.encode(JSON.stringify(gltf));
  const jsonPad = (4 - (jsonBytes.length & 3)) & 3;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }

  const total = 12 + 8 + jsonBytes.length + 8 + bin.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);           // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);          // 'JSON'
  out.set(jsonBytes, 20);
  const binAt = 20 + jsonBytes.length;
  dv.setUint32(binAt, bin.byteLength, true);
  dv.setUint32(binAt + 4, 0x004e4942, true);   // 'BIN\0'
  out.set(bin, binAt + 8);
  return out;
}
