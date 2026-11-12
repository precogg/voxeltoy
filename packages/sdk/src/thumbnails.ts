import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import type { Editor } from "@voxeltoy/core/editor";
import type { Box, Vec3 } from "@voxeltoy/core/types";
import type { Viewport } from "@voxeltoy/three/viewport";

/** CSS pixels per thumbnail side; drawn at up to twice that for sharp screens. */
const SIDE = 48;
/** How long the document must be still before thumbnails catch up. */
const SETTLE_MS = 250;
/** Thumbnails drawn per animation frame, so a long timeline doesn't stall the page. */
const PER_FRAME = 4;

/** FNV-1a over a volume, to notice which frames changed. */
function hashVolume(volume: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < volume.length; i++) h = Math.imul(h ^ volume[i], 0x01000193);
  return h >>> 0;
}

/** Inclusive bounds of a volume's filled cells, merged into `into`. */
function growBounds(volume: Uint8Array, size: Vec3, into: Box) {
  const [sx, sy] = size;
  for (let i = 0; i < volume.length; i++) {
    if (!volume[i]) continue;
    const c = [i % sx, Math.floor(i / sx) % sy, Math.floor(i / (sx * sy))];
    for (let a = 0; a < 3; a++) {
      if (c[a] < into.min[a]) into.min[a] = c[a];
      if (c[a] > into.max[a]) into.max[a] = c[a];
    }
  }
}

/**
 * Pictures of each frame's pose for the timeline, as image URLs by frame id. All frames share one
 * framing (around what any frame covers), so tiles line up like the poses do. They catch up a
 * moment after the document stops changing, and only frames whose voxels changed are redrawn.
 */
export function createThumbnails(editor: Editor, viewport: Accessor<Viewport | undefined>, active: Accessor<boolean>) {
  const [urls, setUrls] = createSignal<ReadonlyMap<string, string>>(new Map());
  /** What each thumbnail was drawn from: the frame's hash, and the framing and palette it used. */
  const drawn = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raf = 0;

  const refresh = () => {
    const vp = viewport();
    if (!vp || editor.playing) return;
    const frames = editor.frames;
    const size = editor.size;
    const volumes = frames.map((f) => editor.evaluateFrame(f.id));
    const bounds: Box = { min: [Infinity, Infinity, Infinity], max: [-1, -1, -1] };
    for (const v of volumes) growBounds(v, size, bounds);
    if (bounds.max[0] < 0) {
      bounds.min = [0, 0, 0];
      bounds.max = size.map((n) => n - 1) as Vec3;
    }
    const shared = `${bounds.min}|${bounds.max}|${size}|${editor.palette.join(",")}`;
    const todo: { id: string; key: string; volume: Uint8Array }[] = [];
    frames.forEach((f, i) => {
      const key = `${shared}|${hashVolume(volumes[i])}`;
      if (drawn.get(f.id) !== key) todo.push({ id: f.id, key, volume: volumes[i] });
    });
    // forget frames that are gone
    const ids = new Set(frames.map((f) => f.id));
    for (const id of drawn.keys()) if (!ids.has(id)) drawn.delete(id);
    const pixels = Math.round(SIDE * Math.min(2, window.devicePixelRatio || 1));
    cancelAnimationFrame(raf);
    const step = () => {
      const batch = todo.splice(0, PER_FRAME);
      if (!batch.length) return;
      const next = new Map(untrack(urls));
      for (const id of next.keys()) if (!ids.has(id)) next.delete(id);
      for (const { id, key, volume } of batch) {
        next.set(id, vp.snapshot(volume, bounds, pixels).toDataURL("image/png"));
        drawn.set(id, key);
      }
      setUrls(next);
      if (todo.length) raf = requestAnimationFrame(step);
    };
    step();
  };

  createEffect(() => {
    if (!active() || !viewport()) return;
    // anything that can change a pose's picture
    editor.documentVersion;
    editor.geometryVersion;
    editor.frames;
    editor.layers;
    editor.palette;
    editor.playing;
    clearTimeout(timer);
    timer = setTimeout(() => untrack(refresh), SETTLE_MS);
  });
  onCleanup(() => {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
  });

  return (id: string) => urls().get(id);
}

/** CSS pixels per layer thumbnail side (the Layers panel's tile on a phone); drawn at up to twice that. */
const LAYER_SIDE = 24;

/**
 * Pictures of each layer of the open frame on its own, for the Layers panel, as image URLs by layer
 * id. Each is framed on its own voxels, so a small part still reads at a tile's size (the whole
 * model's framing left most of them a speck). Hidden layers are drawn too. They catch up a moment after the document stops
 * changing, and only layers whose voxels changed are redrawn.
 */
export function createLayerThumbnails(editor: Editor, viewport: Accessor<Viewport | undefined>) {
  const [urls, setUrls] = createSignal<ReadonlyMap<string, string>>(new Map());
  const drawn = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raf = 0;

  const refresh = () => {
    const vp = viewport();
    if (!vp || editor.playing) return;
    const layers = editor.layers;
    const size = editor.size;
    const shared = `${size}|${editor.palette.join(",")}`;
    const todo: { id: string; key: string; volume: Uint8Array; bounds: Box }[] = [];
    for (const l of layers) {
      const volume = editor.layerValues(l);
      const key = `${shared}|${hashVolume(volume)}`;
      if (drawn.get(l.id) === key) continue;
      const bounds: Box = { min: [Infinity, Infinity, Infinity], max: [-1, -1, -1] };
      growBounds(volume, size, bounds);
      if (bounds.max[0] < 0) {
        bounds.min = [0, 0, 0];
        bounds.max = size.map((n) => n - 1) as Vec3;
      }
      todo.push({ id: l.id, key, volume, bounds });
    }
    const ids = new Set(layers.map((l) => l.id));
    for (const id of drawn.keys()) if (!ids.has(id)) drawn.delete(id);
    const pixels = Math.round(LAYER_SIDE * Math.min(2, window.devicePixelRatio || 1));
    cancelAnimationFrame(raf);
    const step = () => {
      const batch = todo.splice(0, PER_FRAME);
      const next = new Map(untrack(urls));
      for (const id of next.keys()) if (!ids.has(id)) next.delete(id);
      for (const { id, key, volume, bounds } of batch) {
        next.set(id, vp.snapshot(volume, bounds, pixels).toDataURL("image/png"));
        drawn.set(id, key);
      }
      setUrls(next);
      if (todo.length) raf = requestAnimationFrame(step);
    };
    step();
  };

  createEffect(() => {
    if (!viewport()) return;
    editor.documentVersion;
    editor.geometryVersion;
    editor.activeFrameId;
    editor.layers;
    editor.palette;
    editor.playing;
    clearTimeout(timer);
    timer = setTimeout(() => untrack(refresh), SETTLE_MS);
  });
  onCleanup(() => {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
  });

  return (id: string) => urls().get(id);
}
