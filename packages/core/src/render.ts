// A software renderer for voxel volumes: shots of a model without a GPU or a DOM, for the command
// line and agents. Shading matches the mesher's: a fixed shade per face direction and ambient
// occlusion from the cells around each face corner, so a render looks like the viewport.

import type { Editor } from "./editor";
import { raycastVolume } from "./raycast";
import type { Box, CameraView, ProjectionMode, Vec3 } from "./types";

/** Where the camera looks from, as the viewport's orbit camera puts it: angles in radians. */
export interface RenderCamera {
  yaw: number;
  pitch: number;
  projection: ProjectionMode;
}

export interface RenderOptions {
  width: number;
  height: number;
  camera: RenderCamera;
  /** 0xRRGGBB, or null for a transparent background. */
  background: number | null;
  /** The cells to draw; defaults to the volume's filled ones. */
  frame?: Box;
  /** Points to fit in the image, as flat x, y, z cell coordinates; defaults to `exposedCorners` of the volume. Keeps several frames in one shot. */
  fit?: Float64Array;
  /** Samples per pixel along each side, for smooth edges. Defaults to 2. */
  samples?: number;
}

/** The viewport's camera angles for each named view. */
export const VIEW_ANGLES: Record<CameraView, { yaw: number; pitch: number }> = {
  front: { yaw: 0, pitch: 0 },
  back: { yaw: Math.PI, pitch: 0 },
  right: { yaw: Math.PI / 2, pitch: 0 },
  left: { yaw: -Math.PI / 2, pitch: 0 },
  top: { yaw: 0, pitch: Math.PI / 2 },
  bottom: { yaw: 0, pitch: -Math.PI / 2 },
  iso: { yaw: Math.PI / 4, pitch: Math.PI / 6 },
};

// as the mesher bakes them; face order: -x, +x, -y, +y, -z, +z
const FACE_SHADE = [0.78, 0.86, 0.6, 1.0, 0.7, 0.92];
const AO_SHADE = [1.0, 0.87, 0.77, 0.66];
/** The viewport's vertical field of view, in perspective. */
const FOV = (40 * Math.PI) / 180;
/** Room around the model, as a share of the image. */
const MARGIN = 0.08;

/** Bounds of a volume's filled cells, or null when it is empty. */
export function volumeBounds(volume: Uint8Array, size: Vec3): Box | null {
  const [sx, sy] = size;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-1, -1, -1];
  for (let i = 0; i < volume.length; i++) {
    if (!volume[i]) continue;
    const c = [i % sx, Math.floor(i / sx) % sy, Math.floor(i / (sx * sy))];
    for (let a = 0; a < 3; a++) {
      if (c[a] < min[a]) min[a] = c[a];
      if (c[a] > max[a]) max[a] = c[a];
    }
  }
  return max[0] < 0 ? null : { min, max };
}

/**
 * The lattice corners of cells that are filled in any of `volumes` and have an empty side: all the
 * points the model's outline can pass through, as flat x, y, z coordinates.
 */
