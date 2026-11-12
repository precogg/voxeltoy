// The evaluator: document source in, a dense palette-indexed volume out. Pure and DOM-free; it
// never changes its inputs, allocates palette entries or records history. The editor's display
// composite and every flat export are built from it.
//
// It is a pipeline (docs/pipeline.md): stages folded bottom to top. A stage has content, an alpha
// and a value per cell, and a blend that says how that content combines with what is below. Layers
// are the document's stages; a shape layer is an isolated group whose stages are its steps.

import { applyEffects, type Effect } from "./effects";
import { insideShape } from "./shapes";
import { spanCells, type ShapeSource, type Step, type StepShape } from "./source";
import type { Vec3 } from "./types";

/** The output grid: `size` cells a side, `resolution` cells per source unit. */
export interface Grid {
  size: Vec3;
  resolution: number;
}

/** What evaluation reads of a layer. */
export interface SourceLayer {
  /** Names the layer for the evaluation cache. */
  readonly id?: string;
  readonly data: Uint8Array;
  readonly coverage?: Uint8Array;
  readonly shape?: ShapeSource;
  readonly visible?: boolean;
  /** How it combines with what is below; unset is its kind's (`layerBlend`). */
  readonly blend?: Blend;
  /** Where it acts (1); elsewhere it does nothing at all. Unset: everywhere. */
  readonly mask?: Uint8Array;
  readonly effects?: readonly Effect[];
  /** The group it is in, by id. */
  readonly group?: string;
}

/**
 * What evaluation reads of a group: an isolated stage whose content is its members (layers and
 * groups that name it) composed from empty, then its effects, then its blend onto what is below.
 * It sits in the stack where its lowest member is.
 */
export interface SourceGroup {
  readonly id: string;
  readonly visible?: boolean;
  readonly blend?: Blend;
  readonly effects?: readonly Effect[];
  /** The group it is in, by id. */
  readonly group?: string;
}

const cellCount = (size: Vec3) => size[0] * size[1] * size[2];

// #region Shapes

/** The cells a step's shape samples on each axis, clipped to the grid: `lo` inclusive to `hi` exclusive. Null when it samples none. */
function shapeRange(shape: StepShape, grid: Grid): { lo: Vec3; hi: Vec3 } | null {
  const lo: Vec3 = [0, 0, 0];
  const hi: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const [l, h] = spanCells(shape.min[a], shape.max[a], grid.resolution);
    lo[a] = Math.max(0, l);
    hi[a] = Math.min(grid.size[a], h);
    if (hi[a] <= lo[a]) return null;
  }
  return { lo, hi };
}

// #region Blends

/**
 * What a stage does to the cells below where its alpha is set: `union` fills them with its solid
 * content; `replace` makes them its content, so an empty one erases; `subtract` empties them where
 * its content is solid; `intersect` empties every cell where its content isn't solid (outside its
 * alpha too); `none` leaves solidity alone and only recolors. See docs/pipeline.md.
 */
export type Occupancy = "union" | "replace" | "subtract" | "intersect" | "none";

/** How a stage's content combines with the volume below it. */
export interface Blend {
  readonly occupancy: Occupancy;
  /** Where a cell is solid below and stays solid, keep the color below rather than the stage's. */
  readonly keep: boolean;
}

export const UNION: Blend = { occupancy: "union", keep: false };
export const REPLACE: Blend = { occupancy: "replace", keep: false };

/** A step's blend: add is a union, cut a subtract, intersect an intersect, paint none; `keep` is the step's. */
export function stepBlend(step: Pick<Step, "mode" | "keep">): Blend {
  const keep = !!step.keep;
  switch (step.mode) {
    case "add":
      return { occupancy: "union", keep };
    case "cut":
      return { occupancy: "subtract", keep: false };
    case "intersect":
      return { occupancy: "intersect", keep };
    case "paint":
      return { occupancy: "none", keep: false };
  }
}

/** A layer's blend: its own, or by kind: an override replaces within its coverage; raster and shape layers are unions. */
export function layerBlend(layer: Pick<SourceLayer, "coverage" | "shape" | "blend">): Blend {
  return layer.blend ?? (layer.coverage && !layer.shape ? REPLACE : UNION);
}

/** Whether two blends are the same. */
export const sameBlend = (a: Blend, b: Blend) => a.occupancy === b.occupancy && a.keep === b.keep;

export const OCCUPANCIES: readonly Occupancy[] = ["union", "replace", "subtract", "intersect", "none"];

