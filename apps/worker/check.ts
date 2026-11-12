// What a snapshot may hold, checked before it is stored: a .moxel file of raster layers, still
// (version 1) or animated (version 3), within size limits. Pure, so it runs under `bun test`.

import { parseMoxel } from "@voxeltoy/core/formats/moxel";
import { MAX_HOST_DATA, MAX_LAYERS, MAX_SIZE } from "@voxeltoy/core/ops";

/** Uncompressed .moxel text a snapshot may hold. */
export const MAX_TEXT = 64 * 1024 * 1024;
/** Voxels a snapshot may hold: cells × layers × frames. */
export const MAX_CELLS = 64 * 1024 * 1024;

interface FileHead {
  format?: unknown;
  version?: unknown;
  name?: unknown;
  size?: unknown;
  resolution?: unknown;
  layers?: unknown;
  frames?: unknown;
}

/** The model's name, or why a .moxel file can't be shared. */
export function check(text: string): { name: string } | { error: string } {
  let file: FileHead;
  try {
    file = JSON.parse(text);
  } catch {
    return { error: "Not a Voxeltoy file" };
  }
  if ((file?.format !== "voxeltoy" && file?.format !== "moxel") || (file.version !== 1 && file.version !== 3)) return { error: "Not a Voxeltoy file" };
  const size = file.size;
  if (!Array.isArray(size) || size.length !== 3 || !size.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_SIZE)) {
    return { error: "The model's size is out of range" };
  }
  const layers = file.layers;
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > MAX_LAYERS) return { error: "Bad layers" };
  let frames = 1;
  if (file.version === 3) {
    // animations of plain raster layers; shape and override layers can't be shared yet
    if ((file.resolution ?? 1) !== 1 || layers.some((l) => l?.kind !== "raster" || l.coverage !== undefined)) {
      return { error: "Models with shape or override layers can't be shared yet" };
    }
    if (!Array.isArray(file.frames) || file.frames.length < 1) return { error: "Bad frames" };
    frames = file.frames.length;
  }
  if (size[0] * size[1] * size[2] * layers.length * frames > MAX_CELLS) return { error: "The model is too big to share" };
  let doc;
  try {
    doc = parseMoxel(text);
  } catch (e) {
    return { error: `Not a Voxeltoy file: ${(e as Error).message}` };
  }
  // host data travels with the model, within the same limit an editor keeps
  let hostBytes = JSON.stringify(doc.hostData ?? {}).length + JSON.stringify(doc.extra ?? {}).length;
  for (const l of doc.layers) hostBytes += JSON.stringify(l.hostData ?? null).length + JSON.stringify(l.extra ?? {}).length;
  if (hostBytes > MAX_HOST_DATA + 64 * (doc.layers.length + 1)) return { error: "The model's host data is too big to share" };
  return { name: typeof file.name === "string" && file.name.trim() ? file.name.trim().slice(0, 120) : "Untitled" };
}
