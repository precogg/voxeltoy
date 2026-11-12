// Instance kinds: what a host says its scene objects are (docs/scenes.md, "Hosts"). Voxeltoy keeps
// an instance's settings as JSON and resolves them against its kind's defaults; the host owns
// what they mean.

import type { Box, DocumentData, Json, Vec3 } from "./types";

/** A setting of a kind, and how it is shown: in the inspector, and as a handle in the viewport. */
export type Field = { key: string; label?: string } & (
  | { type: "number"; min?: number; max?: number; step?: number }
  | { type: "bool" }
  | { type: "enum"; options: string[] }
  | { type: "color" }
  | { type: "point"; relative?: boolean; handle?: boolean }
  | { type: "points"; relative?: boolean; display?: "path" | "loop" | "points"; ghost?: boolean }
  | { type: "size"; axes: ("x" | "y" | "z")[]; anchor?: "center" | "min"; min?: number; max?: number; step?: number }
  | { type: "radius"; min?: number; max?: number }
  | { type: "ref"; kinds?: string[] }
);

/** How a kind snaps, overriding the scene: a step in world units, or onto surfaces. */
export interface SnapRule {
  step?: number;
  surfaces?: boolean;
  /**
   * How an instance lines up with the stage's cells when it snaps. `edges` (the default) puts its
   * model's grid on the cells, so a model as wide as two cells covers two; `center` stands its
   * origin in the middle of a cell across (X and Z) and on the cell's floor, whatever its size.
   */
  align?: "edges" | "center";
  /**
   * Dragged onto a wall or a ceiling, land there too, turned a quarter turn at a time to stand
   * out of the face (spikes that hang from a ceiling, a lamp on a wall). Otherwise only tops.
   */
  faces?: boolean;
}

/** One kind of instance a host offers. */
export interface InstanceKind {
  id: string;
  label: string;
  /** A heading the add menu files it under, so a host with many kinds keeps them in a few submenus. */
  group?: string;
  /** The model it shows, from its settings: a host's model ref, a document built from them, or none. */
  model?: (data: Json) => string | DocumentData | null;
  /** For kinds without a model: what is picked, outlined and framed. In the instance's own space. */
  bounds?: (data: Json) => Box;
  fields?: Field[];
  /** Settings an instance has unless it changes them. */
  defaults?: { [key: string]: Json };
  /** An outline color, 0xRRGGBB. */
  color?: number;
  snap?: SnapRule;
  rotate?: "free" | "quarter" | "none";
}

/**
 * What a kind was when the scene was saved, so the scene still makes sense without its host:
 * defaults resolve, and instances without a model show their last bounds.
 */
export interface KindSnapshot {
  label: string;
  defaults?: { [key: string]: Json };
  color?: number;
  /** The bounds each instance of the kind without a model had, by instance id. */
  bounds?: { [instance: string]: { min: Vec3; max: Vec3 } };
}

/** An instance's settings: its kind's defaults, with what it changes on top. */
export function resolveSettings(defaults: { [key: string]: Json } | undefined, data: Json | undefined): { [key: string]: Json } {
  const own = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return { ...(defaults ?? {}), ...own };
}