/** Check a blend from anywhere and return a clean copy, or throw an Error saying what is wrong. */
export function checkBlend(raw: unknown): Blend {
  const b = raw as Blend;
  if (!b || typeof b !== "object" || !OCCUPANCIES.includes(b.occupancy)) throw new Error(`A blend's occupancy is one of ${OCCUPANCIES.join(", ")}`);
  if (b.keep !== undefined && typeof b.keep !== "boolean") throw new Error("A blend's keep is true or false");
  return { occupancy: b.occupancy, keep: !!b.keep };
}

/**
 * One cell of a stage blended onto the value below it: `alpha` is whether the stage has content
 * there, `value` that content (0 empty, otherwise a palette index). Returns the cell's new value.
 */
export function blendCell(below: number, alpha: boolean, value: number, blend: Blend): number {
  switch (blend.occupancy) {
    case "union":
      return alpha && value ? (blend.keep && below ? below : value) : below;
    case "replace":
      return alpha ? (value ? (blend.keep && below ? below : value) : 0) : below;
    case "subtract":
      return alpha && value ? 0 : below;
    case "intersect":
      return alpha && value ? (blend.keep || !below ? below : value) : 0;
    case "none":
      return alpha && value && below ? (blend.keep ? below : value) : below;
  }
}

// #endregion

/**
 * Apply one step to a layer's volume so far (0 = empty, otherwise a palette index), in place: the
 * step's shape is its alpha, its material (or fill) its value, and `stepBlend` how they combine.
 */
export function applyStep(step: Step, grid: Grid, volume: Uint8Array) {
  const [sx, sy, sz] = grid.size;
  const { shape } = step;
  const blend = stepBlend(step);
  const { occupancy } = blend;
  const range = shapeRange(shape, grid);
  let m = step.material;
  const touch = (i: number) => {
    volume[i] = blendCell(volume[i], true, m, blend);
  };
  if (occupancy === "intersect") {
    // outside the shape the step has no content, so an intersect empties it
    if (!range) {
      volume.fill(0);
      return;
    }
    const { lo, hi } = range;
    for (let z = 0; z < sz; z++)
      for (let y = 0; y < sy; y++) {
        const row = sx * (y + sy * z);
        if (z < lo[2] || z >= hi[2] || y < lo[1] || y >= hi[1]) {
          volume.fill(0, row, row + sx);
          continue;
        }
        volume.fill(0, row, row + lo[0]);
        volume.fill(0, row + hi[0], row + sx);
      }
  }
  if (!range) return;
  const { lo, hi } = range;
  // a plain box fills its whole box: no test per cell
  if (shape.kind === "prism" && shape.sides === 4 && !shape.taper && !shape.sweep && !shape.round && !shape.roundTop && !shape.roundBottom && !shape.shell && !step.fill) {
    for (let z = lo[2]; z < hi[2]; z++)
      for (let y = lo[1]; y < hi[1]; y++) {
        const row = sx * (y + sy * z);
        const start = row + lo[0];
        const end = row + hi[0];
        if (occupancy === "subtract") volume.fill(0, start, end);
        else if (occupancy === "union" && !blend.keep && m) volume.fill(m, start, end);
        else for (let i = start; i < end; i++) touch(i);
      }
    return;
  }
  const inside = insideShape(shape);
  const color = step.fill && fillColor(step);
  const r = grid.resolution;
  const p: Vec3 = [0, 0, 0];
  for (let z = lo[2]; z < hi[2]; z++) {
    p[2] = (z + 0.5) / r;
    for (let y = lo[1]; y < hi[1]; y++) {
      p[1] = (y + 0.5) / r;
      const row = sx * (y + sy * z);
      for (let x = lo[0]; x < hi[0]; x++) {
        p[0] = (x + 0.5) / r;
        if (!inside(p)) {
          if (occupancy === "intersect") volume[row + x] = 0;
          continue;
        }
        if (color) m = color(p);
        touch(row + x);
      }
    }
  }
}

/** A step's color at a point (source units) inside its shape, for a step with a fill. */
export function fillColor(step: Step): (p: Vec3) => number {
  const { fill, material: from, shape } = step;
  const { min, max } = shape;
  const { to, axis = 1, size = 1 } = fill!;
  switch (fill!.kind) {
    case "gradient": {
      const span = Math.abs(to - from);
      const dir = to > from ? 1 : -1;
      const ext = max[axis] - min[axis];
      // slot k of span + 1 covers an equal share of the box
      return (p) => from + dir * Math.min(span, Math.floor(((p[axis] - min[axis]) / ext) * (span + 1)));
    }
    case "checker":
      return (p) =>
        (Math.floor((p[0] - min[0]) / size) + Math.floor((p[1] - min[1]) / size) + Math.floor((p[2] - min[2]) / size)) & 1 ? to : from;
    case "stripes":
      return (p) => (Math.floor((p[axis] - min[axis]) / size) & 1 ? to : from);
  }
}