export function exposedCorners(volumes: readonly Uint8Array[], size: Vec3): Float64Array {
  const [sx, sy, sz] = size;
  const lx = sx + 1, ly = sy + 1;
  const marked = new Uint8Array(lx * ly * (sz + 1));
  let count = 0;
  for (const v of volumes) {
    const filled = (x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz && v[x + sx * (y + sy * z)] !== 0;
    for (let z = 0; z < sz; z++)
      for (let y = 0; y < sy; y++)
        for (let x = 0; x < sx; x++) {
          if (!v[x + sx * (y + sy * z)]) continue;
          if (filled(x - 1, y, z) && filled(x + 1, y, z) && filled(x, y - 1, z) && filled(x, y + 1, z) && filled(x, y, z - 1) && filled(x, y, z + 1)) continue;
          for (let i = 0; i < 8; i++) {
            const c = x + (i & 1) + lx * (y + ((i >> 1) & 1) + ly * (z + (i >> 2)));
            if (!marked[c]) {
              marked[c] = 1;
              count++;
            }
          }
        }
  }
  const out = new Float64Array(count * 3);
  let n = 0;
  for (let i = 0; i < marked.length; i++) {
    if (!marked[i]) continue;
    out[n++] = i % lx;
    out[n++] = Math.floor(i / lx) % ly;
    out[n++] = Math.floor(i / (lx * ly));
  }
  return out;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The camera's forward, right and up vectors; straight up or down, screen up is -z or +z, as in the viewport. */
function basis({ yaw, pitch }: RenderCamera) {
  const cp = Math.cos(pitch);
  const forward: Vec3 = [-cp * Math.sin(yaw), -Math.sin(pitch), -cp * Math.cos(yaw)];
  const right: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
  return { forward, right, up: cross(right, forward) };
}

/**
 * Render a volume (palette indices, x-major) to RGBA pixels, top row first. Only the cells of
 * `options.frame` (or the filled ones) are drawn, scaled to fill the image.
 */
export function renderVolume(volume: Uint8Array, size: Vec3, palette: readonly number[], options: RenderOptions): Uint8Array {
  const { width, height, background } = options;
  const out = new Uint8Array(width * height * 4);
  const bg = background === null ? [0, 0, 0, 0] : [(background >> 16) & 255, (background >> 8) & 255, background & 255, 255];
  const box = options.frame ?? volumeBounds(volume, size);
  if (!box) {
    for (let i = 0; i < out.length; i += 4) out.set(bg, i);
    return out;
  }

  // crop to the box, so rays only walk cells that can be hit
  const min = box.min.map((v, a) => Math.max(0, Math.min(size[a] - 1, v))) as Vec3;
  const max = box.max.map((v, a) => Math.max(min[a], Math.min(size[a] - 1, v))) as Vec3;
  const crop: Vec3 = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
  const cells = new Uint8Array(crop[0] * crop[1] * crop[2]);
  for (let z = 0; z < crop[2]; z++)
    for (let y = 0; y < crop[1]; y++) {
      const from = min[0] + size[0] * (min[1] + y + size[1] * (min[2] + z));
      cells.set(volume.subarray(from, from + crop[0]), crop[0] * (y + crop[1] * z));
    }
  const [cx, cy, cz] = crop;
  const solid = (x: number, y: number, z: number) =>
    x >= 0 && y >= 0 && z >= 0 && x < cx && y < cy && z < cz && cells[x + cx * (y + cy * z)] !== 0 ? 1 : 0;

  // fit the model's outline to the image: the corners of its exposed cells, around the box's center
  const { forward, right, up } = basis(options.camera);
  const aspect = width / height;
  let points = options.fit ?? exposedCorners([volume], size);
  if (!points.length) points = new Float64Array([min, [max[0] + 1, max[1] + 1, max[2] + 1]].flat());
  const center: Vec3 = [cx / 2, cy / 2, cz / 2];
  const rel: Vec3[] = [];
  for (let i = 0; i < points.length; i += 3) {
    rel.push([points[i] - min[0] - center[0], points[i + 1] - min[1] - center[1], points[i + 2] - min[2] - center[2]]);
  }
  const fill = 1 - 2 * MARGIN;
  const perspective = options.camera.projection === "perspective";
  // far enough that the near side isn't distorted much; in perspective, as near as the viewport's field of view frames it
  let distance = Math.hypot(cx, cy, cz) * 2;
  if (perspective) {
    const tanY = Math.tan(FOV / 2);
    distance = 0;
    for (const r of rel) {
      const toward = -dot(r, forward);
      distance = Math.max(distance, toward + Math.max(Math.abs(dot(r, right)) / aspect, Math.abs(dot(r, up))) / tanY, toward + 0.5);
    }
  }
  // the outline's extent on screen (in perspective, as slopes from the eye), centered and zoomed to fill
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const r of rel) {
    const depth = perspective ? distance + dot(r, forward) : 1;
    const x = dot(r, right) / depth;
    const y = dot(r, up) / depth;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const halfY = Math.max((x1 - x0) / 2 / aspect, (y1 - y0) / 2, 1e-6) / fill;
  const shiftX = (x0 + x1) / 2;
  const shiftY = (y0 + y1) / 2;
  const halfX = halfY * aspect;
  const eye: Vec3 = [0, 1, 2].map((a) => center[a] - forward[a] * distance) as Vec3;

  /** The shaded color where a ray through screen point (sx, sy), each -1 to 1, lands; null on a miss. */
  const shade = (sx: number, sy: number): Vec3 | null => {
    const px = shiftX + sx * halfX;
    const py = shiftY + sy * halfY;
    let origin = eye;
    let dir: Vec3;
    if (perspective) {
      dir = [0, 1, 2].map((a) => forward[a] + right[a] * px + up[a] * py) as Vec3;
      const n = Math.hypot(...dir);
      dir = dir.map((v) => v / n) as Vec3;
    } else {
      origin = [0, 1, 2].map((a) => eye[a] + right[a] * px + up[a] * py) as Vec3;
      dir = forward;
    }
    const hit = raycastVolume({ origin, dir }, crop, (i) => cells[i] !== 0);
    if (!hit) return null;
    const [x, y, z] = hit.cell;
    const axis = hit.normal[0] ? 0 : hit.normal[1] ? 1 : 2;
    const positive = hit.normal[axis] > 0;
    // ambient occlusion at the face's corners, as the mesher computes it, blended across the face
    const n = [x + hit.normal[0], y + hit.normal[1], z + hit.normal[2]];
    const ua = (axis + 1) % 3;
    const va = (axis + 2) % 3;
    const at = (du: number, dv: number) => {
      const c = [n[0], n[1], n[2]];
      c[ua] += du;
      c[va] += dv;
      return solid(c[0], c[1], c[2]);
    };
    const corner = (du: number, dv: number) => {
      const s1 = at(du, 0);
      const s2 = at(0, dv);
      return AO_SHADE[s1 && s2 ? 3 : s1 + s2 + at(du, dv)];
    };
    const point = [0, 1, 2].map((a) => origin[a] + dir[a] * hit.distance);
    const fu = Math.min(1, Math.max(0, point[ua] - hit.cell[ua]));
    const fv = Math.min(1, Math.max(0, point[va] - hit.cell[va]));
    const ao =
      corner(-1, -1) * (1 - fu) * (1 - fv) + corner(1, -1) * fu * (1 - fv) + corner(1, 1) * fu * fv + corner(-1, 1) * (1 - fu) * fv;
    const f = FACE_SHADE[axis * 2 + (positive ? 1 : 0)] * ao;
    const color = palette[cells[x + cx * (y + cy * z)]] ?? 0;
    return [((color >> 16) & 255) * f, ((color >> 8) & 255) * f, (color & 255) * f];
  };

  const samples = Math.max(1, Math.round(options.samples ?? 2));
  const per = samples * samples;
  for (let py = 0; py < height; py++)
    for (let px = 0; px < width; px++) {
      let r = 0, g = 0, b = 0, covered = 0;
      for (let j = 0; j < samples; j++)
        for (let i = 0; i < samples; i++) {
          const sx = ((px + (i + 0.5) / samples) / width) * 2 - 1;
          const sy = 1 - ((py + (j + 0.5) / samples) / height) * 2;
          const c = shade(sx, sy);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2];
          covered++;
        }
      const o = (px + width * py) * 4;
      const a = covered / per;
      if (background === null) {
        // straight alpha: the covered samples' color, as opaque as the share that hit
        out[o] = covered ? r / covered : 0;
        out[o + 1] = covered ? g / covered : 0;
        out[o + 2] = covered ? b / covered : 0;
        out[o + 3] = Math.round(a * 255);
      } else {
        const miss = per - covered;
        out[o] = (r + bg[0] * miss) / per;
        out[o + 1] = (g + bg[1] * miss) / per;
        out[o + 2] = (b + bg[2] * miss) / per;
        out[o + 3] = 255;
      }
    }
  return out;
}

/** Union of boxes, or null if there are none. */
export function unionBox(boxes: readonly (Box | null)[]): Box | null {
  let out: Box | null = null;
  for (const b of boxes) {
    if (!b) continue;
    out = out
      ? { min: out.min.map((v, a) => Math.min(v, b.min[a])) as Vec3, max: out.max.map((v, a) => Math.max(v, b.max[a])) as Vec3 }
      : { min: [...b.min], max: [...b.max] };
  }
  return out;
}

/** Copy `tile` (RGBA, `w` × `h`) into `sheet` (RGBA, `sheetWidth` wide) at (x, y). */
export function blit(sheet: Uint8Array, sheetWidth: number, tile: Uint8Array, w: number, h: number, x: number, y: number) {
  for (let row = 0; row < h; row++) sheet.set(tile.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * sheetWidth + x) * 4);
}

