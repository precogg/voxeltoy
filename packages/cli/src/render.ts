// Shots of the open model as PNGs: the `render` MCP tool and `moxel render` take the same input.

import type { Editor } from "@voxeltoy/core/editor";
import { encodePng } from "@voxeltoy/core/formats/png";
import { fromHex } from "@voxeltoy/core/palette";
import { renderShot, type ShotView } from "@voxeltoy/core/render";
import type { CameraView, ProjectionMode } from "@voxeltoy/core/types";

export const RENDER_VIEWS: readonly CameraView[] = ["iso", "front", "back", "left", "right", "top", "bottom"];
const PROJECTIONS: readonly ProjectionMode[] = ["perspective", "orthographic"];
/** The editor's light canvas. */
export const DEFAULT_BACKGROUND = "#f4f5f7";
const MAX_TILE = 2048;
/** The most pixels in one image, over all its tiles. */
const MAX_PIXELS = 4096 * 4096;
const MAX_TILES = 64;

export interface RenderInput {
  views?: unknown;
  frames?: unknown;
  projection?: unknown;
  size?: unknown;
  background?: unknown;
  layers?: unknown;
}

export interface RenderResult {
  png: Uint8Array;
  width: number;
  height: number;
  columns: number;
  rows: number;
  /** What each tile shows, in reading order. */
  tiles: { view: ShotView; frame: number }[];
}

export const renderSchema = {
  views: {
    type: "array",
    description:
      `Views to render, each a tile of the image: ${RENDER_VIEWS.join(", ")}, or { yaw, pitch } orbit angles in degrees ` +
      "(yaw 0 looks from +z, 90 from +x; pitch 90 looks straight down). Defaults to [\"iso\"].",
    items: {
      anyOf: [
        { type: "string", enum: RENDER_VIEWS },
        {
          type: "object",
          properties: { yaw: { type: "number" }, pitch: { type: "number", minimum: -90, maximum: 90 } },
          required: ["yaw", "pitch"],
        },
      ],
    },
  },
  frames: {
    description: 'Animation frames to render, by position from 0 or id, or "all". Defaults to the open frame.',
    anyOf: [{ type: "array", items: { type: ["integer", "string"] } }, { type: "string", enum: ["all"] }],
  },
  projection: {
    type: "string",
    enum: PROJECTIONS,
    description: "Defaults to orthographic for the axis views, so they read like a blueprint, and perspective for the others.",
  },
  size: {
    type: "integer",
    minimum: 32,
    maximum: MAX_TILE,
    description: "Each tile's width and height in pixels. Defaults to 512 for one tile, 320 for more.",
  },
  background: { type: "string", description: `A hex color, or "transparent". Defaults to ${DEFAULT_BACKGROUND}.` },
  layers: { type: "array", items: { type: "string" }, description: "Only these layers, by id or name, hidden or not. Defaults to the visible layers." },
};

function fail(message: string): never {
  throw new Error(message);
}

function readView(value: unknown): ShotView {
  if (typeof value === "string") {
    return (RENDER_VIEWS as readonly string[]).includes(value) ? (value as CameraView) : fail(`view must be one of ${RENDER_VIEWS.join(", ")}, or { yaw, pitch }`);
  }
  const v = value as { yaw?: unknown; pitch?: unknown } | null;
  if (typeof v?.yaw === "number" && typeof v.pitch === "number" && Number.isFinite(v.yaw) && Math.abs(v.pitch) <= 90) {
    return { yaw: v.yaw, pitch: v.pitch };
  }
  return fail("A custom view is { yaw, pitch } in degrees, with pitch from -90 to 90");
}

function readFrames(editor: Editor, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const frames = editor.frames;
  if (value === "all") return frames.map((f) => f.id);
  if (!Array.isArray(value) || !value.length) fail('frames is a list of frame positions or ids, or "all"');
  return value.map((ref) => {
    if (Number.isInteger(ref)) return frames[ref]?.id ?? fail(`There are ${frames.length} frames, numbered from 0`);
    return frames.find((f) => f.id === ref)?.id ?? fail(`No frame with id ${JSON.stringify(ref)}; get_document lists them`);
  });
}

function readLayers(editor: Editor, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length) fail("layers is a list of layer ids or names");
  return value.map((ref) => {
    const layer = editor.layers.find((l) => l.id === ref) ?? editor.layers.find((l) => l.name === ref);
    return layer?.id ?? fail(`No layer with id or name ${JSON.stringify(ref)}`);
  });
}

function readBackground(value: unknown): number | null {
  if (value === undefined) return fromHex(DEFAULT_BACKGROUND);
  if (value === "transparent") return null;
  if (typeof value !== "string" || !/^#?[0-9a-f]{6}$/i.test(value)) fail('background is a hex color like "#ffffff", or "transparent"');
  return fromHex(value);
}

/** Render the open model as a PNG, from views and frames that `input` names in the tool's terms. */
export async function renderPng(editor: Editor, input: RenderInput): Promise<RenderResult> {
  const views = input.views === undefined ? ["iso" as const] : Array.isArray(input.views) && input.views.length ? input.views.map(readView) : fail("views is a list of views");
  const frames = readFrames(editor, input.frames);
  const projection = input.projection === undefined ? undefined : PROJECTIONS.includes(input.projection as ProjectionMode) ? (input.projection as ProjectionMode) : fail(`projection must be ${PROJECTIONS.join(" or ")}`);
  const count = views.length * (frames?.length ?? 1);
  if (count > MAX_TILES) fail(`That is ${count} tiles; render at most ${MAX_TILES} at once`);
  const size = input.size === undefined ? (count > 1 ? 320 : 512) : input.size;
  if (!Number.isInteger(size) || (size as number) < 32 || (size as number) > MAX_TILE) fail(`size must be a whole number of pixels from 32 to ${MAX_TILE}`);
  if (count * (size as number) ** 2 > MAX_PIXELS) fail(`${count} tiles of ${size}×${size} is too many pixels; use a smaller size or fewer tiles`);
  const shot = renderShot(editor, {
    views,
    frames,
    projection,
    width: size as number,
    height: size as number,
    background: readBackground(input.background),
    layers: readLayers(editor, input.layers),
  });
  const index = new Map(editor.frames.map((f, i) => [f.id, i]));
  return {
    png: await encodePng({ width: shot.width, height: shot.height, channels: 4, pixels: shot.pixels }),
    width: shot.width,
    height: shot.height,
    columns: shot.columns,
    rows: shot.rows,
    tiles: shot.tiles.map((t) => ({ view: t.view, frame: index.get(t.frame)! })),
  };
}