/**
 * Evaluate a shape layer's steps on a grid, bottom first: per cell, 0 where it isn't solid,
 * otherwise its material. Writes into `out` (cleared first) when given.
 */
export function evaluateSource(source: ShapeSource, grid: Grid, out?: Uint8Array): Uint8Array {
  const count = cellCount(grid.size);
  const volume = out && out.length === count ? out : new Uint8Array(count);
  volume.fill(0);
  for (const step of source.steps) applyStep(step, grid, volume);
  return volume;
}

interface Evaluated {
  source: ShapeSource;
  size: Vec3;
  resolution: number;
  values: Uint8Array;
}

interface LayerCache {
  /** The latest results, newest first: a draft and the committed source take turns while a step is dragged. */
  results: Evaluated[];
  /** The steps evaluated last, to find what the next evaluation shares with it. */
  last: readonly Step[];
  /** The volume after the first `at` of `steps`, to start from when only steps above it change. */
  checkpoint: { steps: readonly Step[]; at: number; size: Vec3; resolution: number; volume: Uint8Array } | null;
}

const sameGrid = (a: { size: Vec3; resolution: number }, b: Grid) =>
  a.resolution === b.resolution && a.size.every((n, i) => n === b.size[i]);

/**
 * Evaluated shape sources, per layer. Sources are immutable (an edit makes a new one, sharing the
 * steps it didn't change), so a source object identifies its result. Each layer keeps its last two
 * results, so the undo history doesn't keep old volumes alive, and a checkpoint: the volume below
 * the first step that changed between its last two evaluations. Dragging a step then only
 * re-evaluates that step and the ones above it.
 */
export class SourceCache {
  private layers = new Map<string, LayerCache>();

  /** `key` names the layer (its id); sources without one share a slot. */
  get(source: ShapeSource, grid: Grid, key = ""): Uint8Array {
    let layer = this.layers.get(key);
    if (!layer) this.layers.set(key, (layer = { results: [], last: [], checkpoint: null }));
    const hit = layer.results.find((r) => r.source === source && sameGrid(r, grid));
    if (hit) return hit.values;

    const steps = source.steps;
    // where the steps part from the last ones evaluated: the step being dragged
    let shared = 0;
    while (shared < steps.length && shared < layer.last.length && steps[shared] === layer.last[shared]) shared++;
    layer.last = steps;

    const count = cellCount(grid.size);
    const values = new Uint8Array(count);
    let from = 0;
    const cp = layer.checkpoint;
    if (cp && cp.at <= steps.length && sameGrid(cp, grid) && cp.steps.slice(0, cp.at).every((s, i) => s === steps[i])) {
      values.set(cp.volume);
      from = cp.at;
    }
    // keep a checkpoint where this source parts from the last one, if that is above where we start
    const save = shared > from && shared < steps.length ? shared : -1;
    for (let i = from; i < steps.length; i++) {
      if (i === save) layer.checkpoint = { steps, at: i, size: [...grid.size], resolution: grid.resolution, volume: values.slice() };
      applyStep(steps[i], grid, values);
    }
    layer.results = [{ source, size: [...grid.size], resolution: grid.resolution, values }, ...layer.results.slice(0, 1)];
    return values;
  }

  /** Forget layers that are gone. */
  keep(keys: Iterable<string>) {
    const live = new Set(keys);
    for (const key of this.layers.keys()) if (key && !live.has(key)) this.layers.delete(key);
  }
}

// #endregion

// #region Composition

export interface ComposeOptions {
  /** Evaluated shape sources, to reuse across calls. */
  cache?: SourceCache;
  /** Which layers take part. Defaults to the visible ones. */
  include?: (layer: SourceLayer, index: number) => boolean;
  /** A shape source to use instead of the layer's own (a draft being edited). */
  shapeOf?: (layer: SourceLayer, index: number) => ShapeSource | undefined;
  /** Whether a solid value at a cell shows; a hidden one contributes nothing there. */
  shows?: (index: number, value: number) => boolean;
  /** Cells of one layer that contribute nothing (content lifted off it while it moves). */
  skip?: { layer: SourceLayer; mask: Uint8Array };
  /** The groups layers name. Layers in a group that isn't listed are composed as if ungrouped. */
  groups?: readonly SourceGroup[];
  /** Which groups take part. Defaults to the visible ones. */
  includeGroup?: (group: SourceGroup) => boolean;
}

