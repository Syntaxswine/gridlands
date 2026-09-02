// Canvas renderer. The grid is painted into an ImageData at 1 px/cell —
// class colour, water-depth gradient, Lambertian hillshade, contour ticks,
// coast outline — then scaled up with smoothing off so cells stay crisp.
// Trees are drawn on top at screen scale with per-cell hashed jitter.

import { C } from "./classify.js";
import { metersAbove, METERS_SPAN } from "./classify.js";
import { hash01 } from "./rng.js";

const PAL = {
  [C.DEEP]: "#3a5866",
  [C.OCEAN]: "#547a87",
  [C.LAKE]: "#5c8792",
  [C.RIVER]: "#4f7f8e",
  [C.BEACH]: "#cfc19c",
  [C.SAND]: "#c9b891",
  [C.SCRUB]: "#aca678",
  [C.GRASS]: "#8f9d6e",
  [C.FOREST]: "#6f8c5c",
  [C.ROCK]: "#8f8779",
  [C.SNOW]: "#e9e6dd",
  [C.PLAYA]: "#ded6bd",
};

function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}
const RGB = Object.fromEntries(Object.entries(PAL).map(([k, v]) => [k, hex(v)]));

const CANOPY = "#4a6140";
const CANOPY_DK = "#3a4e33";

// Light from the NW, standard cartographic convention.
const LX = -0.62, LY = -0.62, LZ = 0.48;

export function render(world, canvas, view) {
  const { w, h, elev, cls, trees, p } = world;
  const cell = view.cell;
  canvas.width = w * cell;
  canvas.height = h * cell;

  const small = view._small ?? (view._small = document.createElement("canvas"));
  small.width = w; small.height = h;
  const sctx = small.getContext("2d");
  const img = sctx.createImageData(w, h);
  const d = img.data;

  const contourM = view.contourM; // 0 = off

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const k = cls[i];
      let [r, g, b] = RGB[k];
      const hm = metersAbove(elev[i], p.sea);

      if (k === C.DEEP || k === C.OCEAN) {
        const t = Math.min(1, Math.max(0, -hm / 600));
        const dc = RGB[C.DEEP], oc = RGB[C.OCEAN];
        r = oc[0] + (dc[0] - oc[0]) * t;
        g = oc[1] + (dc[1] - oc[1]) * t;
        b = oc[2] + (dc[2] - oc[2]) * t;
      } else if (k === C.LAKE) {
        const depth = (world.filled[i] - elev[i]) * METERS_SPAN;
        const t = Math.min(0.5, depth / 400);
        r *= 1 - t * 0.5; g *= 1 - t * 0.4; b *= 1 - t * 0.25;
      } else if (k === C.PLAYA) {
        // dry lakebed: dead flat — no hillshade bowl, no contour rings
      } else {
        // land: lift with altitude, then hillshade
        const lift = Math.min(1, Math.max(0, hm / 1500)) * 0.20;
        r += (242 - r) * lift; g += (239 - g) * lift; b += (230 - b) * lift;

        const xl = x > 0 ? elev[i - 1] : elev[i];
        const xr = x < w - 1 ? elev[i + 1] : elev[i];
        const yu = y > 0 ? elev[i - w] : elev[i];
        const yd = y < h - 1 ? elev[i + w] : elev[i];
        const dzdx = (xr - xl) * METERS_SPAN / (2 * 50);
        const dzdy = (yd - yu) * METERS_SPAN / (2 * 50);
        const len = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
        const dot = (-dzdx * LX + -dzdy * LY + LZ) / len;
        let shade = 0.72 + 0.55 * Math.max(0, dot);
        shade = Math.min(1.18, Math.max(0.62, shade));
        r *= shade; g *= shade; b *= shade;

        if (contourM > 0) {
          const band = Math.floor(hm / contourM);
          const bandR = x < w - 1 ? Math.floor(metersAbove(elev[i + 1], p.sea) / contourM) : band;
          const bandD = y < h - 1 ? Math.floor(metersAbove(elev[i + w], p.sea) / contourM) : band;
          if ((band !== bandR || band !== bandD) && hm > 0) {
            r *= 0.91; g *= 0.91; b *= 0.91;
          }
        }
      }

      // coast outline: water cell touching land
      if (k <= C.RIVER) {
        const landAdj =
          (x > 0 && cls[i - 1] > C.RIVER) || (x < w - 1 && cls[i + 1] > C.RIVER) ||
          (y > 0 && cls[i - w] > C.RIVER) || (y < h - 1 && cls[i + w] > C.RIVER);
        if (landAdj) { r *= 0.88; g *= 0.88; b *= 0.90; }
      }

      const o = i * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }

  sctx.putImageData(img, 0, 0);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, w, h, 0, 0, w * cell, h * cell);

  // trees at screen scale
  if (cell >= 3) {
    const seed = p.seedInt;
    const size = cell >= 5 ? 2 : 2;
    ctx.fillStyle = CANOPY;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!trees[i]) continue;
        const jx = (hash01(seed, x, y, 778) * (cell - size)) | 0;
        const jy = (hash01(seed, x, y, 779) * (cell - size)) | 0;
        ctx.fillStyle = hash01(seed, x, y, 780) < 0.5 ? CANOPY : CANOPY_DK;
        ctx.fillRect(x * cell + jx, y * cell + jy, size, size);
      }
    }
  }
}

export { PAL };
