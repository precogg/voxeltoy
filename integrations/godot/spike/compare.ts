// Diffs the spike's renders (docs/voxel-runtime.md, stage 4), run with `bun spike/compare.ts`:
// - three-<view>.png against godot-<view>.png: the same flat volume in both engines;
// - lit-<light>-mesh.png against lit-<light>-volume[-through].png: Godot's lit volume against a mesh.
// Writes diff-<name>.png (differing pixels red, the rest dimmed) and prints a table.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, encodePng } from "../../../packages/core/src/formats/png";

const out = join(import.meta.dir, "out");
const TOLERANCE = 3;
const BACKGROUND = [0x9a, 0xa3, 0xad];

async function diff(a: string, b: string, name: string) {
  const [x, y] = await Promise.all([decodePng(readFileSync(join(out, a))), decodePng(readFileSync(join(out, b)))]);
  if (x.width !== y.width || x.height !== y.height) throw new Error(`${a} and ${b} differ in size`);
  const pixels = new Uint8Array(x.width * x.height * 3);
  let covered = 0, differ = 0, max = 0;
  for (let i = 0; i < x.width * x.height; i++) {
    const p = i * x.channels, q = i * y.channels;
    const background = [0, 1, 2].every((c) => Math.abs(x.pixels[p + c] - BACKGROUND[c]) <= 1 && Math.abs(y.pixels[q + c] - BACKGROUND[c]) <= 1);
    if (!background) covered++;
    const d = Math.max(...[0, 1, 2].map((c) => Math.abs(x.pixels[p + c] - y.pixels[q + c])));
    max = Math.max(max, d);
    if (d > TOLERANCE) differ++;
    for (let c = 0; c < 3; c++) pixels[i * 3 + c] = d > TOLERANCE ? [255, 0, 0][c] : x.pixels[p + c] >> 2;
  }
  writeFileSync(join(out, `diff-${name}.png`), await encodePng({ width: x.width, height: x.height, channels: 3, pixels }));
  return { name, covered, differ, percent: (100 * differ) / Math.max(1, covered), max };
}

const rows = [];
for (const file of readdirSync(out).filter((f) => f.startsWith("three-")).sort()) {
  const view = file.slice("three-".length, -".png".length);
  if (existsSync(join(out, `godot-${view}.png`))) rows.push(await diff(file, `godot-${view}.png`, `engines-${view}`));
}
for (const file of readdirSync(out).filter((f) => /^lit-.*-volume(-through)?\.png$/.test(f)).sort()) {
  const mesh = file.replace(/-volume(-through)?\.png$/, "-mesh.png");
  if (existsSync(join(out, mesh))) rows.push(await diff(mesh, file, file.slice(0, -".png".length)));
}
console.log("comparison | covered px | differ > 3/255 | % | largest");
for (const r of rows) console.log(`${r.name} | ${r.covered} | ${r.differ} | ${r.percent.toFixed(3)}% | ${r.max}`);