/**
 * Blend a stage's content onto `volume` (the stages below it), in place. `values` is the content;
 * `alpha` its coverage, or null where a solid value is its own alpha. A cell whose solid value
 * `shows` turns down, or that `skip` marks, has no content.
 */
export function blendStage(
  volume: Uint8Array,
  values: Uint8Array,
  alpha: Uint8Array | null,
  blend: Blend,
  filter: { shows?: (index: number, value: number) => boolean; skip?: Uint8Array | null; mask?: Uint8Array | null } = {},
) {
  const count = volume.length;
  const { shows, skip, mask } = filter;
  if (mask) {
    // outside its mask a stage does nothing at all, not even an intersect's emptying
    for (let i = 0; i < count; i++) {
      if (!mask[i]) continue;
      const v = values[i];
      let a = alpha ? alpha[i] !== 0 : v !== 0;
      if (a && skip && skip[i]) a = false;
      if (a && v && shows && !shows(i, v)) a = false;
      if (!a && blend.occupancy !== "intersect") continue;
      volume[i] = blendCell(volume[i], a, v, blend);
    }
    return;
  }
  if (!alpha && !shows && !skip && blend.occupancy === "union" && !blend.keep) {
    for (let i = 0; i < count; i++) if (values[i]) volume[i] = values[i];
    return;
  }
  const intersect = blend.occupancy === "intersect";
  for (let i = 0; i < count; i++) {
    const v = values[i];
    let a = alpha ? alpha[i] !== 0 : v !== 0;
    if (a && skip && skip[i]) a = false;
    if (a && v && shows && !shows(i, v)) a = false;
    if (!a && !intersect) continue;
    volume[i] = blendCell(volume[i], a, v, blend);
  }
}

/** A stage of the stack: a layer (by its index in the list), or a group of stages. */
export type StageNode = { kind: "layer"; layer: SourceLayer; index: number } | { kind: "group"; group: SourceGroup; children: StageNode[] };

/**
 * The stack as a tree, bottom first: layers outside groups, and each group where its lowest member
 * is, holding its members in order. Groups without members, and links to groups that aren't listed
 * (or that would loop), drop out, so every layer is in the tree once.
 */
export function stageTree(layers: readonly SourceLayer[], groups: readonly SourceGroup[] = []): StageNode[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  /** A group's chain of groups, innermost first, cut where it would loop. */
  const chain = (id: string | undefined): SourceGroup[] => {
    const out: SourceGroup[] = [];
    const seen = new Set<string>();
    for (let g = id ? byId.get(id) : undefined; g && !seen.has(g.id); g = g.group ? byId.get(g.group) : undefined) {
      seen.add(g.id);
      out.push(g);
    }
    return out;
  };
  const roots: StageNode[] = [];
  const nodes = new Map<string, Extract<StageNode, { kind: "group" }>>();
  layers.forEach((layer, index) => {
    const groupsOf = chain(layer.group).reverse(); // outermost first
    let into = roots;
    for (const g of groupsOf) {
      let node = nodes.get(g.id);
      if (!node) {
        node = { kind: "group", group: g, children: [] };
        nodes.set(g.id, node);
        into.push(node);
      }
      into = node.children;
    }
    into.push({ kind: "layer", layer, index });
  });
  return roots;
}

/** Whether a stack has effects anywhere, which make a cell depend on its neighbors. */
export function hasEffects(layers: readonly SourceLayer[], groups: readonly SourceGroup[] = []): boolean {
  return layers.some((l) => l.effects?.length) || groups.some((g) => g.effects?.length);
}

/**
 * Compose layers bottom to top into one volume, each blended by `layerBlend`: a solid sample
 * replaces what is below it; an unset sample leaves it; a covered empty override clears it. A
 * shape layer, and a group, are isolated: their content is evaluated from empty and blends as one
 * stage, after its effects. A mask limits where a layer acts. Writes into `out` when given.
 */
