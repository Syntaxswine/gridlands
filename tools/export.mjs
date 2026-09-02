// Headless exporter, for other games' pipelines:
//
//   node tools/export.mjs --preset continent --seed first-light-42 \
//        --size M --out ./out [--json] [--glb] [--txt]
//
// With no layer flags, exports all three. Prints sizes and the map id so a
// consumer can pin provenance.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generate, makeParams } from "../js/generate.js";
import { terrainJson, buildGlb } from "../js/export3d.js";
import { CLASS_INFO } from "../js/classify.js";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const flag = (name) => args.includes("--" + name);

const SIZES = { S: [132, 96], M: [200, 150], L: [276, 204] };
const size = SIZES[opt("size", "M")] ?? SIZES.M;
const preset = opt("preset", "continent");
const seed = opt("seed", "first-light-42");
const outDir = opt("out", ".");

const all = !(flag("json") || flag("glb") || flag("txt"));
const world = generate(makeParams({
  preset, seed,
  width: +opt("width", size[0]),
  height: +opt("height", size[1]),
}));

await mkdir(outDir, { recursive: true });
const stem = path.join(outDir, `gridlands-${preset}-${seed}`);
const written = [];

if (all || flag("json")) {
  const s = terrainJson(world);
  await writeFile(`${stem}.terrain.json`, s);
  written.push([`${stem}.terrain.json`, s.length]);
}
if (all || flag("glb")) {
  const g = buildGlb(world);
  await writeFile(`${stem}.glb`, g);
  written.push([`${stem}.glb`, g.byteLength]);
}
if (all || flag("txt")) {
  const { w, h, cls, trees } = world;
  const lines = [
    `GRIDLANDS ${preset}/${seed} map#${world.mapId}`,
    "legend: " + CLASS_INFO.map((c) => `${c.glyph}=${c.name}`).join(" ") + " T=tree",
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
  await writeFile(`${stem}.txt`, lines.join("\n"));
  written.push([`${stem}.txt`, lines.join("\n").length]);
}

console.log(`${preset}/${seed} ${world.w}x${world.h} map#${world.mapId} (${world.genMs.toFixed(0)} ms)`);
for (const [f, bytes] of written) console.log(`  ${f}  ${(bytes / 1024).toFixed(0)} KB`);
