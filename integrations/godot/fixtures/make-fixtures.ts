// Writes the Godot spike's fixtures: the dev pages' sample models as voxel volumes exports (a folder
// each, and a .moxelvol in demo/ for the import plugin), and the camera views both engines render
// for comparison. Run with `bun make-fixtures.ts` here.
// See docs/voxel-runtime.md, stage 4.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeVolumes } from "../../../packages/core/src/formats/volumes";
import { writeZip } from "../../../packages/core/src/formats/zip";
import { critter, sampleAnimation } from "../../../apps/web/dev/samples";

export interface FixtureView {
  name: string;
  model: "ball" | "critter";
  frame: number;
  width: number;
  height: number;
  /** Camera in the model's grid space: the volume's corner is the origin. */
  camera: { position: number[]; target: number[]; fov: number; near: number; far: number; orthoHeight?: number };
  shade: boolean;
  ao: boolean;
}

const here = import.meta.dir;
mkdirSync(join(here, "..", "demo"), { recursive: true });
for (const [name, animation] of [["ball", sampleAnimation()], ["critter", critter()]] as const) {
  const dir = join(here, name);
  mkdirSync(dir, { recursive: true });
  const entries = await writeVolumes(animation);
  for (const entry of entries) writeFileSync(join(dir, entry.name), entry.data);
  writeFileSync(join(here, "..", "demo", `${name}.moxelvol`), writeZip(entries));
}

const views: FixtureView[] = [
  { name: "ball-perspective", model: "ball", frame: 0, width: 480, height: 360, shade: true, ao: true,
    camera: { position: [70, 50, 80], target: [16, 13, 16], fov: 40, near: 0.5, far: 500 } },
  { name: "ball-cropped-frame-no-ao", model: "ball", frame: 3, width: 480, height: 360, shade: true, ao: false,
    camera: { position: [-40, 34, 62], target: [16, 16, 16], fov: 45, near: 0.5, far: 500 } },
  { name: "critter-orthographic", model: "critter", frame: 1, width: 480, height: 360, shade: true, ao: true,
    camera: { position: [44, 30, 52], target: [10, 10, 8], fov: 40, near: 0.5, far: 500, orthoHeight: 30 } },
  { name: "ball-inside-tunnel", model: "ball", frame: 0, width: 480, height: 360, shade: true, ao: true,
    camera: { position: [15.5, 13.5, 26], target: [15.5, 13.5, 0], fov: 60, near: 0.1, far: 500 } },
];
writeFileSync(join(here, "views.json"), JSON.stringify(views, null, 2) + "\n");
console.log(`Wrote ${views.length} views and 2 models to ${here}`);