export function composeLayers(
  layers: readonly SourceLayer[],
  grid: Grid,
  options: ComposeOptions = {},
  out?: Uint8Array,
): Uint8Array {
  const count = cellCount(grid.size);
  const volume = out && out.length === count ? out : new Uint8Array(count);
  volume.fill(0);
  const include = options.include ?? ((l: SourceLayer) => l.visible !== false);
  const includeGroup = options.includeGroup ?? ((g: SourceGroup) => g.visible !== false);
  const shows = options.shows;
  const cache = options.cache ?? new SourceCache();

  /** A layer's content: its values and alpha (null where a solid value is its own), after its effects. */
  const content = (layer: SourceLayer, index: number): { values: Uint8Array; alpha: Uint8Array | null } | null => {
    const shape = options.shapeOf?.(layer, index) ?? layer.shape;
    let values: Uint8Array;
    let alpha: Uint8Array | null = null;
    if (shape) values = cache.get(shape, grid, layer.id ?? `#${index}`);
    else {
      if (layer.data.length !== count) return null;
      values = layer.data;
      alpha = layer.coverage ?? null;
    }
    if (!layer.effects?.length) return { values, alpha };
    // lifted cells leave before effects, so a mirror or outline doesn't keep them
    const skip = options.skip?.layer === layer ? options.skip.mask : null;
    if (skip) {
      values = values.slice();
      if (alpha) alpha = alpha.slice();
      for (let i = 0; i < count; i++) {
        if (!skip[i]) continue;
        values[i] = 0;
        if (alpha) alpha[i] = 0;
      }
    }
    return applyEffects(values, alpha, layer.effects, grid.size);
  };

  const compose = (nodes: readonly StageNode[], into: Uint8Array) => {
    for (const node of nodes) {
      if (node.kind === "layer") {
        const { layer, index } = node;
        if (!include(layer, index)) continue;
        const c = content(layer, index);
        if (!c) continue;
        const skip = !layer.effects?.length && options.skip?.layer === layer ? options.skip.mask : null;
        blendStage(into, c.values, c.alpha, layerBlend(layer), { shows, skip, mask: layer.mask?.length === count ? layer.mask : null });
        continue;
      }
      if (!includeGroup(node.group)) continue;
      const inner = new Uint8Array(count);
      compose(node.children, inner);
      const done = node.group.effects?.length ? applyEffects(inner, null, node.group.effects, grid.size).values : inner;
      blendStage(into, done, null, node.group.blend ?? UNION);
    }
  };
  compose(stageTree(layers, options.groups), volume);
  return volume;
}

/**
 * One cell of `composeLayers`, without the rest: what the stack gives at cell `i`. Only for stacks
 * without effects (see `hasEffects`), whose cells don't depend on their neighbors. `valueOf` gives
 * a layer's own value there (a shape layer's evaluation, a raster's voxel); `alphaOf` its coverage
 * there, for overrides.
 */
export function composeCell(
  nodes: readonly StageNode[],
  i: number,
  read: {
    include: (layer: SourceLayer, index: number) => boolean;
    includeGroup?: (group: SourceGroup) => boolean;
    valueOf: (layer: SourceLayer, index: number) => number;
    shows?: (index: number, value: number) => boolean;
    skip?: (layer: SourceLayer) => boolean;
  },
  below = 0,
): number {
  let at = below;
  const includeGroup = read.includeGroup ?? ((g: SourceGroup) => g.visible !== false);
  for (const node of nodes) {
    if (node.kind === "group") {
      if (!includeGroup(node.group)) continue;
      const inner = composeCell(node.children, i, read, 0);
      at = blendCell(at, inner !== 0, inner, node.group.blend ?? UNION);
      continue;
    }
    const { layer, index } = node;
    if (!read.include(layer, index)) continue;
    if (layer.mask && !layer.mask[i]) continue;
    const v = read.valueOf(layer, index);
    const coverage = !layer.shape && layer.coverage ? layer.coverage[i] !== 0 : null;
    let a = coverage ?? v !== 0;
    if (a && read.skip?.(layer)) a = false;
    if (a && v && read.shows && !read.shows(i, v)) a = false;
    const blend = layerBlend(layer);
    if (!a && blend.occupancy !== "intersect") continue;
    at = blendCell(at, a, v, blend);
  }
  return at;
}

/**
 * The committed result of a document: its visible layers composed, without any display filter
 * (slice, hidden values or cells), floating content or draft.
 */
export function evaluateDocument(
  doc: { size: Vec3; resolution?: number; layers: readonly SourceLayer[]; groups?: readonly SourceGroup[] },
  options: { cache?: SourceCache; allLayers?: boolean } = {},
): Uint8Array {
  return composeLayers(doc.layers, { size: doc.size, resolution: doc.resolution ?? 1 }, {
    cache: options.cache,
    groups: doc.groups,
    include: options.allLayers ? () => true : undefined,
    includeGroup: options.allLayers ? () => true : undefined,
  });
}

