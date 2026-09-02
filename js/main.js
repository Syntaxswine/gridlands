// UI wiring. All generation state lives in (preset, seed, size, overrides);
// sliders write overrides, switching preset clears them (the preset's own
// dial positions are the point of a preset).

import { generate, makeParams, PRESETS } from "./generate.js";
import { render, PAL } from "./render.js";
import { C, CLASS_INFO, metersAbove, METERS_SPAN } from "./classify.js";
import { WIND_NAMES } from "./moisture.js";

const $ = (id) => document.getElementById(id);

const SIZES = { S: [132, 96, 6], M: [200, 150, 4], L: [276, 204, 3] };
const SLIDERS = ["sea", "reliefExp", "ridgeMix", "warp", "moistureBias", "treeMult", "riverThresh"];

const ADJ = ["amber", "basalt", "cinder", "dune", "elder", "fen", "gorse", "heath",
  "iron", "juniper", "karst", "loam", "moss", "north", "ochre", "pine",
  "quartz", "reed", "shale", "tarn", "umber", "vale", "wren", "yew"];
const NOUN = ["fold", "ridge", "hollow", "spur", "bight", "moor", "crag", "delta",
  "shoal", "bluff", "gully", "knoll", "marsh", "pass", "rill", "saddle",
  "scarp", "terrace", "vent", "wash"];

const state = {
  preset: "continent",
  seed: "first-light-42",
  size: "M",
  overrides: {},
  world: null,
  view: { cell: 4, contourM: 200 },
};

// ---- controls ----------------------------------------------------------

for (const [key, def] of Object.entries(PRESETS)) {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = def.label;
  $("preset").appendChild(opt);
}
$("preset").value = state.preset;
$("seed").value = state.seed;

let timer = 0;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(regen, 130);
}

$("preset").addEventListener("change", () => {
  state.preset = $("preset").value;
  state.overrides = {}; // preset defines the dials
  regen();
});
$("size").addEventListener("change", () => { state.size = $("size").value; regen(); });
$("seed").addEventListener("change", () => { state.seed = $("seed").value.trim() || "first-light-42"; regen(); });
$("dice").addEventListener("click", () => {
  const pick = (a) => a[(Math.random() * a.length) | 0];
  state.seed = `${pick(ADJ)}-${pick(NOUN)}-${(Math.random() * 90 + 10) | 0}`;
  $("seed").value = state.seed;
  regen();
});
$("regen").addEventListener("click", regen);
$("contour").addEventListener("change", () => {
  state.view.contourM = +$("contour").value;
  if (state.world) { render(state.world, $("map"), state.view); }
});

for (const id of SLIDERS) {
  $(id).addEventListener("input", () => {
    state.overrides[id] = +$(id).value;
    syncOutputs();
    schedule();
  });
}

function syncSliders(p) {
  for (const id of SLIDERS) $(id).value = p[id];
  syncOutputs();
}
function syncOutputs() {
  for (const id of SLIDERS) {
    const out = document.querySelector(`output[for=${id}]`);
    const v = +$(id).value;
    out.textContent = id === "riverThresh" ? String(v) : v.toFixed(2);
  }
}

// ---- generation --------------------------------------------------------

function regen() {
  const [w, h, cell] = SIZES[state.size];
  state.view.cell = cell;
  const p = makeParams({
    preset: state.preset,
    seed: state.seed,
    width: w,
    height: h,
    ...state.overrides,
  });
  state.world = generate(p);
  syncSliders(state.world.p);
  render(state.world, $("map"), state.view);
  paintMeta();
  paintRules();
  paintCensus();
}

function paintMeta() {
  const { w, h, mapId } = state.world;
  const km = (v) => (v * 50 / 1000).toFixed(1);
  $("mapmeta").textContent = `#${mapId} · ${w}×${h} · ${km(w)}×${km(h)} km`;
}

