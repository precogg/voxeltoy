// Animation exports as images: a PNG per frame, or one sprite sheet, with a JSON manifest that
// gives the order, holds and timing. A hold is a duration, never a repeated image. Every frame is
// the same size, drawn with one camera and one crop, so poses never jump. See docs/animation.md.

import { frameStart, ticksToMs, totalTicks } from "../animation";
import type { AnimationFrame } from "../types";

/** Format string new sequence manifests are written with. */
export const SEQUENCE_FORMAT = "voxeltoy-sequence";
/** Format string older sequence manifests use. Still accepted on read. */
export const LEGACY_SEQUENCE_FORMAT = "moxel-sequence";

export function isSequenceFormat(format: unknown): format is typeof SEQUENCE_FORMAT | typeof LEGACY_SEQUENCE_FORMAT {
  return format === SEQUENCE_FORMAT || format === LEGACY_SEQUENCE_FORMAT;
}

export interface SequenceManifest {
  format: typeof SEQUENCE_FORMAT | typeof LEGACY_SEQUENCE_FORMAT;
  version: 1;
  name: string;
  fps: number;
  /** The whole loop. */
  durationMs: number;
  /** Every frame's image size, in pixels. */
  width: number;
  height: number;
  /** The sheet's image, for a sprite sheet. */
  image?: string;
  tags?: import("../animation").AnimationTag[];
  frames: SequenceFrame[];
}

export interface SequenceFrame {
  id: string;
  index: number;
  /** Ticks (1 / fps seconds). */
  duration: number;
  /** When the frame starts and how long it shows. */
  startMs: number;
  durationMs: number;
  /** The frame's own image, in a sequence. */
  file?: string;
  /** Where the frame is on the sheet, in a sprite sheet. */
  x?: number;
  y?: number;
}

/** The file name for frame `index` of `count`: frame-01.png, zero-padded so names sort. */
export function frameFileName(index: number, count: number): string {
  return `frame-${String(index + 1).padStart(Math.max(2, String(count).length), "0")}.png`;
}

/** Columns and rows for a sheet of `count` cells: as square as it gets, wider than tall. */
export function sheetGrid(count: number): { columns: number; rows: number } {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  return { columns, rows: Math.max(1, Math.ceil(count / columns)) };
}

/** The manifest for frames rendered `width` × `height`, as separate files or (with `sheet`) one sheet image. */
export function sequenceManifest(
  name: string,
  frames: readonly AnimationFrame[],
  fps: number,
  width: number,
  height: number,
  sheet?: string,
  tags: readonly import("../animation").AnimationTag[] = [],
): SequenceManifest {
  const durations = frames.map((f) => f.duration);
  const { columns } = sheetGrid(frames.length);
  return {
    format: SEQUENCE_FORMAT,
    version: 1,
    name,
    fps,
    tags: tags.map(t => ({ ...t })),
    durationMs: ticksToMs(totalTicks(durations), fps),
    width,
    height,
    ...(sheet ? { image: sheet } : {}),
    frames: frames.map((f, index) => ({
      id: f.id,
      index,
      duration: f.duration,
      startMs: ticksToMs(frameStart(durations, index), fps),
      durationMs: ticksToMs(f.duration, fps),
      ...(sheet
        ? { x: (index % columns) * width, y: Math.floor(index / columns) * height }
        : { file: frameFileName(index, frames.length) }),
    })),
  };
}

/** A sequence or sheet manifest. Accepts `"voxeltoy-sequence"` and the legacy `"moxel-sequence"`. */
export function parseSequenceManifest(text: string): SequenceManifest {
  let file: SequenceManifest;
  try {
    file = JSON.parse(text) as SequenceManifest;
  } catch {
    throw new Error("Not a Voxeltoy sequence");
  }
  if (!file || !isSequenceFormat(file.format)) throw new Error("Not a Voxeltoy sequence");
  return file;
}