// #endregion

// #region Resampling

/** A raster on a new grid, after a resolution change. */
export interface Resampled {
  data: Uint8Array;
  coverage?: Uint8Array;
  /** Coarsening merged blocks that weren't uniform. */
  lossy: boolean;
}

/** Each cell becomes a uniform `factor`³ block. Exact. */
export function refineCells(values: Uint8Array, size: Vec3, factor: number): Uint8Array {
  const [sx, sy, sz] = size;
  const nx = sx * factor;
  const ny = sy * factor;
  const out = new Uint8Array(cellCount(size) * factor ** 3);
  for (let z = 0; z < sz * factor; z++) {
    const oz = Math.floor(z / factor);
    for (let y = 0; y < ny; y++) {
      const oy = Math.floor(y / factor);
      const row = nx * (y + ny * z);
      const src = sx * (oy + sy * oz);
      for (let x = 0; x < nx; x++) out[row + x] = values[src + Math.floor(x / factor)];
    }
  }
  return out;
}

/**
 * Resample a raster layer from `size` by `factor` (above 1 refines, below 1 coarsens). Coarsening
 * keeps each block's most common state, where unset, covered empty and each covered color are
 * distinct; ties go to covered over unset, then solid over empty, then the lowest color. For a
 * layer without coverage, zero counts as unset.
 */
export function resampleRaster(data: Uint8Array, coverage: Uint8Array | undefined, size: Vec3, factor: number): Resampled {
  if (factor >= 1) {
    return {
      data: refineCells(data, size, factor),
      ...(coverage ? { coverage: refineCells(coverage, size, factor) } : {}),
      lossy: false,
    };
  }
  const k = Math.round(1 / factor);
  const [sx, sy] = size;
  const out: Vec3 = [size[0] / k, size[1] / k, size[2] / k];
  const n = cellCount(out);
  const nextData = new Uint8Array(n);
  const nextCoverage = coverage ? new Uint8Array(n) : undefined;
  // states: 0 unset, 1 covered empty, v + 1 covered color v
  const counts = new Int32Array(257);
  const touched: number[] = [];
  let lossy = false;
  for (let z = 0, o = 0; z < out[2]; z++)
    for (let y = 0; y < out[1]; y++)
      for (let x = 0; x < out[0]; x++, o++) {
        touched.length = 0;
        for (let dz = 0; dz < k; dz++)
          for (let dy = 0; dy < k; dy++)
            for (let dx = 0; dx < k; dx++) {
              const i = x * k + dx + sx * (y * k + dy + sy * (z * k + dz));
              const v = data[i];
              const state = coverage ? (coverage[i] ? v + 1 : 0) : v ? v + 1 : 0;
              if (counts[state]++ === 0) touched.push(state);
            }
        let best = touched[0];
        for (const s of touched) {
          if (counts[s] > counts[best] || (counts[s] === counts[best] && rank(s) > rank(best))) best = s;
        }
        if (touched.length > 1) lossy = true;
        for (const s of touched) counts[s] = 0;
        if (best > 0) {
          nextData[o] = best - 1;
          if (nextCoverage) nextCoverage[o] = 1;
        }
      }
  return { data: nextData, ...(nextCoverage ? { coverage: nextCoverage } : {}), lossy };
}

/** Tie-break order for coarsening: unset < covered empty < covered colors, lower colors first. */
const rank = (state: number) => (state === 0 ? 0 : state === 1 ? 1 : 1000 - state);

/** A selection mask on a new grid: refining repeats each cell; coarsening keeps a cell if any of its block was selected. */
export function resampleMask(mask: Uint8Array, size: Vec3, factor: number): Uint8Array {
  if (factor >= 1) return refineCells(mask, size, factor);
  const k = Math.round(1 / factor);
  const [sx, sy] = size;
  const out: Vec3 = [size[0] / k, size[1] / k, size[2] / k];
  const next = new Uint8Array(cellCount(out));
  for (let z = 0; z < size[2]; z++)
    for (let y = 0; y < size[1]; y++)
      for (let x = 0; x < sx; x++) {
        if (!mask[x + sx * (y + sy * z)]) continue;
        next[Math.floor(x / k) + out[0] * (Math.floor(y / k) + out[1] * Math.floor(z / k))] = 1;
      }
  return next;
}

// #endregion