/** A view to render: a named one, or orbit angles in degrees as the viewport's camera takes them. */
export type ShotView = CameraView | { yaw: number; pitch: number };

export interface ShotOptions {
  views: readonly ShotView[];
  /** Frame ids, in order; defaults to the open frame. */
  frames?: readonly string[];
  /** Defaults to orthographic for the axis views and perspective for the rest. */
  projection?: ProjectionMode;
  /** Each tile's size in pixels. */
  width: number;
  height: number;
  background: number | null;
  /** Only these layers (ids), visible or not; defaults to the visible ones. */
  layers?: readonly string[];
}

export interface Shot {
  width: number;
  height: number;
  /** RGBA, top row first. */
  pixels: Uint8Array;
  columns: number;
  rows: number;
  /** The tiles in reading order: left to right, then top to bottom. */
  tiles: { view: ShotView; frame: string; x: number; y: number }[];
}

/** Space between tiles, and its color on an opaque background. */
const GAP = 4;
const GAP_SHADE = 0.92;

/**
 * Render an editor's model from several views and frames into one image. With several frames and
 * several views, each row is a frame and each column a view; otherwise the tiles wrap into a grid.
 * Every tile frames the same box, the model's bounds over all the frames, so motion shows.
 */
export function renderShot(editor: Editor, options: ShotOptions): Shot {
  const frames = options.frames?.length ? options.frames : [editor.frames[editor.activeFrameIndex].id];
  const volumes = frames.map((id) => editor.evaluateFrame(id, options.layers ? { layers: options.layers } : {}));
  const size = editor.size;
  const frame = unionBox(volumes.map((v) => volumeBounds(v, size))) ?? undefined;
  const fit = exposedCorners(volumes, size);
  const { views, width, height, background } = options;
  const count = views.length * frames.length;
  const columns = views.length > 1 && frames.length > 1 ? views.length : Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const sheetWidth = columns * width + (columns - 1) * GAP;
  const sheetHeight = rows * height + (rows - 1) * GAP;
  const pixels = new Uint8Array(sheetWidth * sheetHeight * 4);
  if (background !== null) {
    const gap = [(background >> 16) & 255, (background >> 8) & 255, background & 255].map((c) => Math.round(c * GAP_SHADE));
    for (let i = 0; i < pixels.length; i += 4) pixels.set([...gap, 255], i);
  }
  const tiles: Shot["tiles"] = [];
  frames.forEach((id, f) =>
    views.forEach((view, v) => {
      const n = f * views.length + v;
      const x = (n % columns) * (width + GAP);
      const y = Math.floor(n / columns) * (height + GAP);
      const angles = typeof view === "string" ? VIEW_ANGLES[view] : { yaw: (view.yaw * Math.PI) / 180, pitch: (view.pitch * Math.PI) / 180 };
      const projection = options.projection ?? (typeof view === "string" && view !== "iso" ? "orthographic" : "perspective");
      const tile = renderVolume(volumes[f], size, editor.palette, { width, height, background, frame, fit, camera: { ...angles, projection } });
      blit(pixels, sheetWidth, tile, width, height, x, y);
      tiles.push({ view, frame: id, x, y });
    }),
  );
  return { width: sheetWidth, height: sheetHeight, pixels, columns, rows, tiles };
}
