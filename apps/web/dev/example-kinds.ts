// Example host kinds, for reference: what scenes give an app built on them (docs/scenes.md,
// "Hosts"): a model built from settings, a path with ghosts, a box with no model, a radius, and a
// ref. Not used by the web app; a host passes kinds like these as `LibraryHost.kinds`, e.g.
//   { kinds: EXAMPLE_KINDS, outlinerBadge: (id) => exampleBadge(library.settings(id), library.instance(id)?.kind) }

import { fromHex } from "@voxeltoy/core/color";
import type { InstanceKind } from "@voxeltoy/core/scene-kinds";
import type { DocumentData, Json, Vec3 } from "@voxeltoy/core/types";

/** A solid box of one color, `size` voxels, as a document. */
function block(name: string, size: Vec3, color: string): DocumentData {
  const data = new Uint8Array(size[0] * size[1] * size[2]).fill(1);
  return { name, size, palette: [0, fromHex(color)], layers: [{ name: "Layer 1", visible: true, locked: false, data }], activeLayer: 0 };
}

const num = (v: Json | undefined, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: Json | undefined, fallback: string) => (typeof v === "string" ? v : fallback);
const vec = (v: Json | undefined, fallback: Vec3): Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number") ? (v as Vec3) : fallback;
const get = (data: Json) => (data && typeof data === "object" && !Array.isArray(data) ? data : {});

export const EXAMPLE_KINDS: InstanceKind[] = [
  {
    id: "pole",
    label: "Pole",
    defaults: { length: 4, color: "#e4a672" },
    fields: [
      { key: "length", type: "number", min: 1, max: 32, step: 1 },
      { key: "color", type: "color" },
    ],
    model: (data) => {
      const d = get(data);
      return block("Pole", [1, Math.round(num(d.length, 4)), 1], str(d.color, "#e4a672"));
    },
    rotate: "quarter",
  },
  {
    id: "platform",
    label: "Moving platform",
    defaults: { path: [[0, 0, 0], [8, 0, 0]], speed: 2, loop: false },
    fields: [
      { key: "path", type: "points", relative: true, display: "path", ghost: true },
      { key: "speed", type: "number", min: 0.5, max: 10, step: 0.5 },
      { key: "loop", type: "bool" },
    ],
    model: () => block("Platform", [4, 1, 4], "#5a6988"),
  },
  {
    id: "camera-zone",
    label: "Camera zone",
    color: 0x3e7cf7,
    defaults: { size: [8, 4, 8], mode: "follow", fov: 60 },
    fields: [
      { key: "size", type: "size", axes: ["x", "y", "z"], anchor: "center", min: 1, step: 1 },
      { key: "mode", type: "enum", options: ["follow", "fixed", "rail"] },
      { key: "fov", label: "Field of view", type: "number", min: 20, max: 120, step: 5 },
    ],
    bounds: (data) => {
      const s = vec(get(data).size, [8, 4, 8]);
      return { min: [-s[0] / 2, -s[1] / 2, -s[2] / 2], max: [s[0] / 2, s[1] / 2, s[2] / 2] };
    },
    rotate: "none",
  },
  {
    id: "light",
    label: "Light",
    color: 0xfee761,
    defaults: { radius: 6, color: "#fee761", on: true },
    fields: [
      { key: "radius", type: "radius", min: 1, max: 64 },
      { key: "color", type: "color" },
      { key: "on", type: "bool" },
    ],
    bounds: () => ({ min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }),
    rotate: "none",
  },
  {
    id: "switch",
    label: "Switch",
    defaults: { target: null },
    fields: [{ key: "target", type: "ref", kinds: ["platform"] }],
    model: () => block("Switch", [2, 1, 2], "#e43b44"),
    snap: { step: 0.5 },
  },
];

/** A note in the outliner for a switch that isn't wired to anything. */
export function exampleBadge(settings: { [key: string]: Json }, kind: string | undefined): string | null {
  return kind === "switch" && !settings.target ? "no target" : null;
}
