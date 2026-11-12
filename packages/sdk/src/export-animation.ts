import type { Editor } from "@voxeltoy/core/editor";
import { frameFileName, sequenceManifest, sheetGrid } from "@voxeltoy/core/formats/sequence";
import { toVoxelAnimation, VOLUMES_EXTENSION, writeVolumes } from "@voxeltoy/core/formats/volumes";
import { writeZip, type ZipEntry } from "@voxeltoy/core/formats/zip";
import type { Viewport } from "@voxeltoy/three/viewport";
import { saveFile } from "./files";

/** The largest canvas every browser draws: iOS Safari stops at about 16.7 million pixels, others at 16384 a side. */
const MAX_SIDE = 16384;
const MAX_AREA = 16_777_216;

const baseName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Untitled";

async function pngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Couldn't draw a frame");
  return new Uint8Array(await blob.arrayBuffer());
}

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value, null, 2));

/** Every frame as seen now, in one zip: a PNG per frame and animation.json with the timing. */
export async function exportFrameSequence(viewport: Viewport, editor: Editor) {
  const frames = editor.frames;
  const { images, width, height } = viewport.renderFrames(frames.map((f) => f.id));
  const entries: ZipEntry[] = [];
  for (const [i, image] of images.entries()) entries.push({ name: frameFileName(i, frames.length), data: await pngBytes(image) });
  entries.push({ name: "animation.json", data: json(sequenceManifest(editor.name, frames, editor.fps, width, height, undefined, editor.tags)) });
  const name = baseName(editor.name);
  return saveFile(new Blob([writeZip(entries)], { type: "application/zip" }), `${name}-frames.zip`, "Zip archive");
}

/** Every frame as seen now, on one sprite sheet, in a zip with sheet.json. */
export async function exportSpriteSheet(viewport: Viewport, editor: Editor) {
  const frames = editor.frames;
  const shot = viewport.renderFrames(frames.map((f) => f.id));
  const { columns, rows } = sheetGrid(frames.length);
  // shrink every frame alike if the sheet wouldn't fit in a canvas
  const fit = Math.min(1, MAX_SIDE / (columns * shot.width), MAX_SIDE / (rows * shot.height), Math.sqrt(MAX_AREA / (columns * rows * shot.width * shot.height)));
  const width = Math.max(1, Math.floor(shot.width * fit));
  const height = Math.max(1, Math.floor(shot.height * fit));
  const sheet = document.createElement("canvas");
  sheet.width = columns * width;
  sheet.height = rows * height;
  const context = sheet.getContext("2d")!;
  shot.images.forEach((image, i) => context.drawImage(image, (i % columns) * width, Math.floor(i / columns) * height, width, height));
  const name = baseName(editor.name);
  const entries: ZipEntry[] = [
    { name: "sheet.png", data: await pngBytes(sheet) },
    { name: "sheet.json", data: json(sequenceManifest(editor.name, frames, editor.fps, width, height, "sheet.png", editor.tags)) },
  ];
  return saveFile(new Blob([writeZip(entries)], { type: "application/zip" }), `${name}-sheet.zip`, "Zip archive");
}

/**
 * Every frame's voxels, for engines that draw voxels directly: a zip of volumes.json, palette.png
 * and one grayscale PNG per distinct pose, named .voxeltoyvol so engine importers can claim it (Godot
 * picks importers by extension, and .zip would claim every zip). `.moxelvol` still opens. See docs/voxel-runtime.md.
 */
export async function exportVoxelVolumes(editor: Editor) {
  const animation = toVoxelAnimation({
    name: editor.name,
    fps: editor.fps,
    size: editor.size,
    palette: editor.palette,
    frames: editor.frames.map((f) => ({ id: f.id, duration: f.duration, voxels: editor.evaluateFrame(f.id) })),
  });
  const name = baseName(editor.name);
  const zip = writeZip(await writeVolumes(animation));
  return saveFile(new Blob([zip], { type: "application/zip" }), `${name}${VOLUMES_EXTENSION}`, "Voxeltoy voxel volumes");
}