function paintRules() {
  const p = state.world.p;
  const li = (s) => `<li>${s}</li>`;
  $("ruleList").innerHTML = [
    `h &lt; 0 m → ocean (deep &lt; −${p.deepM} m)`,
    `basin floods (depth &gt; ${Math.round(p.minLakeDepth * METERS_SPAN)} m) → lake`,
    `arid basin, inflow &lt; ${p.playaInflow.toFixed(1)}×area → playa`,
    `catchment ≥ ${Math.round(p.riverThresh)} cells → river`,
    `shore ∧ h &lt; ${p.beachM} m → beach`,
    `slope &gt; ${p.cliffSlopeM} m/cell → rock`,
    `h &gt; ${p.snowM} m → snow`,
    `h &gt; ${p.rockM} m → rock`,
    `wet &gt; ${p.mForest.toFixed(2)} → forest + trees`,
    `wet &gt; ${p.mGrass.toFixed(2)} → grass, copses`,
    `wet &gt; ${p.mScrub.toFixed(2)} → scrub`,
    `else → barrens`,
  ].map(li).join("");
  $("ruleNote").textContent =
    `first match wins · wind ${WIND_NAMES[p.windIdx]} · treeline ${p.treelineM} m`;
}

function paintCensus() {
  const { census, genMs } = state.world;
  const rows = [];
  for (let k = 0; k < CLASS_INFO.length; k++) {
    const c = census.counts[k];
    if (!c) continue;
    const pct = (100 * c / census.cells).toFixed(1);
    rows.push(
      `<tr><td><span class="swatch" style="background:${PAL[k]}"></span></td>` +
      `<td>${CLASS_INFO[k].name}</td><td class="num">${c}</td><td class="num">${pct}%</td></tr>`
    );
  }
  $("censusTable").innerHTML = rows.join("");
  $("censusFoot").textContent =
    `${census.trees} trees · water ${(census.waterFrac * 100).toFixed(1)}% · ${genMs.toFixed(0)} ms`;
}

// ---- inspector ---------------------------------------------------------

$("map").addEventListener("mousemove", (e) => {
  const wld = state.world;
  if (!wld) return;
  const rect = e.target.getBoundingClientRect();
  const scale = rect.width / e.target.width; // canvas may be CSS-shrunk
  const x = Math.floor((e.clientX - rect.left) / scale / state.view.cell);
  const y = Math.floor((e.clientY - rect.top) / scale / state.view.cell);
  if (x < 0 || y < 0 || x >= wld.w || y >= wld.h) return;
  const i = y * wld.w + x;
  const hm = metersAbove(wld.elev[i], wld.p.sea);
  const info = CLASS_INFO[wld.cls[i]];
  const bits = [
    `${x},${y}`,
    `${hm >= 0 ? "+" : ""}${hm.toFixed(0)} m`,
    info.name + (wld.trees[i] ? " ·tree" : ""),
    `wet ${wld.moist[i].toFixed(2)}`,
    `catch ${Math.round(wld.acc[i])}`,
  ];
  if (wld.lake[i]) bits.push(`lake depth ${((wld.filled[i] - wld.elev[i]) * METERS_SPAN).toFixed(0)} m`);
  if (wld.playa[i]) bits.push(`basin depth ${((wld.filled[i] - wld.elev[i]) * METERS_SPAN).toFixed(0)} m`);
  $("inspector").textContent = bits.join(" · ");
});
$("map").addEventListener("mouseleave", () => {
  $("inspector").textContent = "hover the map to inspect a cell";
});

// ---- exports -----------------------------------------------------------

function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const stem = () => `gridlands-${state.preset}-${state.seed}`;

$("expPng").addEventListener("click", () => {
  $("map").toBlob((b) => download(`${stem()}.png`, b), "image/png");
});

$("expTxt").addEventListener("click", () => {
  const { w, h, cls, trees } = state.world;
  const lines = [
    `GRIDLANDS ${stem()} map#${state.world.mapId}`,
    `legend: ` + CLASS_INFO.map((c) => `${c.glyph}=${c.name}`).join(" ") + " T=tree",
    "",
  ];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      row += trees[i] ? "T" : CLASS_INFO[cls[i]].glyph;
    }
    lines.push(row);
  }
  download(`${stem()}.txt`, new Blob([lines.join("\n")], { type: "text/plain" }));
});

$("expJson").addEventListener("click", () => {
  const { p, mapId, census } = state.world;
  const out = {
    tool: "gridlands", version: 1, mapId,
    params: { ...p },
    census: { ...census, counts: [...census.counts] },
  };
  download(`${stem()}.json`, new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
});

// ---- boot --------------------------------------------------------------

regen();
