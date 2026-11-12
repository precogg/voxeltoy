// Markers as glTF nodes: named empties where a model's markers are, turned as they are, with what
// they are in `extras.voxeltoy`. Blender imports them as empties, Godot as Node3Ds; the Godot addon
// reads `extras.voxeltoy`, and still `extras.moxel`, to make collision shapes and areas.
// See docs/pipeline.md ("Files and export").

import { Object3D } from "three";
import { markerAt, markerCenter, markerRotation, originCells, type Marker, type MarkerShape } from "@voxeltoy/core/markers";
import type { Json, Vec3 } from "@voxeltoy/core/types";
import { presetOf } from "@voxeltoy/core/shapes";

/** glTF extras key new exports write. */
export const EXTRAS_KEY = "voxeltoy";
/** glTF extras key older exports use. Still read. */
export const LEGACY_EXTRAS_KEY = "moxel";

/** Marker or scene extras from a glTF node: the current key, or the legacy one. */
export function readNativeExtras(userData: object | null | undefined): unknown {
  if (!userData) return undefined;
  const data = userData as Record<string, unknown>;
  if (data[EXTRAS_KEY] !== undefined) return data[EXTRAS_KEY];
  return data[LEGACY_EXTRAS_KEY];
}

/** What a marker node says about itself in `extras.voxeltoy`, in source units. */
export interface MarkerExtras {
  marker: string;
  role: string | null;
  shape: "point" | string;
  /** A volume's box size. */
  size?: Vec3;
  /** A volume's shape options (up, round, shell, ...), as shape steps have them. */
  options?: Record<string, Json>;
  data?: Json;
}

/** What goes in a marker node's `extras.voxeltoy`. */
export function markerExtras(marker: Marker, shape: MarkerShape): MarkerExtras {
  const base = { marker: marker.id, role: marker.role ?? null, ...(marker.data !== undefined ? { data: marker.data } : {}) };
  if (shape.kind === "point") return { ...base, shape: "point" };
  const { kind, min, max, ...options } = shape.shape;
  return {
    ...base,
    // by the name importers know (a box, a cylinder), not "prism"
    shape: presetOf(kind, shape.shape) ?? kind,
    size: max.map((n, a) => n - min[a]) as Vec3,
    ...(Object.keys(options).length ? { options: options as unknown as Record<string, Json> } : {}),
  };
}

/**
 * A model's markers as nodes, where they are on `frame`, in its grid units relative to its origin
 * (what its meshes are translated by). Hidden markers are left out.
 */
export function markerObjects(
  doc: {
    readonly markers: readonly Marker[];
    readonly frames: readonly { id: string }[];
    readonly origin: Vec3 | null;
    readonly size: Vec3;
    readonly resolution: number;
  },
  frame: string,
): Map<string, Object3D> {
  const out = new Map<string, Object3D>();
  const origin = originCells(doc);
  const r = doc.resolution;
  for (const marker of doc.markers) {
    const { shape, hidden } = markerAt(marker, doc.frames, frame);
    if (hidden) continue;
    const node = new Object3D();
    node.name = marker.name;
    const at = markerCenter(shape);
    node.position.set(...(at.map((n, a) => n * r - origin[a]) as Vec3));
    node.quaternion.set(...markerRotation(shape));
    const extras = markerExtras(marker, shape);
    if (extras.size) extras.size = extras.size.map((n) => n * r) as Vec3;
    node.userData = { [EXTRAS_KEY]: extras };
    out.set(marker.id, node);
  }
  return out;
}
