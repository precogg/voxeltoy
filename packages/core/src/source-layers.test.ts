// Shape layers, override layers and resolutions: docs/vector-raster.md.
import { describe, expect, test } from "bun:test";
import { createAgentTools } from "./agent-tools";
import { Editor, isFlatDocument } from "./editor";
import { composeLayers, evaluateDocument, evaluateSource, resampleMask, resampleRaster, SourceCache, type SourceLayer } from "./evaluate";
import { parseMoxel, serializeMoxel } from "./formats/moxel";
import { applyOps, OpError, type DocOp } from "./ops";
import { limbEnds, SHAPE_KINDS, shapeMask, shapeOrientations, type Direction } from "./shapes";
import { boxStep, checkSource, sourceToCells, spanCells, stepFill, stepShape, type ShapeSource, type Step } from "./source";
import type { Ray, Vec3 } from "./types";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const down = (x: number, z: number): Ray => ({ origin: [x + 0.5, 100, z + 0.5], dir: [0, -1, 0] });

/** An editor with an 8³ grid. */
function editor(size: Vec3 = [8, 8, 8]) {
  const e = new Editor();
  e.newDocument(size);
  return e;
}

/** The composite value at a cell. */
const at = (e: Editor, c: Vec3) => e.composite[e.index(...c)];
const filled = (v: Uint8Array) => v.reduce((n, x) => n + (x ? 1 : 0), 0);

describe("source sampling", () => {
  test("boxes are half-open and sample cell centers", () => {
    expect(spanCells(0, 2, 1)).toEqual([0, 2]);
    expect(spanCells(0, 2, 2)).toEqual([0, 4]);
    // a face partway through a cell: the cell is in when its center is
    expect(spanCells(0.5, 1.5, 1)).toEqual([0, 1]);
    expect(spanCells(0.625, 1.5, 1)).toEqual([1, 1]);
    expect(sourceToCells({ min: [1, 0, 0], max: [3, 1, 2] }, 2)).toEqual({ min: [2, 0, 0], max: [5, 1, 3] });
  });

  test("validation rejects off-lattice, empty and malformed sources", () => {
    const one = (step: Step) => ({ steps: [step] });
    expect(() => checkSource(one(boxStep([0, 0, 0], [1, 1, 1], 1)), 2)).not.toThrow();
    expect(() => checkSource(one(boxStep([0.1, 0, 0], [1, 1, 1], 1)), 2)).toThrow("multiples of 1/8");
    expect(() => checkSource(one(boxStep([0, 0, 0], [0, 1, 1], 1)), 2)).toThrow("some size");
    expect(() => checkSource(one(boxStep([0, 0, 0], [1, 1, 1], 5)), 2)).toThrow("palette");
    const a = boxStep([0, 0, 0], [1, 1, 1], 1, "add", { id: "same" });
    expect(() => checkSource({ steps: [a, a] }, 2)).toThrow("share an id");
    expect(() => checkSource(one({ ...a, mode: "xor" } as unknown as Step), 2)).toThrow("Unknown step mode");
    expect(() => checkSource(one({ ...a, shape: { kind: "blob", min: [0, 0, 0], max: [1, 1, 1] } } as unknown as Step), 2)).toThrow("Unknown shape");
    // a vector layer with no shapes yet is fine; it shows nothing
    expect(checkSource({ steps: [] }, 2)).toEqual({ steps: [] });
    // the old Boolean tree form isn't read
    expect(() => checkSource({ id: "s", kind: "box", min: [0, 0, 0], max: [1, 1, 1], material: 1 }, 2)).toThrow("list of steps");
    // only known fields survive
    expect(checkSource(one({ ...a, extra: 1 } as Step), 2).steps[0]).toEqual(a);
  });

  test("each step applies its mode and color to everything below it", () => {
    const grid = { size: [4, 1, 1] as Vec3, resolution: 1 };
    const base = boxStep([0, 0, 0], [3, 1, 1], 1);
    const run = (mode: Step["mode"], keep = false) =>
      [...evaluateSource({ steps: [base, boxStep([2, 0, 0], [4, 1, 1], 2, mode, { keep })] }, grid)];
    expect(run("add")).toEqual([1, 1, 2, 2]);
    // keeping colors, an add only fills empty cells
    expect(run("add", true)).toEqual([1, 1, 1, 2]);
    expect(run("cut")).toEqual([1, 1, 0, 0]);
    expect(run("intersect")).toEqual([0, 0, 2, 0]);
    expect(run("intersect", true)).toEqual([0, 0, 1, 0]);
    // paint recolors without changing which cells are solid
    expect(run("paint")).toEqual([1, 1, 2, 0]);
    expect(run("paint", true)).toEqual([1, 1, 2, 0]);
    // a step outside the grid: intersect empties everything, the rest change nothing
    const outside = (mode: Step["mode"]) =>
      [...evaluateSource({ steps: [base, boxStep([9, 0, 0], [10, 1, 1], 2, mode)] }, grid)];
    expect(outside("intersect")).toEqual([0, 0, 0, 0]);
    expect(outside("paint")).toEqual([1, 1, 1, 0]);
  });
});

describe("step shapes", () => {
  /** Every kind in every orientation it has. */
  // every solid kind (a path's box is where its points reach, not the box it is given)
  const variants = SHAPE_KINDS.filter((kind) => kind !== "path").flatMap((kind) => {
    const turns: Direction[] = shapeOrientations(kind);
    return (turns.length ? turns : [{ axis: 1, sign: 1 } as Direction]).map((up) => ({ kind, up }));
  });

  test("at 1× a step covers exactly the cells the brush would", () => {
    const size: Vec3 = [7, 5, 6];
    const grid = { size, resolution: 1 };
    for (const { kind, up } of variants) {
      const step = boxStep([0, 0, 0], size, 1, "add", { kind, up });
      const brush = shapeMask({ kind, up, box: { min: [0, 0, 0], max: [6, 4, 5] } });
      expect([...evaluateSource({ steps: [step] }, grid)]).toEqual([...brush]);
    }
  });

  test("a shape keeps its size at finer resolutions", () => {
    for (const { kind, up } of variants) {
      const step = boxStep([0, 0, 0], [3, 4, 2], 1, "add", { kind, up });
      // the same shape in a box twice as big, at 1×, is the same set of cells
      const fine = evaluateSource({ steps: [step] }, { size: [6, 8, 4], resolution: 2 });
      const big = evaluateSource({ steps: [boxStep([0, 0, 0], [6, 8, 4], 1, "add", { kind, up })] }, { size: [6, 8, 4], resolution: 1 });
      expect(fine).toEqual(big);
    }
  });

  test("modes act on the shape, not its box", () => {
    const grid = { size: [4, 4, 4] as Vec3, resolution: 1 };
    const base = boxStep([0, 0, 0], [4, 4, 4], 1);
    const sphere = (mode: Step["mode"]) => evaluateSource({ steps: [base, boxStep([0, 0, 0], [4, 4, 4], 2, mode, { kind: "sphere" })] }, grid);
    const ball = shapeMask({ kind: "sphere", up: { axis: 1, sign: 1 }, box: { min: [0, 0, 0], max: [3, 3, 3] } });
    const inside = filled(ball);
    expect(inside).toBeGreaterThan(0);
    expect(inside).toBeLessThan(64);
    expect(filled(sphere("cut"))).toBe(64 - inside);
    expect(filled(sphere("intersect"))).toBe(inside);
    expect(sphere("paint").filter((v) => v === 2).length).toBe(inside);
  });

  test("options: wall, rounded corners, a frustum's top and a wedge's slope", () => {
    const grid = { size: [8, 8, 8] as Vec3, resolution: 1 };
    const count = (kind: Step["shape"]["kind"], options = {}) =>
      filled(evaluateSource({ steps: [boxStep([0, 0, 0], [8, 8, 8], 1, "add", { kind, ...options })] }, grid));
    // a wall: the shape less the same shape inset by it; too thick a wall is just solid
    expect(count("box", { shell: 1 })).toBe(512 - 216);
    expect(count("sphere", { shell: 1 })).toBeLessThan(count("sphere"));
    expect(count("box", { shell: 4 })).toBe(512);
    // rounding takes the corners off a box; a radius past half the box makes a sphere-like box
    expect(count("box", { round: 2 })).toBeLessThan(512);
    expect(count("box", { round: 2 })).toBeGreaterThan(count("box", { round: 4 }));
    // top and bottom edges take their own radii; the same radius everywhere is the plain rounded box
    const cells = (options = {}) => evaluateSource({ steps: [boxStep([0, 0, 0], [8, 8, 8], 1, "add", options)] }, grid);
    expect(cells({ round: 2, roundTop: 2, roundBottom: 2 })).toEqual(cells({ round: 2 }));
    expect(cells({ roundTop: 3, roundBottom: 3, round: 3 })).toEqual(cells({ round: 3 }));
    const at = (v: Uint8Array, x: number, y: number, z: number) => v[x + 8 * (y + 8 * z)];
    // a flat, sharp bottom under rounded sides and top: the bottom layer is a rounded rectangle
    const flatBottom = cells({ round: 2, roundBottom: 0 });
    expect(at(flatBottom, 0, 0, 4)).toBe(1);
    expect(at(flatBottom, 0, 0, 0)).toBe(0);
    expect(at(flatBottom, 0, 7, 4)).toBe(0);
    expect(count("box", { round: 2, roundBottom: 0 })).toBeGreaterThan(count("box", { round: 2 }));
    // a pillow top on a sharp box: every upright edge stays, only the top edges round
    const pillow = cells({ roundTop: 3 });
    expect(at(pillow, 0, 0, 0)).toBe(1);
    expect(at(pillow, 0, 4, 0)).toBe(1);
    expect(at(pillow, 0, 7, 4)).toBe(0);
    expect(at(pillow, 4, 7, 4)).toBe(1);
    // the bands share the height: radii that ask for more than it are scaled down, not overlapped
    expect(count("box", { round: 4, roundTop: 8, roundBottom: 8 })).toBeGreaterThan(0);
    // it is symmetric: a rounded top is a rounded bottom upside down
    const up = cells({ round: 1, roundTop: 3 });
    const down = cells({ round: 1, roundBottom: 3 });
    for (let z = 0; z < 8; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) expect(at(up, x, y, z)).toBe(at(down, x, 7 - y, z));
    // a limb in an upright box is an upright rounded tube: the same as a capsule there
    const tall = { steps: [boxStep([2, 0, 2], [6, 8, 6], 1, "add", { kind: "limb" })] };
    expect(evaluateSource(tall, grid)).toEqual(evaluateSource({ steps: [boxStep([2, 0, 2], [6, 8, 6], 1, "add", { kind: "capsule" })] }, grid));
    // in a cube it leans corner to corner: the base corner filled, the other low corners not
    const lean = (corner: number, options = {}) => evaluateSource({ steps: [boxStep([0, 0, 0], [8, 8, 8], 1, "add", { kind: "limb", radius: 1.5, corner, ...options })] }, grid);
    const cell = (v: Uint8Array, x: number, y: number, z: number) => v[x + 8 * (y + 8 * z)];
    expect(cell(lean(0), 1, 1, 1)).toBe(1);
    expect(cell(lean(0), 6, 6, 6)).toBe(1);
    expect(cell(lean(0), 6, 1, 1)).toBe(0);
    expect(cell(lean(1), 6, 1, 1)).toBe(1);
    expect(cell(lean(1), 1, 1, 1)).toBe(0);
    // a tip thinner than the base: less of it, and the base end the same
    expect(filled(lean(0, { tip: 0.5 }))).toBeLessThan(filled(lean(0)));
    expect(cell(lean(0, { tip: 0.5 }), 1, 1, 1)).toBe(1);
    expect(cell(lean(0), 5, 6, 6)).toBe(1);
    expect(cell(lean(0, { tip: 0.5 }), 5, 6, 6)).toBe(0);
    // a tapered limb in an upright box stands straight: its line is the box's middle
    expect(limbEnds({ min: [2, 0, 2], max: [4, 8, 4], radius: 1, tip: 0.5 })).toEqual({ from: [3, 1, 3], to: [3, 7, 3], radius: 1, tip: 0.5 });
    // a hollow limb is a thinner tube taken out of it
    expect(filled(lean(0, { shell: 0.5 }))).toBeLessThan(filled(lean(0)));
    expect(filled(lean(0, { shell: 0.5 }))).toBeGreaterThan(0);
    // a frustum keeps more than a cone, less than a cylinder
    expect(count("cone", { top: 0.5 })).toBeGreaterThan(count("cone"));
    expect(count("cone", { top: 0.5 })).toBeLessThan(count("cylinder"));
    // a wedge is half a box, whichever way it faces
    for (const forward of [{ axis: 2, sign: 1 }, { axis: 0, sign: -1 }] as Direction[]) {
      const v = evaluateSource({ steps: [boxStep([0, 0, 0], [8, 8, 8], 1, "add", { kind: "wedge", forward })] }, grid);
      expect(filled(v)).toBe(36 * 8);
      // full height at the back, nothing at the far top edge it faces
      const back: Vec3 = forward.axis === 2 ? [4, 7, 0] : [7, 7, 4];
      const front: Vec3 = forward.axis === 2 ? [4, 7, 7] : [0, 7, 4];
      expect(v[back[0] + 8 * (back[1] + 8 * back[2])]).toBe(1);
      expect(v[front[0] + 8 * (front[1] + 8 * front[2])]).toBe(0);
    }
  });

  test("explicit box radii survive changing round through matching values", () => {
    const e = new Editor();
    const id = e.newShapeLayer()!;
    const step = e.addStep(id, "add", { min: [0, 0, 0], max: [4, 4, 4] }, 1, { kind: "box", round: 1, roundTop: 0, roundBottom: 1 })!;
    for (const round of [0, 1, 2]) {
      e.setStepShape(id, step, { round });
      expect(e.shapeStack(id)!.find((s) => s.id === step)!.shape).toMatchObject({ roundTop: 0, roundBottom: 1 });
    }
  });

  test("shapes are stored canonically and checked", () => {
    // a box, cylinder, cone or pyramid is a prism, which has a top: it points any of six ways
    expect(stepShape("box", [0, 0, 0], [1, 1, 1], { up: { axis: 0, sign: -1 } })).toEqual({ kind: "prism", min: [0, 0, 0], max: [1, 1, 1], up: { axis: 0, sign: -1 }, sides: 4 });
    expect(stepShape("capsule", [0, 0, 0], [1, 1, 1], { up: { axis: 0, sign: -1 } }).up).toEqual({ axis: 0, sign: 1 });
    expect(stepShape("cone", [0, 0, 0], [1, 1, 1], { up: { axis: 0, sign: -1 } }).up).toEqual({ axis: 0, sign: -1 });
    expect(stepShape("cone", [0, 0, 0], [1, 1, 1]).up).toEqual({ axis: 1, sign: 1 });
    // options only where the kind takes them, and no zeros
    // a limb keeps its radii and a corner other than 0; other kinds drop them
    expect(stepShape("limb", [0, 0, 0], [2, 4, 1], { radius: 0.5, tip: 0, corner: 0 })).toEqual({ kind: "limb", min: [0, 0, 0], max: [2, 4, 1], radius: 0.5, tip: 0 });
    expect(stepShape("limb", [0, 0, 0], [2, 4, 1], { corner: 5 }).corner).toBe(5);
    expect(stepShape("box", [0, 0, 0], [2, 4, 1], { radius: 0.5, corner: 5 })).toEqual({ kind: "prism", min: [0, 0, 0], max: [2, 4, 1], up: { axis: 1, sign: 1 }, sides: 4 });
    // Explicit radii remain independent of round, even when their values match.
    const box = { kind: "prism", min: [0, 0, 0], max: [1, 1, 1], up: { axis: 1, sign: 1 }, sides: 4 };
    expect(stepShape("box", [0, 0, 0], [1, 1, 1], { round: 0.5, roundTop: 0, roundBottom: 0.5 })).toEqual({ ...box, round: 0.5, roundTop: 0, roundBottom: 0.5 });
    expect(stepShape("box", [0, 0, 0], [1, 1, 1], { roundTop: 0 })).toEqual({ ...box, roundTop: 0 });
    // an old cone's top is the share of the base it keeps: a taper of what it gives up
    expect(stepShape("cone", [0, 0, 0], [1, 1, 1], { top: 0.25 } as object)).toMatchObject({ kind: "prism", taper: 0.75 });
    expect(stepShape("sphere", [0, 0, 0], [1, 1, 1], { roundTop: 1, sides: 3, taper: 1 })).toEqual({ kind: "sphere", min: [0, 0, 0], max: [1, 1, 1], up: { axis: 1, sign: 1 } });
    // a forward across up is kept for any shape that points (a sweep starts there); a zero shell is dropped
    expect(stepShape("sphere", [0, 0, 0], [1, 1, 1], { round: 1, forward: { axis: 0, sign: 1 }, shell: 0, sweep: 360 })).toEqual({
      kind: "sphere",
      min: [0, 0, 0],
      max: [1, 1, 1],
      up: { axis: 1, sign: 1 },
      forward: { axis: 0, sign: 1 },
    });
    expect(stepShape("wedge", [0, 0, 0], [1, 1, 1]).forward).toEqual({ axis: 2, sign: 1 });
    // a forward along up can't be; it falls back to the default
    expect(stepShape("wedge", [0, 0, 0], [1, 1, 1], { up: { axis: 0, sign: 1 }, forward: { axis: 0, sign: 1 } }).forward).toEqual({ axis: 2, sign: 1 });
    const step = boxStep([0, 0, 0], [1, 1, 1], 1, "add", { kind: "torus" });
    const check = (shape: unknown) => () => checkSource({ steps: [{ ...step, shape }] }, 2);
    expect(check({ ...step.shape, up: { axis: 3, sign: 1 } })).toThrow("up is");
    expect(check({ ...step.shape, kind: "blob" })).toThrow("Unknown shape");
    expect(check({ ...step.shape, shell: 0.1 })).toThrow("shell");
    expect(check({ ...step.shape, kind: "cone", top: 1 })).toThrow("top");
    expect(check({ kind: "wedge", min: [0, 0, 0], max: [1, 1, 1], up: { axis: 1, sign: 1 }, forward: { axis: 1, sign: -1 } })).toThrow("across");
    expect(checkSource({ steps: [{ ...step, shape: { ...step.shape, up: undefined } }] }, 2).steps[0].shape.up).toEqual({ axis: 1, sign: 1 });
  });
});

describe("fills", () => {
  const grid = { size: [8, 1, 1] as Vec3, resolution: 1 };
  const row = (step: Step) => [...evaluateSource({ steps: [step] }, grid)];
  const box = (fill: Step["fill"], material = 2) => ({ ...boxStep([0, 0, 0], [8, 1, 1], material), ...(fill ? { fill } : {}) });

  test("a gradient walks the palette across the box, either way", () => {
    expect(row(box(stepFill("gradient", 5, { axis: 0 })))).toEqual([2, 2, 3, 3, 4, 4, 5, 5]);
    expect(row(box(stepFill("gradient", 1, { axis: 0 }), 4))).toEqual([4, 4, 3, 3, 2, 2, 1, 1]);
    // across an axis one cell thick, every cell is the same slot
    expect(new Set(row(box(stepFill("gradient", 5, { axis: 1 })))).size).toBe(1);
  });

  test("checker and stripes alternate from the box's corner, so they move with it", () => {
    expect(row(box(stepFill("checker", 6, { size: 2 })))).toEqual([2, 2, 6, 6, 2, 2, 6, 6]);
    expect(row(box(stepFill("stripes", 6, { axis: 0, size: 1 })))).toEqual([2, 6, 2, 6, 2, 6, 2, 6]);
    const moved = { ...boxStep([1, 0, 0], [8, 1, 1], 2), fill: stepFill("stripes", 6, { axis: 0, size: 1 }) };
    expect(row(moved)).toEqual([0, 2, 6, 2, 6, 2, 6, 2]);
  });

  test("paint and intersect use the fill; fills are checked and remapped with the palette", () => {
    const base = boxStep([0, 0, 0], [8, 1, 1], 1);
    const paint = { ...boxStep([2, 0, 0], [6, 1, 1], 2, "paint"), fill: stepFill("stripes", 3, { axis: 0 }) };
    expect([...evaluateSource({ steps: [base, paint] }, grid)]).toEqual([1, 1, 2, 3, 2, 3, 1, 1]);
    expect(() => checkSource({ steps: [{ ...paint, fill: { kind: "gradient", to: 9 } }] }, 4)).toThrow("palette");
    expect(() => checkSource({ steps: [{ ...paint, fill: { kind: "plaid", to: 1 } }] }, 4)).toThrow("Unknown fill");
    expect(checkSource({ steps: [{ ...paint, fill: { kind: "checker", to: 3, axis: 2 } }] }, 4).steps[0].fill).toEqual({ kind: "checker", to: 3, size: 1 });

    const e = editor([8, 1, 1]);
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [8, 1, 1] }, 2)!;
    const step = e.shapeStack(id)![0].id;
    expect(e.setStepFill(id, step, stepFill("gradient", e.palette.length - 1, { axis: 0 }))).toBe(true);
    expect(e.history.undoLabel).toBe("Change fill");
    // a ramp longer than the box has cells skips slots: each slot covers an equal share of the box
    const ramp = [...e.composite];
    expect(ramp.every((v, i) => i === 0 || v > ramp[i - 1])).toBe(true);
    expect(ramp[0]).toBeGreaterThanOrEqual(2);
    expect(ramp[7]).toBeLessThanOrEqual(e.palette.length - 1);
    // the palette shrinking takes the fill's color along
    e.loadPalette([0xff0000, 0x00ff00, 0x0000ff]);
    expect(e.shapeStack(id)![0].fill!.to).toBeLessThan(4);
    e.undo();
    e.setStepFill(id, step, null);
    expect(e.shapeStack(id)![0].fill).toBeUndefined();
    expect(new Set(e.composite).size).toBe(1);
  });
});

describe("evaluation cache", () => {
  test("dragging any step gives what a fresh evaluation does", () => {
    const grid = { size: [12, 12, 12] as Vec3, resolution: 2 };
    const kinds = ["box", "sphere", "cone", "wedge", "torus"] as const;
    const modes = ["add", "cut", "paint", "intersect", "add"] as const;
    const committed: ShapeSource = {
      steps: kinds.map((kind, i) => boxStep([i * 0.5, 0, 0], [3 + i * 0.5, 4, 4], i + 1, i ? modes[i] : "add", { kind })),
    };
    const cache = new SourceCache();
    let source = committed;
    // drag each step in turn, the committed source evaluated between frames as the editor does
    for (let i = 0; i < committed.steps.length; i++) {
      for (let frame = 0; frame < 4; frame++) {
        const steps = [...source.steps];
        const s = steps[i];
        steps[i] = { ...s, shape: { ...s.shape, max: [s.shape.max[0] + 0.5, s.shape.max[1], s.shape.max[2]] } };
        const draft = { steps };
        expect(cache.get(draft, grid, "layer")).toEqual(evaluateSource(draft, grid));
        expect(cache.get(source, grid, "layer")).toEqual(evaluateSource(source, grid));
        if (frame === 3) source = draft;
      }
    }
    // a different grid isn't mistaken for the same one
    const coarse = { size: [6, 6, 6] as Vec3, resolution: 1 };
    expect(cache.get(source, coarse, "layer")).toEqual(evaluateSource(source, coarse));
  });
});

describe("composition", () => {
  const grid = { size: [1, 1, 1] as Vec3, resolution: 1 };
  /** One cell: -1 unset, 0 covered empty, else covered (or solid) value. */
  const raster = (state: number, override: boolean): SourceLayer =>
    override
      ? { data: Uint8Array.of(Math.max(0, state)), coverage: Uint8Array.of(state >= 0 ? 1 : 0) }
      : { data: Uint8Array.of(Math.max(0, state)) };
  const shape = (solid: boolean): SourceLayer => ({
    data: new Uint8Array(0),
    shape: { steps: [solid ? boxStep([0, 0, 0], [1, 1, 1], 7) : boxStep([5, 5, 5], [6, 6, 6], 7)] },
  });

  test("every pair of unset, empty and solid contributions", () => {
    const lower = [shape(false), shape(true)]; // unset, solid 7
    const upper: [SourceLayer, number | "keep"][] = [
      [raster(-1, true), "keep"],
      [raster(0, true), 0],
      [raster(3, true), 3],
      [raster(0, false), "keep"], // a legacy 0 is unset
      [raster(3, false), 3],
    ];
    for (const below of lower) {
      const base = composeLayers([below], grid)[0];
      for (const [above, expected] of upper) {
        expect(composeLayers([below, above], grid)[0]).toBe(expected === "keep" ? base : expected);
      }
    }
  });

  test("a higher solid fills a hole a lower empty override cut; hidden layers contribute nothing", () => {
    const layers = [shape(true), raster(0, true), raster(4, true)];
    expect(composeLayers(layers, grid)[0]).toBe(4);
    expect(composeLayers([layers[0], layers[1], { ...layers[2], visible: false }], grid)[0]).toBe(0);
    expect(composeLayers([layers[0], { ...layers[1], visible: false }], grid)[0]).toBe(7);
  });

  test("evaluation leaves its inputs alone", () => {
    const layers = [shape(true), raster(0, true)];
    const copies = layers.map((l) => ({ data: l.data.slice(), coverage: l.coverage?.slice(), shape: l.shape }));
    evaluateDocument({ size: [1, 1, 1], layers });
    layers.forEach((l, i) => {
      expect(l.data).toEqual(copies[i].data);
      expect(l.coverage).toEqual(copies[i].coverage);
      expect(l.shape).toBe(copies[i].shape);
    });
  });
});

describe("resampling", () => {
  test("refining is exact and coarsening keeps the most common state", () => {
    const size: Vec3 = [2, 2, 2];
    const data = Uint8Array.from([0, 3, 0, 3, 0, 3, 0, 3]);
    const coverage = Uint8Array.from([0, 1, 1, 1, 0, 1, 1, 1]);
    const fine = resampleRaster(data, coverage, size, 2);
    expect(fine.data.length).toBe(64);
    expect(fine.lossy).toBe(false);
    const back = resampleRaster(fine.data, fine.coverage, [4, 4, 4], 0.5);
    expect(back.data).toEqual(data);
    expect(back.coverage).toEqual(coverage);
  });

  test("ties go to covered over unset, solid over empty, then the lowest color", () => {
    const tie = (a: [number, number], b: [number, number]) => {
      // [value, covered] for each half of a 2×2×2 block
      const data = new Uint8Array(8);
      const coverage = new Uint8Array(8);
      for (let i = 0; i < 8; i++) [data[i], coverage[i]] = i < 4 ? a : b;
      const out = resampleRaster(data, coverage, [2, 2, 2], 0.5);
      expect(out.lossy).toBe(true);
      return [out.data[0], out.coverage![0]];
    };
    expect(tie([0, 0], [0, 1])).toEqual([0, 1]);
    expect(tie([0, 1], [5, 1])).toEqual([5, 1]);
    expect(tie([5, 1], [2, 1])).toEqual([2, 1]);
    // a legacy layer's zero is unset
    const legacy = resampleRaster(Uint8Array.from([0, 0, 0, 0, 4, 4, 4, 4]), undefined, [2, 2, 2], 0.5);
    expect([...legacy.data]).toEqual([4]);
  });

  test("selections repeat when refined and keep any selected cell when coarsened", () => {
    const mask = new Uint8Array(8);
    mask[7] = 1;
    expect(filled(resampleMask(mask, [2, 2, 2], 2))).toBe(8);
    expect([...resampleMask(mask, [2, 2, 2], 0.5)]).toEqual([1]);
  });
});

describe("shape layers", () => {
  test("a box layer regenerates its voxels when changed, one undo step each", () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [2, 2, 2] }, 3)!;
    expect(e.isFlat).toBe(false);
    expect(e.activeLayerKind).toBe("shape");
    expect(filled(e.composite)).toBe(8);
    const box = e.shapeStack(id)![0];
    e.setStepBox(id, box.id, { min: [0, 0, 0], max: [4, 2, 2] });
    expect(filled(e.composite)).toBe(16);
    expect(at(e, [3, 1, 1])).toBe(3);
    e.undo();
    expect(filled(e.composite)).toBe(8);
    e.undo();
    expect(e.layers.length).toBe(1);
    expect(filled(e.composite)).toBe(0);
    e.redo();
    e.redo();
    expect(filled(e.composite)).toBe(16);
  });

  test("a cut only affects its own layer, and removing it puts the box back", () => {
    const e = editor();
    e.setCells([[1, 1, 1]], 5); // a raster voxel below, inside where the cut goes
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [4, 4, 4] }, 3)!;
    const box = e.shapeStack(id)![0];
    const cut = e.addStep(id, "cut", { min: [1, 1, 1], max: [3, 3, 3] })!;
    expect(e.shapeStack(id)!.map((o) => o.mode)).toEqual(["add", "cut"]);
    // the cut reveals the raster layer below rather than carving it
    expect(at(e, [1, 1, 1])).toBe(5);
    expect(at(e, [2, 2, 2])).toBe(0);
    expect(at(e, [0, 0, 0])).toBe(3);
    expect(e.removeStep(id, cut)).toBe(true);
    expect(at(e, [2, 2, 2])).toBe(3);
    // the last shape can go too, leaving an empty layer that shows nothing
    expect(e.removeStep(id, box.id)).toBe(true);
    expect(e.shapeStack(id)).toEqual([]);
    expect(at(e, [0, 0, 0])).toBe(0);
    expect(at(e, [1, 1, 1])).toBe(5);
    e.undo();
    e.undo();
    expect(at(e, [2, 2, 2])).toBe(0);
  });

  test("hidden shape layers contribute nothing and locked ones don't change", () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [2, 2, 2] })!;
    e.setLayerVisible(id, false);
    expect(filled(e.composite)).toBe(0);
    e.setLayerVisible(id, true);
    e.setLayerLocked(id, true);
    const box = e.shapeStack(id)![0];
    expect(e.setStepBox(id, box.id, { min: [0, 0, 0], max: [3, 3, 3] })).toBe(false);
    expect(filled(e.composite)).toBe(8);
  });

  test("invalid changes leave the document and history as they were", () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [2, 2, 2] })!;
    const box = e.shapeStack(id)![0];
    const label = e.history.undoLabel;
    const version = e.documentVersion;
    expect(e.setStepBox(id, box.id, { min: [2, 0, 0], max: [1, 2, 2] })).toBe(false);
    expect(e.history.undoLabel).toBe(label);
    expect(e.documentVersion).toBe(version);
    // an op that doesn't fit rolls back everything before it
    const shape = e.layers.find((l) => l.id === id)!.shape!;
    const bad: ShapeSource = { steps: [{ ...shape.steps[0], shape: { kind: "box", min: [0, 0, 0], max: [0.3, 1, 1] } }] };
    const ops: DocOp[] = [
      { t: "name", before: "", after: "Changed" },
      { t: "layer.shape", id, after: bad },
    ];
    expect(() => applyOps(e.doc.target, ops)).toThrow(OpError);
    expect(e.name).toBe("Untitled");
  });

  test("shared ops can't carry shapes yet", () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [2, 2, 2] })!;
    const shape = e.layers.find((l) => l.id === id)!.shape!;
    expect(() => e.applyOps([{ t: "layer.shape", id, after: shape }])).toThrow("can't be shared");
  });

  test("raster tools are turned away from shape layers with a reason", () => {
    const e = editor();
    e.addBoxLayer({ min: [0, 0, 0], max: [2, 2, 2] });
    expect(e.editBlocker()).toContain("vector layer");
    expect(e.setCells([[5, 0, 5]], 1)).toBe(0);
  });

  test("palette replacement remaps shape colors in the same step", () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [1, 1, 1] }, e.palette.length - 1)!;
    e.loadPalette([0xff0000, 0x00ff00]);
    const material = e.shapeStack(id)![0].material;
    expect(material).toBeLessThan(3);
    expect(at(e, [0, 0, 0])).toBe(material);
    e.undo();
    expect(e.shapeStack(id)![0].material).toBe(e.palette.length - 1);
  });

  test("resizing moves shapes with the voxels", () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [1, 1, 1] })!;
    e.resize([10, 8, 10]);
    expect(e.shapeStack(id)![0].shape.min).toEqual([1, 0, 1]);
    expect(at(e, [1, 0, 1])).not.toBe(0);
    e.undo();
    expect(e.shapeStack(id)![0].shape.min).toEqual([0, 0, 0]);
  });
});

describe("drawing shapes on a vector layer", () => {
  /** A mouse ray down onto a cell's column. */
  const mouse = (x: number, z: number) => ({ ray: down(x, z), hover: true });
  /** A mouse ray at 45° through the middle of the floor cell (x, 0, z). */
  const slant = (x: number, z: number) => ({ ray: { origin: [x + 0.5, 10.5, z + 10.5], dir: [0, -Math.SQRT1_2, -Math.SQRT1_2] } as Ray, hover: true });
  /** A level mouse ray along -z at height y, passing over the cell (x, ·, z). */
  const level = (x: number, y: number) => ({ ray: { origin: [x + 0.5, y + 0.5, 40], dir: [0, 0, -1] } as Ray, hover: true });

  test("a mouse draws in three clicks: origin, footprint, height; then Select holds the shape", () => {
    const e = editor([16, 16, 16]);
    const id = e.newShapeLayer()!;
    expect(e.tool).toBe("shape");
    // 1: the origin; the footprint then follows the pointer, a cell across to start with
    expect(e.pointerDown(mouse(2, 2))).toBe(true);
    e.pointerUp();
    expect(e.pendingShape?.drawing).toBe("footprint");
    expect(e.pendingShape?.box).toEqual({ min: [2, 0, 2], max: [2, 0, 2] });
    e.pointerHover(mouse(5, 4));
    expect(e.pendingShape?.box.min).toEqual([2, 0, 2]);
    expect([e.pendingShape!.box.max[0], e.pendingShape!.box.max[2]]).toEqual([5, 4]);
    // no handles or gizmo while drawing, and nothing in the document yet
    expect(e.transformBox).toBeNull();
    expect(e.shapeStack(id)).toEqual([]);
    // 2: the footprint is set; moving up raises the shape from its default height
    e.pointerDown(slant(5, 4));
    e.pointerUp();
    expect(e.pendingShape?.drawing).toBe("height");
    const start = e.pendingShape!.box.max[1];
    e.pointerHover(level(5, 3));
    expect(e.pendingShape!.box.max[1]).toBe(start + 3);
    expect([e.pendingShape!.box.max[0], e.pendingShape!.box.max[2]]).toEqual([5, 4]);
    // 3: made, as one undo step, and held with Select
    e.pointerDown(level(5, 3));
    e.pointerUp();
    expect(e.pendingShape?.drawing).toBeUndefined();
    expect(e.tool).toBe("select");
    expect(e.shapeStack(id)!.length).toBe(1);
    expect(e.selectedStep?.step.shape).toMatchObject({ kind: "prism", min: [2, 0, 2], max: [6, start + 4, 5] });
    expect(e.history.undoLabel).toBe("Add box");
    e.undo();
    expect(e.shapeStack(id)).toEqual([]);
    expect(e.history.undoLabel).toBe("New vector layer");
  });

  test("a mouse drag sets the footprint in one go, and the next click makes the shape", () => {
    const e = editor([16, 16, 16]);
    const id = e.newShapeLayer()!;
    e.setShapeTool("cylinder");
    e.pointerDown(mouse(1, 1));
    e.pointerMove(mouse(3, 4));
    e.pointerUp();
    expect(e.pendingShape?.drawing).toBe("height");
    // looking straight down the height can't be told; it stays the default
    e.pointerDown(mouse(9, 9));
    e.pointerUp();
    const step = e.shapeStack(id)![0];
    expect(step.shape).toMatchObject({ kind: "prism", min: [1, 0, 1], max: [4, 3, 5] });
    expect(e.tool).toBe("select");
    expect(e.history.undoLabel).toBe("Add cylinder");
  });

  test("a finger's tap drops a default-size shape, and a drag its footprint at the default height", () => {
    const e = editor([16, 16, 16]);
    const id = e.newShapeLayer()!;
    expect(e.pointerDown({ ray: down(8, 8) })).toBe(true);
    e.pointerUp();
    expect(e.shapeStack(id)![0].shape).toMatchObject({ min: [5, 0, 5], max: [12, 7, 12] });
    expect(e.tool).toBe("select");
    expect(e.selectedStep?.index).toBe(0);
    e.setShapeTool("box");
    e.pointerDown({ ray: down(0, 0) });
    e.pointerMove({ ray: down(2, 1) });
    expect(e.pendingShape?.drawing).toBe("footprint");
    e.pointerUp();
    expect(e.shapeStack(id)![1].shape).toMatchObject({ min: [0, 0, 0], max: [3, 2, 2] });
    expect(e.selectedStep?.index).toBe(1);
  });

  test("Esc or a second finger cancels a shape being drawn, at any step", () => {
    const e = editor([16, 16, 16]);
    const id = e.newShapeLayer()!;
    e.pointerDown(mouse(2, 2));
    e.pointerUp();
    e.pointerHover(mouse(5, 5));
    e.cancelPointer();
    expect(e.pendingShape).toBeNull();
    expect(e.operandEdit).toBeNull();
    expect(e.tool).toBe("shape");
    // the next click starts over
    e.pointerDown(mouse(1, 1));
    e.pointerUp();
    expect(e.pendingShape?.box.min).toEqual([1, 0, 1]);
    e.cancelPointer();
    // a finger's drag, then a second finger
    e.pointerDown({ ray: down(0, 0) });
    e.pointerMove({ ray: down(3, 3) });
    e.cancelPointer();
    expect(e.pendingShape).toBeNull();
    expect(e.shapeStack(id)).toEqual([]);
    expect(e.canUndo).toBe(true);
    expect(e.history.undoLabel).toBe("New vector layer");
  });

  test("shapes are drawn in the options bar's mode, and cuts go into the model", () => {
    const e = editor([16, 16, 16]);
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [8, 4, 8] })!;
    e.setShapeTool("sphere");
    e.setShapeMode("cut");
    e.pointerDown({ ray: down(2, 2) });
    e.pointerMove({ ray: down(5, 5) });
    e.pointerUp();
    const cut = e.shapeStack(id)![1];
    expect(cut.mode).toBe("cut");
    expect(cut.shape.kind).toBe("sphere");
    // into the box's top, not above it
    expect(cut.shape.max[1]).toBe(4);
    expect(e.history.undoLabel).toBe("Cut sphere");
  });
});

describe("editing a shape in place", () => {
  const pt = (x: number, y: number, z: number) => ({ at: [x + 0.5, y + 0.5, z + 0.5] as Vec3 });

  test("entering shows the shape's own handles instead of its box's, and leaving makes no undo step", () => {
    const e = editor([16, 16, 16]);
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [8, 4, 8] })!;
    const tube = e.addStep(id, "add", { min: [0, 0, 0], max: [0, 0, 0] }, 1, { kind: "tube", points: [pt(2, 6, 2), pt(8, 6, 2)] })!;
    const box = e.shapeStack(id)![0].id;
    e.selectStep(box);
    // selected: the box's handles and gizmo, not the setting handles
    expect(e.shapeParamHandles).toEqual([]);
    expect(e.transformBox).not.toBeNull();
    expect(e.editShape()).toBe(true);
    expect(e.editingShape).toEqual({ layerId: id, stepId: box });
    expect(e.pendingShape?.editing).toBe(true);
    expect(e.transformBox).toBeNull();
    expect(e.shapeParamHandles.map((h) => h.id)).toContain("param-round");
    // what stays bright: the box's own voxels, not the tube's
    const focus = e.editingVolume()!;
    expect(focus[e.index(1, 1, 1)]).toBe(1);
    expect(focus[e.index(2, 6, 2)]).toBe(0);
    const before = e.history.undoLabel;
    e.stopEditingShape();
    expect(e.editingShape).toBeNull();
    expect(e.selectedStep?.step.id).toBe(box);
    expect(e.history.undoLabel).toBe(before);
    // a path's points and the + between them
    expect(e.editShape(tube)).toBe(true);
    expect(e.shapeParamHandles.map((h) => h.id)).toEqual(["point-0", "point-1", "insert-1"]);
    // selecting another shape leaves editing
    e.selectStep(box);
    expect(e.editingShape).toBeNull();
  });

  test("a tap off the shape lets go of the picked point, then leaves; undo works inside", () => {
    const e = editor([16, 16, 16]);
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [8, 1, 8] })!;
    const tube = e.addStep(id, "add", { min: [0, 0, 0], max: [0, 0, 0] }, 1, { kind: "tube", points: [pt(2, 6, 2), pt(8, 6, 2)] })!;
    e.editShape(tube);
    e.selectPathPoint(1);
    e.movePathPoint(id, tube, 1, [10.5, 6.5, 2.5]);
    expect(e.history.undoLabel).toBe("Move point");
    e.undo();
    expect(e.editingShape?.stepId).toBe(tube);
    expect(e.shapeStack(id)![1].shape.points![1].at).toEqual([8.5, 6.5, 2.5]);
    e.pointerTap();
    expect(e.selectedPathPoint).toBeNull();
    expect(e.editingShape).not.toBeNull();
    e.pointerTap();
    expect(e.editingShape).toBeNull();
    expect(e.selectedStep?.step.id).toBe(tube);
    // a tap off a shape that is only selected deselects it
    e.pointerTap();
    expect(e.selectedStep).toBeNull();
  });

  test("a double tap on the selected shape edits it in place; its box doesn't move while editing", () => {
    const e = editor([16, 16, 16]);
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [8, 4, 8] })!;
    e.setTool("select");
    e.pointerDown({ ray: down(2, 2) });
    e.pointerUp();
    expect(e.selectedStep?.index).toBe(0);
    expect(e.editingShape).toBeNull();
    // the first tap on the selected shape's body is a tap; the second, soon after, edits it
    e.pointerDown({ ray: down(2, 2) });
    e.pointerUp();
    expect(e.editingShape).toBeNull();
    e.pointerDown({ ray: down(2, 2) });
    e.pointerUp();
    expect(e.editingShape?.layerId).toBe(id);
    // a drag on the body doesn't slide it while editing in place
    const box = e.shapeStack(id)![0].shape;
    expect(e.pointerDown({ ray: down(3, 3) })).toBe(false);
    expect(e.shapeStack(id)![0].shape).toEqual(box);
  });
});

describe("box drafts", () => {
  test("a dragged box previews without history, and commits as one step", async () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [2, 2, 2] })!;
    const box = e.shapeStack(id)![0];
    e.selectStep(box.id, id);
    expect(e.pendingShape?.operand).toBe("edit");
    const steps = e.history.undoLabel;
    const version = e.documentVersion;
    e.setPendingShape({ ...e.pendingShape!, box: { min: [0, 0, 0], max: [3, 1, 1] } });
    await tick();
    expect(filled(e.composite)).toBe(16);
    expect(e.documentVersion).toBe(version);
    expect(e.history.undoLabel).toBe(steps);
    expect(e.commitShape()).toBe(true);
    expect(e.history.undoLabel).toBe("Change box");
    expect(e.shapeStack(id)![0].shape.max).toEqual([4, 2, 2]);
    // still selected; undo takes the change back and the handles follow
    expect(e.undo()).toBe(true);
    expect(e.selectedStep?.step.shape.max).toEqual([2, 2, 2]);
    expect(e.pendingShape?.box.max).toEqual([1, 1, 1]);
  });

  test("cancelling a draft restores the committed box", async () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [2, 2, 2] })!;
    e.selectStep(e.shapeStack(id)![0].id, id);
    e.setPendingShape({ ...e.pendingShape!, box: { min: [0, 0, 0], max: [5, 5, 5] } });
    await tick();
    expect(filled(e.composite)).toBe(216);
    e.cancelShape();
    await tick();
    expect(filled(e.composite)).toBe(8);
    expect(e.operandEdit).toBeNull();
  });

  test("a new vector layer is empty, active and ready to draw; drawn steps preview live and apply as one step", async () => {
    const e = editor();
    e.setTool("erase");
    const id = e.newShapeLayer()!;
    expect(e.activeLayerKind).toBe("shape");
    expect(e.shapeStack(id)).toEqual([]);
    expect(e.layer(id)!.name).toBe("Vector 1");
    expect(e.tool).toBe("shape");
    expect(e.shapePreset).toBe("box");
    expect(e.selectedStep).toBeNull();
    expect(filled(e.composite)).toBe(0);
    expect(e.history.undoLabel).toBe("New vector layer");
    const big = { box: { min: [2, 0, 2] as Vec3, max: [5, 3, 5] as Vec3 }, up: { axis: 1, sign: 1 } as const, grow: { axis: 1, sign: 1 } as const };
    e.startStep("add", big);
    e.commitShape();
    const before = filled(e.composite);
    const draft = { box: { min: [3, 2, 3] as Vec3, max: [4, 3, 4] as Vec3 }, up: { axis: 1, sign: 1 } as const, grow: { axis: 1, sign: -1 } as const };
    expect(e.startStep("cut", draft)).toBe(true);
    await tick();
    expect(filled(e.composite)).toBe(before - 8);
    e.commitShape();
    expect(e.history.undoLabel).toBe("Cut box");
    expect(e.shapeStack(id)!.map((s) => s.mode)).toEqual(["add", "cut"]);
    expect(e.selectedStep?.step.mode).toBe("cut");
    // undo while placing takes the placement back first
    e.startStep("add", draft);
    e.undo();
    expect(e.operandEdit).toBeNull();
    expect(e.shapeStack(id)!.length).toBe(2);
  });

  test("steps apply to everything below them, in order", () => {
    const e = editor([4, 1, 1]);
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [2, 1, 1] }, 1)!;
    const added = e.addStep(id, "add", { min: [2, 0, 0], max: [4, 1, 1] }, 2)!;
    const cut = e.addStep(id, "cut", { min: [1, 0, 0], max: [3, 1, 1] })!;
    expect([...e.composite]).toEqual([1, 0, 0, 2]);
    // moving the cut below the added box lets the box fill part of it again
    e.moveStep(id, cut, 1);
    expect([...e.composite]).toEqual([1, 0, 2, 2]);
    e.setStepMode(id, added, "intersect");
    expect([...e.composite]).toEqual([0, 0, 0, 0]);
    e.undo();
    e.undo();
    expect([...e.composite]).toEqual([1, 0, 0, 2]);
    // any step can go, the bottom one too
    e.removeStep(id, e.shapeStack(id)![0].id);
    expect([...e.composite]).toEqual([0, 0, 0, 2]);
  });

  test("a step's color is separate from what it does to the volume", () => {
    const e = editor([4, 1, 1]);
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [3, 1, 1] }, 1)!;
    const paint = e.addStep(id, "paint", { min: [2, 0, 0], max: [4, 1, 1] }, 2)!;
    expect(e.history.undoLabel).toBe("Paint box");
    expect([...e.composite]).toEqual([1, 1, 2, 0]);
    e.setStepMode(id, paint, "add");
    expect([...e.composite]).toEqual([1, 1, 2, 2]);
    expect(e.setStepKeep(id, paint, true)).toBe(true);
    expect(e.history.undoLabel).toBe("Keep colors");
    expect([...e.composite]).toEqual([1, 1, 1, 2]);
    expect(e.shapeStack(id)![1].keep).toBe(true);
    e.setStepMaterial(id, paint, 3);
    expect([...e.composite]).toEqual([1, 1, 1, 3]);
    e.undo();
    e.undo();
    expect(e.shapeStack(id)![1].keep).toBeUndefined();
    expect([...e.composite]).toEqual([1, 1, 2, 2]);
    // intersect keeps the colors below unless told otherwise
    const trim = e.addStep(id, "intersect", { min: [1, 0, 0], max: [3, 1, 1] }, 4)!;
    expect([...e.composite]).toEqual([0, 1, 2, 0]);
    e.setStepKeep(id, trim, false);
    expect([...e.composite]).toEqual([0, 4, 4, 0]);
  });

  test("on a vector layer, Select picks shapes, the shape tool draws them in the options bar's mode, and Fill colors them", async () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [8, 4, 8] })!;
    e.setTool("select");
    expect(e.pointerDown({ ray: down(1, 1) })).toBe(true);
    e.pointerUp();
    expect(e.selectedStep?.index).toBe(0);
    e.setShapeTool("box");
    expect(e.tool).toBe("shape");
    e.setShapeMode("cut");
    // a tap makes the shape and goes back to Select
    e.pointerDown({ ray: down(1, 1) });
    e.pointerUp();
    expect(e.tool).toBe("select");
    expect(e.selectedStep?.step.mode).toBe("cut");
    await tick();
    expect(e.shapeStack(id)!.map((s) => s.mode)).toEqual(["add", "cut"]);
    expect(at(e, [1, 3, 1])).toBe(0);
    e.selectStep(null);
    e.setShapeTool("box");
    e.setShapeMode("paint");
    e.pointerDown({ ray: down(6, 6) });
    e.pointerUp();
    await tick();
    expect(e.shapeStack(id)!.map((s) => s.mode)).toEqual(["add", "cut", "paint"]);
    expect(e.history.undoLabel).toBe("Paint box");
    // a paint step is picked over the box it paints
    e.selectStep(null);
    e.setTool("select");
    e.pointerDown({ ray: down(6, 6) });
    e.pointerUp();
    expect(e.selectedStep?.step.mode).toBe("paint");
    // Fill gives the shape tapped the current color, as one undo step; a cut has none to give
    e.selectStep(null);
    e.setTool("fill");
    e.setColor(4);
    expect(e.pointerDown({ ray: down(1, 6) })).toBe(true);
    e.pointerUp();
    expect(e.shapeStack(id)![0].material).toBe(4);
    expect(e.history.undoLabel).toBe("Recolor step");
    expect(at(e, [1, 3, 6])).toBe(4);
    // voxel tools say why they don't apply
    e.setTool("brush");
    e.pointerDown({ ray: down(1, 6) });
    expect(e.toast?.message).toContain("vector layer");
    // and the vector tools leave a raster layer alone
    e.selectLayer(e.layers[0].id);
    e.setShapeTool("box");
    expect(e.pointerDown({ ray: down(1, 6) })).toBe(false);
  });

  test("steps take the chosen shape, turn, and are picked by their shape", async () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [8, 1, 8] })!;
    e.setShapeKind("cylinder");
    const draft = { box: { min: [0, 1, 0] as Vec3, max: [7, 2, 3] as Vec3 }, up: { axis: 1, sign: 1 } as const, grow: { axis: 1, sign: 1 } as const };
    e.startStep("add", draft);
    expect(e.pendingShape?.kind).toBe("prism");
    expect(e.pendingShape?.params).toEqual({});
    await tick();
    // the live preview is the cylinder, not its box
    expect(filled(e.composite)).toBeLessThan(64 + 8 * 2 * 4);
    e.rotatePendingShape();
    expect(e.pendingShape?.up.axis).toBe(0);
    e.commitShape();
    expect(e.history.undoLabel).toBe("Add cylinder");
    const step = e.shapeStack(id)![1];
    expect(step.shape).toMatchObject({ kind: "prism", up: { axis: 0, sign: 1 } });
    expect(step.shape.sides).toBeUndefined();
    // rotating a step turns its box around its center
    const before = step.shape;
    expect(e.rotateStep(id, step.id)).toBe(true);
    const after = e.shapeStack(id)![1].shape;
    expect(after.up).toEqual({ axis: 2, sign: 1 });
    expect(after.max[2] - after.min[2]).toBe(before.max[0] - before.min[0]);
    expect(after.max[0] - after.min[0]).toBe(before.max[2] - before.min[2]);
    e.undo();
    expect(e.shapeStack(id)![1].shape).toEqual(before);
    // options pass through, and are checked like any change
    const frustum = e.addStep(id, "add", { min: [0, 1, 0], max: [4, 3, 4] }, 2, { kind: "cone", taper: 0.5, shell: 0.5 })!;
    expect(e.shapeStack(id)!.find((s) => s.id === frustum)!.shape).toMatchObject({ kind: "prism", taper: 0.5, shell: 0.5 });
    e.removeStep(id, frustum);
    expect(e.addStep(id, "add", { min: [0, 1, 0], max: [4, 3, 4] }, 2, { kind: "cone", taper: 2 })).toBeNull();
    // a limb's rotate steps the corner it grows from, keeping its box, through all eight and back
    const limb = e.addStep(id, "add", { min: [0, 1, 0], max: [4, 5, 2] }, 2, { kind: "limb", radius: 0.5 })!;
    const corners: number[] = [];
    for (let k = 0; k < 8; k++) {
      e.rotateStep(id, limb);
      const shape = e.shapeStack(id)!.find((s) => s.id === limb)!.shape;
      expect(shape.min).toEqual([0, 1, 0]);
      corners.push(shape.corner ?? 0);
    }
    expect(new Set(corners).size).toBe(8);
    expect(corners[7]).toBe(0);
    e.removeStep(id, limb);
    // a wedge turns its slope around its up, a quarter at a time
    const wedge = e.addStep(id, "add", { min: [0, 1, 0], max: [4, 3, 4] }, 2, { kind: "wedge" })!;
    const faces = () => e.shapeStack(id)!.find((s) => s.id === wedge)!.shape.forward;
    const seen = [faces()];
    for (let i = 0; i < 4; i++) {
      e.turnStep(id, wedge);
      seen.push(faces());
    }
    expect(seen[4]).toEqual(seen[0]);
    expect(new Set(seen.slice(0, 4).map((d) => `${d!.axis}${d!.sign}`)).size).toBe(4);
    expect(seen.every((d) => d!.axis !== 1)).toBe(true);
    // a hollow wall, then solid again
    expect(e.setStepShape(id, wedge, { shell: 0.5 })).toBe(true);
    expect(e.shapeStack(id)!.find((s) => s.id === wedge)!.shape.shell).toBe(0.5);
    expect(e.setStepShape(id, wedge, { shell: 0.1 })).toBe(false);
    e.setStepShape(id, wedge, { shell: 0 });
    expect(e.shapeStack(id)!.find((s) => s.id === wedge)!.shape.shell).toBeUndefined();
    e.removeStep(id, wedge);
    // reshaping keeps the box
    e.setStepShape(id, step.id, { kind: "sphere" });
    expect(e.shapeStack(id)![1].shape).toMatchObject({ kind: "sphere", min: before.min, max: before.max });
    // a sphere keeps pointing where the shape did, so a sweep would start the same way
    expect(e.shapeStack(id)![1].shape.up).toEqual({ axis: 0, sign: 1 });
    // a sphere's box corner isn't the sphere: picking falls through to the base
    const sphere = e.addStep(id, "add", { min: [0, 1, 0], max: [8, 9, 8] }, 2, { kind: "sphere" })!;
    expect(e.pickStep(down(0, 0))?.id).toBe(e.shapeStack(id)![0].id);
    expect(e.pickStep(down(4, 4))?.id).toBe(sphere);
  });

  test("faces nobody dragged keep exact source coordinates after coarsening", () => {
    const e = editor([4, 4, 4]);
    e.setResolution(2);
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [1.5, 1, 1] })!;
    e.setResolution(1);
    const box = e.shapeStack(id)![0];
    expect(box.shape.max[0]).toBe(1.5);
    e.selectStep(box.id, id);
    const draft = e.pendingShape!;
    // drag only the height
    e.setPendingShape({ ...draft, box: { min: draft.box.min, max: [draft.box.max[0], 2, draft.box.max[2]] } });
    e.commitShape();
    expect(e.shapeStack(id)![0].shape.max).toEqual([1.5, 3, 1]);
  });
});

describe("baking", () => {
  test("a shape layer becomes an override layer of its voxels in one step, and undo brings the steps back", () => {
    const e = editor();
    const below = e.activeLayerId;
    e.setCells([[1, 1, 1]], 5);
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [4, 4, 4] }, 3)!;
    e.addStep(id, "cut", { min: [1, 1, 1], max: [3, 3, 3] }, 1, { kind: "sphere" });
    const before = e.evaluate();
    const values = e.layerValues(id).slice();
    expect(e.bakeShapeLayer(id)).toBe(true);
    expect(e.history.undoLabel).toBe("Bake to voxels");
    expect(e.activeLayerId).toBe(id);
    expect(e.activeLayerKind).toBe("override");
    const baked = e.layers.find((l) => l.id === id)!;
    expect(e.layers.indexOf(baked)).toBe(1);
    expect(baked.data).toEqual(values);
    expect(e.evaluate()).toEqual(before);
    // now it edits voxel by voxel, and its erase cuts what is below
    e.applyCells([[1, 1, 1]], "erase");
    expect(at(e, [1, 1, 1])).toBe(0);
    e.undo();
    e.undo();
    expect(e.activeLayerKind).toBe("shape");
    expect(e.shapeStack(id)!.length).toBe(2);
    expect(e.evaluate()).toEqual(before);
  });
});

describe("override layers", () => {
  /** A box layer under a fresh override layer. */
  function scene() {
    const e = editor();
    const shape = e.addBoxLayer({ min: [0, 0, 0], max: [4, 4, 4] }, 3)!;
    const layer = e.createLayer()!;
    return { e, shape, layer };
  }

  test("new layers in a model with shapes are override layers", () => {
    const { e } = scene();
    expect(e.activeLayerKind).toBe("override");
  });

  test("erase covers with empty, cutting the shape below; clear override reveals it again", () => {
    const { e } = scene();
    e.applyCells([[3, 3, 3]], "erase");
    expect(at(e, [3, 3, 3])).toBe(0);
    expect(e.getOverride([3, 3, 3])).toBe(0);
    // erasing empty space covers nothing
    e.applyCells([[6, 6, 6]], "erase");
    expect(e.getOverride([6, 6, 6])).toBe(-1);
    e.clearOverride();
    expect(at(e, [3, 3, 3])).toBe(3);
    expect(e.getOverride([3, 3, 3])).toBe(-1);
    e.undo();
    expect(e.getOverride([3, 3, 3])).toBe(0);
    e.undo();
    expect(e.getOverride([3, 3, 3])).toBe(-1);
    expect(at(e, [3, 3, 3])).toBe(3);
  });

  test("paint recolors visible voxels only, and stays put when the shape moves", () => {
    const { e, shape } = scene();
    e.applyCells([[0, 3, 0], [6, 0, 6]], "paint", 5);
    expect(at(e, [0, 3, 0])).toBe(5);
    expect(e.getOverride([6, 0, 6])).toBe(-1);
    const box = e.shapeStack(shape)![0];
    e.setStepBox(shape, box.id, { min: [4, 0, 4], max: [8, 4, 8] });
    // the painted voxel is a spatial edit: it stays where it was
    expect(at(e, [0, 3, 0])).toBe(5);
    expect(at(e, [1, 1, 1])).toBe(0);
  });

  test("tools find what is visible and write the active layer", () => {
    const { e } = scene();
    e.setTool("erase");
    expect(e.pointerDown({ ray: down(1, 1) })).toBe(true);
    e.pointerUp();
    expect(at(e, [1, 3, 1])).toBe(0);
    e.setTool("fill");
    e.pointerDown({ ray: down(2, 2) });
    e.pointerUp();
    expect(at(e, [2, 3, 2])).toBe(e.color);
    expect(e.getOverride([2, 3, 2])).toBe(e.color);
  });

  test("legacy erase over a shape says how to cut it", () => {
    const e = editor();
    const legacy = e.activeLayerId;
    e.addBoxLayer({ min: [0, 0, 0], max: [4, 4, 4] });
    e.selectLayer(legacy);
    e.setTool("erase");
    expect(e.pointerDown({ ray: down(1, 1) })).toBe(true);
    e.pointerUp();
    expect(e.toast?.message).toContain("override");
    expect(e.convertToOverride(legacy)).toBe(true);
    expect(e.activeLayerKind).toBe("override");
  });

  test("moving override content leaves unset cells behind and carries covered empties", () => {
    const { e } = scene();
    e.applyCells([[0, 3, 0]], "erase");
    e.applyCells([[1, 3, 0]], "paint", 5);
    e.selectBox({ min: [0, 3, 0], max: [1, 3, 0] });
    e.moveSelection([0, 0, 2]);
    e.applyTransform();
    expect(e.getOverride([0, 3, 0])).toBe(-1);
    expect(at(e, [0, 3, 0])).toBe(3);
    expect(e.getOverride([0, 3, 2])).toBe(0);
    expect(at(e, [0, 3, 2])).toBe(0);
    expect(at(e, [1, 3, 2])).toBe(5);
  });

  test("merging an override down keeps its cuts", () => {
    const e = editor();
    e.setCells([[0, 0, 0], [1, 0, 0]], 2);
    const upper = e.createLayer()!;
    e.convertToOverride(upper);
    e.setCells([[0, 0, 0]], 0);
    expect(at(e, [0, 0, 0])).toBe(0);
    e.mergeDown(upper);
    expect(e.layers.length).toBe(1);
    expect(e.activeLayerKind).toBe("override");
    expect(at(e, [0, 0, 0])).toBe(0);
    expect(at(e, [1, 0, 0])).toBe(2);
  });
});

describe("resolution", () => {
  test("refining keeps shapes in source space and rasters exactly; undo restores", () => {
    const e = editor([4, 4, 4]);
    e.setCells([[3, 0, 3]], 2);
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [1, 1, 1] })!;
    e.selectBox({ min: [3, 0, 3], max: [3, 0, 3] });
    expect(e.resolutionChoices).toEqual([1, 2, 4, 8]);
    expect(e.setResolution(2)).toBe(true);
    expect(e.size).toEqual([8, 8, 8]);
    expect(e.resolution).toBe(2);
    expect(e.shapeStack(id)![0].shape.max).toEqual([1, 1, 1]);
    expect(filled(e.layerValues(id))).toBe(8);
    expect(filled(e.layers[0].data)).toBe(8);
    expect(e.selectionCount).toBe(8);
    expect(e.resolutionLoses(1)).toBe(false);
    e.undo();
    expect(e.size).toEqual([4, 4, 4]);
    expect(e.selectionCount).toBe(1);
    expect(e.getVoxel([3, 0, 3], e.layers[0].id)).toBe(2);
    e.redo();
    expect(e.size).toEqual([8, 8, 8]);
    expect(e.selectionCount).toBe(8);
  });

  test("coarsening warns when lossy and undo brings the detail back", () => {
    const e = editor([4, 4, 4]);
    e.setResolution(2);
    const layer = e.layers[0].id;
    e.selectLayer(layer);
    e.setCells([[0, 0, 0]], 4);
    expect(e.resolutionLoses(1)).toBe(true);
    e.setResolution(1);
    expect(e.getVoxel([0, 0, 0], layer)).toBe(0);
    e.undo();
    expect(e.getVoxel([0, 0, 0], layer)).toBe(4);
    expect(e.getVoxel([1, 0, 0], layer)).toBe(0);
  });

  test("a grid past the size limit isn't offered", () => {
    const e = editor([100, 8, 8]);
    expect(e.resolutionChoices).toEqual([1, 2]);
    expect(e.setResolution(4)).toBe(false);
    expect(e.canUndo).toBe(false);
  });

  test("a locked resolution stays at 1×", () => {
    const locked = new Editor(undefined, { lockResolution: true });
    expect(locked.resolutionChoices).toEqual([1]);
    expect(locked.setResolution(2)).toBe(false);
  });

  test("any editor opens a model with shape layers", () => {
    const e = editor();
    e.addBoxLayer({ min: [0, 0, 0], max: [1, 1, 1] });
    const doc = e.getDocument();
    expect(isFlatDocument(doc)).toBe(false);
    expect(new Editor(doc).isFlat).toBe(false);
  });
});

describe("files and exports", () => {
  test("a model with shape layers round-trips through .moxel v2 and evaluates identically", () => {
    const e = editor([4, 4, 4]);
    e.setResolution(2);
    const shape = e.addBoxLayer({ min: [0, 0, 0], max: [2, 1.5, 2] }, 3)!;
    const box = e.shapeStack(shape)![0];
    e.addStep(shape, "cut", { min: [0.5, 0.5, 0.5], max: [1.5, 2, 1.5] });
    e.createLayer();
    e.applyCells([[0, 0, 0]], "erase");
    e.applyCells([[3, 0, 3]], "paint", 6);
    const text = serializeMoxel(e.getDocument());
    expect(JSON.parse(text).version).toBe(2);
    const doc = parseMoxel(text);
    const copy = new Editor(doc);
    expect(copy.resolution).toBe(2);
    expect(copy.layers.map((l) => l.id)).toEqual(e.layers.map((l) => l.id));
    expect(copy.evaluate()).toEqual(e.evaluate());
    expect(copy.shapeStack(shape)).toEqual(e.shapeStack(shape)!);
  });

  test("raster-only documents still save as v1", () => {
    const e = editor();
    e.setCells([[0, 0, 0]], 1);
    expect(JSON.parse(serializeMoxel(e.getDocument())).version).toBe(1);
  });

  test("damaged v2 files are turned down before anything is installed", () => {
    const e = editor([4, 4, 4]);
    e.addBoxLayer({ min: [0, 0, 0], max: [1, 1, 1] });
    const file = JSON.parse(serializeMoxel(e.getDocument()));
    const bad = (patch: (f: typeof file) => void) => {
      const f = structuredClone(file);
      patch(f);
      return () => parseMoxel(JSON.stringify(f));
    };
    expect(bad((f) => (f.resolution = 3))).toThrow("resolution");
    expect(bad((f) => (f.size = [300, 4, 4]))).toThrow("size");
    expect(bad((f) => (f.layers[1].shape.steps[0].shape.max = [0, 1, 1]))).toThrow("some size");
    expect(bad((f) => (f.layers[1].shape = { id: "a", kind: "box", min: [0, 0, 0], max: [1, 1, 1], material: 1 }))).toThrow("list of steps");
    expect(bad((f) => (f.version = 99))).toThrow("Unsupported");
  });

  test("the flat document is the committed evaluation, without the slice or a draft", () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [4, 4, 4] })!;
    e.setSlice({ axis: 1, level: 0, mode: "-" });
    e.selectStep(e.shapeStack(id)![0].id, id);
    e.setPendingShape({ ...e.pendingShape!, box: { min: [0, 0, 0], max: [7, 7, 7] } });
    const flat = e.flatDocument();
    expect(flat.layers.length).toBe(1);
    expect(filled(flat.layers[0].data)).toBe(64);
    expect(isFlatDocument(flat)).toBe(true);
  });
});

describe("agent tools", () => {
  test("edit_shapes builds and lists a stack, one undo step each", () => {
    const e = editor();
    const tools = createAgentTools(e);
    const run = (name: string, input: Record<string, unknown>) => JSON.parse(tools.find((t) => t.name === name)!.execute(input));
    const added = run("edit_shapes", { action: "new_layer", min: [0, 0, 0], max: [3, 3, 3] });
    const layer = added.layers.find((l: { kind: string }) => l.kind === "shape");
    expect(layer.voxels).toBe(64);
    const cut = run("edit_shapes", { action: "add_step", mode: "cut", layer: added.layer, min: [1, 1, 1], max: [2, 2, 2] });
    expect(cut.undo).toBe("Cut box");
    const shape = cut.layers.find((l: { id: string }) => l.id === added.layer);
    expect(shape.voxels).toBe(56);
    expect(shape.steps.map((s: { mode: string }) => s.mode)).toEqual(["add", "cut"]);
    expect(run("get_voxels", {}).total).toBe(56);
    // without a box, an empty vector layer
    const empty = run("edit_shapes", { action: "new_layer" });
    expect(empty.layers.find((l: { id: string }) => l.id === empty.layer)).toMatchObject({ kind: "shape", voxels: 0, steps: [] });
    e.undo();
    expect(e.layer(empty.layer)).toBeUndefined();
    expect(() => run("edit_shapes", { action: "set_box", step: "nope", min: [0, 0, 0], max: [1, 1, 1] })).toThrow("No step");
    const painted = run("edit_shapes", { action: "add_step", mode: "paint", layer: added.layer, min: [0, 0, 0], max: [3, 0, 3], color: 2 });
    expect(painted.step).toBeString();
    const kept = run("edit_shapes", { action: "set_keep", layer: added.layer, step: painted.step, keep: true });
    expect(kept.undo).toBe("Keep colors");
    expect(kept.layers.find((l: { id: string }) => l.id === added.layer).steps[2]).toMatchObject({ mode: "paint", keep: true, color: 2 });
    const reshaped = run("edit_shapes", { action: "set_shape", layer: added.layer, step: painted.step, shape: "cone", up: "-x" });
    expect(reshaped.undo).toBe("Change shape");
    expect(reshaped.layers.find((l: { id: string }) => l.id === added.layer).steps[2]).toMatchObject({ shape: "cone", up: "-x" });
    const sphere = run("edit_shapes", { action: "add_step", layer: added.layer, shape: "sphere", min: [0, 0, 0], max: [3, 3, 3] });
    expect(sphere.undo).toBe("Add sphere");
    const hollow = run("edit_shapes", { action: "set_shape", layer: added.layer, step: sphere.step, shell: 0.5 });
    expect(hollow.layers.find((l: { id: string }) => l.id === added.layer).steps[3]).toMatchObject({ shape: "sphere", shell: 0.5 });
    expect(() => run("edit_shapes", { action: "set_shape", layer: added.layer, step: sphere.step, shell: 0.3 })).toThrow("1/8");
    const ramp = run("edit_shapes", { action: "set_fill", layer: added.layer, step: sphere.step, fill: "gradient", color: 2, color2: 5, axis: "y" });
    expect(ramp.undo).toBe("Change fill");
    expect(ramp.layers.find((l: { id: string }) => l.id === added.layer).steps[3]).toMatchObject({ color: 2, fill: { kind: "gradient", to: 5, axis: "y" } });
    const baked = run("edit_shapes", { action: "bake", layer: added.layer });
    expect(baked.undo).toBe("Bake to voxels");
    expect(baked.layers.find((l: { id: string }) => l.id === added.layer).kind).toBe("override");
  });
});

describe("baking keeps what the layer carries", () => {
  test("host data and unknown fields survive a bake", () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [2, 2, 2] }, 3)!;
    e.setLayerHostData(id, { game: { solid: true } });
    expect(e.bakeShapeLayer(id)).toBe(true);
    expect(e.layers.find((l) => l.id === id)!.hostData).toEqual({ game: { solid: true } });
  });
});

describe("naming, copying and pointing steps", () => {
  test("a step's name is one undo step, saved with the model, and cleared by an empty name", () => {
    const e = editor([4, 4, 4]);
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [2, 2, 2] })!;
    const step = e.shapeStack(id)![0];
    expect(e.setStepName(id, step.id, "  Hull  ")).toBe(true);
    expect(e.shapeStack(id)![0].name).toBe("Hull");
    expect(e.history.undoLabel).toBe("Rename step");
    const copy = new Editor(parseMoxel(serializeMoxel(e.getDocument())));
    expect(copy.shapeStack(copy.layers.find((l) => l.shape)!.id)![0].name).toBe("Hull");
    expect(e.setStepName(id, step.id, "x".repeat(65))).toBe(false);
    expect(e.setStepName(id, step.id, "")).toBe(true);
    expect(e.shapeStack(id)![0].name).toBeUndefined();
    e.undo();
    expect(e.shapeStack(id)![0].name).toBe("Hull");
  });

  test("duplicating a step puts the copy just above it and selects it", () => {
    const e = editor([4, 4, 4]);
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [2, 2, 2] })!;
    const box = e.shapeStack(id)![0];
    e.addStep(id, "cut", { min: [0, 0, 0], max: [1, 1, 1] });
    const copy = e.duplicateStep(id, box.id)!;
    const steps = e.shapeStack(id)!;
    expect(steps.map((s) => s.id)).toEqual([box.id, copy, steps[2].id]);
    expect(steps[1].shape).toEqual(box.shape);
    expect(e.selectedStep?.step.id).toBe(copy);
    expect(e.history.undoLabel).toBe("Duplicate step");
  });

  test("pointing a step turns its box with it, and turns down ways it can't point", () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [2, 4, 2] })!;
    const step = e.shapeStack(id)![0];
    e.setStepShape(id, step.id, { kind: "cone" });
    expect(e.pointStep(id, step.id, { axis: 0, sign: -1 })).toBe(true);
    const shape = e.shapeStack(id)![0].shape;
    expect(shape.up).toEqual({ axis: 0, sign: -1 });
    expect([shape.max[0] - shape.min[0], shape.max[1] - shape.min[1]]).toEqual([4, 2]);
    e.setStepShape(id, step.id, { kind: "capsule" });
    // a capsule points along an axis either way
    expect(e.pointStep(id, step.id, { axis: 2, sign: -1 })).toBe(true);
    expect(e.shapeStack(id)![0].shape.up).toEqual({ axis: 2, sign: 1 });
    e.setStepShape(id, step.id, { kind: "diamond" });
    expect(e.pointStep(id, step.id, { axis: 0, sign: 1 })).toBe(false);
  });
});

describe("drawing shapes", () => {
  /** Drag the shape brush on the floor from one cell to another; the base it draws. */
  const draw = (e: Editor, from: [number, number], to: [number, number]) => {
    e.setTool("add");
    e.setBrush("shape");
    e.pointerDown({ ray: down(...from) });
    e.pointerMove({ ray: down(...to) });
    e.pointerUp();
    const box = e.pendingShape!.box;
    e.cancelShape();
    return { x: [box.min[0], box.max[0]], z: [box.min[2], box.max[2]] };
  };

  test("from a corner, from the center, and with a square base", () => {
    const e = editor([12, 12, 12]);
    expect(draw(e, [4, 4], [6, 5])).toEqual({ x: [4, 6], z: [4, 5] });
    e.setShapeFromCenter(true);
    expect(draw(e, [4, 4], [6, 5])).toEqual({ x: [2, 6], z: [3, 5] });
    e.setShapeUniform(true);
    expect(draw(e, [4, 4], [6, 5])).toEqual({ x: [2, 6], z: [2, 6] });
    e.setShapeFromCenter(false);
    expect(draw(e, [4, 4], [6, 5])).toEqual({ x: [4, 6], z: [4, 6] });
  });
});

test("edit_shapes renames and duplicates steps", () => {
  const e = editor();
  const tools = createAgentTools(e);
  const run = (name: string, input: Record<string, unknown>) => JSON.parse(tools.find((t) => t.name === name)!.execute(input));
  const { layer } = run("edit_shapes", { action: "new_layer", min: [0, 0, 0], max: [3, 3, 3] });
  const step = e.shapeStack(layer)![0].id;
  const renamed = run("edit_shapes", { action: "rename_step", layer, step, name: "Base" });
  expect(renamed.layers.find((l: { id: string }) => l.id === layer).steps[0].name).toBe("Base");
  const copied = run("edit_shapes", { action: "duplicate_step", layer, step });
  expect(copied.undo).toBe("Duplicate step");
  expect(e.shapeStack(layer)!.map((s) => s.name)).toEqual(["Base", "Base"]);
  expect(() => run("edit_shapes", { action: "rename_step", layer, step })).toThrow("needs name");
});

test("turning a step about an axis turns its box, direction, slope and corner; a ring drag is one undo step", () => {
  const e = editor();
  const id = e.addBoxLayer({ min: [0, 0, 0], max: [2, 4, 2] })!;
  const step = e.shapeStack(id)![0];
  e.setStepShape(id, step.id, { kind: "wedge" });
  const wedge = e.shapeStack(id)![0].shape;
  expect(e.rotateStepAbout(id, step.id, 0)).toBe(true);
  const turned = e.shapeStack(id)![0].shape;
  expect([turned.max[1] - turned.min[1], turned.max[2] - turned.min[2]]).toEqual([2, 4]);
  expect(turned.up).toEqual({ axis: 2, sign: 1 });
  expect(turned.forward).toEqual({ axis: 1, sign: -1 });
  expect(e.history.undoLabel).toBe("Turn shape");
  e.undo();
  expect(e.shapeStack(id)![0].shape).toEqual(wedge);

  e.setStepShape(id, step.id, { kind: "limb", corner: 0 });
  e.rotateStepAbout(id, step.id, 1, 2);
  expect(e.shapeStack(id)![0].shape.corner).toBe(5);

  // with the step selected, the gizmo's ring turns it; the whole drag is one undo step
  e.selectStep(step.id, id);
  e.setStepShape(id, step.id, { kind: "cone" });
  const label = e.history.undoLabel;
  e.beginStroke("Turn shape");
  e.turnPendingShape(2, 1);
  e.turnPendingShape(2, 1);
  e.endStroke();
  expect(e.shapeStack(id)![0].shape.up).toEqual({ axis: 1, sign: -1 });
  e.undo();
  expect(e.shapeStack(id)![0].shape.up).toEqual({ axis: 1, sign: 1 });
  expect(e.history.undoLabel).toBe(label);
});

describe("prisms and their settings", () => {
  const grid = { size: [8, 8, 8] as Vec3, resolution: 1 };
  const solid = (options: Record<string, unknown>, box: [Vec3, Vec3] = [[0, 0, 0], [8, 8, 8]]) =>
    evaluateSource({ steps: [boxStep(box[0], box[1], 1, "add", options)] }, grid);
  const at = (v: Uint8Array, x: number, y: number, z: number) => v[x + 8 * (y + 8 * z)];

  test("old boxes, cylinders, cones and pyramids load as prisms that fill the same cells", () => {
    const legacy = (shape: Record<string, unknown>) =>
      checkSource({ steps: [{ id: "step:a", mode: "add", material: 1, shape: { min: [0, 0, 0], max: [8, 8, 8], ...shape } }] }, 2);
    expect(legacy({ kind: "box" }).steps[0].shape).toMatchObject({ kind: "prism", sides: 4 });
    expect(legacy({ kind: "cylinder" }).steps[0].shape.sides).toBeUndefined();
    expect(legacy({ kind: "cone", top: 0.5 }).steps[0].shape).toMatchObject({ kind: "prism", taper: 0.5 });
    expect(legacy({ kind: "pyramid" }).steps[0].shape).toMatchObject({ kind: "prism", sides: 4, taper: 1 });
    expect(solid({ kind: "pyramid" })).toEqual(solid({ kind: "prism", sides: 4, taper: 1 }));
    expect(solid({ kind: "cone", taper: 0.5 })).toEqual(solid({ kind: "prism", taper: 0.5 }));
  });

  test("a polygon's sides fill the box, flat side toward forward's back", () => {
    const hex = solid({ kind: "hexagon" });
    const count = filled(hex);
    // less than the box, more than the cylinder inside it
    expect(count).toBeLessThan(512);
    expect(count).toBeGreaterThan(filled(solid({ kind: "cylinder" })) - 40);
    // it reaches every side of the box: across forward (z) flat to the edge, across g (x) to a point
    expect(at(hex, 4, 0, 0)).toBe(1);
    expect(at(hex, 4, 0, 7)).toBe(1);
    expect(at(hex, 0, 0, 3)).toBe(1);
    expect(at(hex, 0, 0, 0)).toBe(0);
    // a triangle is narrower still, the same top to bottom
    const tri = solid({ kind: "prism", sides: 3 });
    expect(filled(tri)).toBeLessThan(count);
    for (let y = 1; y < 8; y++) for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) expect(at(tri, x, y, z)).toBe(at(tri, x, 0, z));
  });

  test("a sweep keeps what is within so many degrees of forward", () => {
    const half = solid({ kind: "sphere", sweep: 180 });
    const whole = solid({ kind: "sphere" });
    expect(filled(half)).toBeLessThan(filled(whole));
    expect(filled(half)).toBeGreaterThan(filled(whole) / 2 - 20);
    // from forward (+z), turning toward +x: the +x half stays
    expect(at(half, 6, 4, 4)).toBe(1);
    expect(at(half, 1, 4, 4)).toBe(0);
    const three = solid({ kind: "prism", sweep: 270 });
    expect(filled(three)).toBeGreaterThan(filled(half));
    expect(() => checkSource({ steps: [boxStep([0, 0, 0], [8, 8, 8], 1, "add", { kind: "sphere", sweep: 100 })] }, 2)).toThrow("15");
  });

  test("a torus's tube is set apart from its height; an arch is part of one", () => {
    const ring = (tube?: number) => filled(solid({ kind: "torus", ...(tube ? { tube } : {}) }, [[0, 2, 0], [8, 4, 8]]));
    expect(ring(2)).toBeGreaterThan(ring());
    expect(ring(0.5)).toBeLessThan(ring());
    expect(filled(solid({ kind: "arch" }, [[0, 2, 0], [8, 4, 8]]))).toBeLessThan(ring());
  });

  test("a hollow shape can be open at the top, the bottom or both", () => {
    expect(filled(solid({ kind: "box", shell: 1 }))).toBe(512 - 216);
    expect(filled(solid({ kind: "box", shell: 1, openTop: true }))).toBe(512 - 216 - 36);
    expect(filled(solid({ kind: "box", shell: 1, openTop: true, openBottom: true }))).toBe(512 - 216 - 72);
    // a pipe lying on its side: open along x
    const pipe = solid({ kind: "cylinder", shell: 1, openTop: true, openBottom: true, up: { axis: 0, sign: 1 } });
    expect(at(pipe, 0, 4, 4)).toBe(0);
    expect(at(pipe, 0, 0, 4)).toBe(1);
    // an open end without a wall means nothing, and isn't kept
    expect(boxStep([0, 0, 0], [1, 1, 1], 1, "add", { kind: "box", openTop: true }).shape.openTop).toBeUndefined();
  });

  test("a prism's taper handle, editing it in place, drags its top in, one undo step", () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [8, 8, 8] })!;
    const step = e.shapeStack(id)![0];
    e.setStepShape(id, step.id, { kind: "cylinder" });
    e.editShape(step.id, id);
    const taper = e.shapeParamHandles.find((h) => h.id === "param-taper")!;
    expect(taper.point).toEqual([4, 8, 8]);
    expect(taper.along).toEqual({ axis: 2, sign: 1 });
    const label = e.history.undoLabel;
    // a ray straight down at z, moving in toward the axis
    const ray = (z: number): Ray => ({ origin: [4, 50, z], dir: [-1, 0, 0] });
    expect(e.pointerDown({ ray: ray(8), handle: "param-taper" })).toBe(true);
    e.pointerMove({ ray: ray(6) });
    e.pointerMove({ ray: ray(4) });
    e.pointerUp();
    expect(e.shapeStack(id)![0].shape.taper).toBe(1);
    e.undo();
    expect(e.shapeStack(id)![0].shape.taper).toBeUndefined();
    expect(e.history.undoLabel).toBe(label);
  });

  test("agents pick shapes by preset and see them by name", () => {
    const e = editor();
    const tools = createAgentTools(e);
    const run = (name: string, input: Record<string, unknown>) => JSON.parse(tools.find((t) => t.name === name)!.execute(input));
    const { layer } = run("edit_shapes", { action: "new_layer", min: [0, 0, 0], max: [7, 7, 7] });
    const hex = run("edit_shapes", { action: "add_step", layer, shape: "hexagon", min: [0, 0, 0], max: [3, 3, 3] });
    expect(hex.undo).toBe("Add hex prism");
    const steps = hex.layers.find((l: { id: string }) => l.id === layer).steps;
    expect(steps[0]).toMatchObject({ shape: "box", kind: "prism", sides: 4 });
    expect(steps[1]).toMatchObject({ shape: "hexagon", kind: "prism", sides: 6 });
    const cup = run("edit_shapes", { action: "set_shape", layer, step: hex.step, shape: "cylinder", shell: 1, openTop: true, taper: 0.25 });
    expect(cup.layers.find((l: { id: string }) => l.id === layer).steps[1]).toMatchObject({ kind: "prism", taper: 0.25, openTop: true, shell: 1 });
    expect(() => run("edit_shapes", { action: "set_shape", layer, step: hex.step, sweep: 100 })).toThrow("15");
  });
});

describe("paths", () => {
  const grid = { size: [8, 8, 8] as Vec3, resolution: 1 };
  const fill = (shape: Record<string, unknown>) =>
    evaluateSource(checkSource({ steps: [{ id: "step:p", mode: "add", material: 1, shape: { kind: "path", ...shape } }] }, 2), grid);
  const at = (v: Uint8Array, x: number, y: number, z: number) => v[x + 8 * (y + 8 * z)];
  const pt = (x: number, y: number, z: number) => ({ at: [x + 0.5, y + 0.5, z + 0.5] as Vec3 });

  test("a tube runs through its points, as wide as its radius, its box where it reaches", () => {
    const shape = checkSource({ steps: [{ id: "step:p", mode: "add", material: 1, shape: { kind: "path", points: [pt(1, 1, 1), pt(6, 1, 1)] } }] }, 2).steps[0].shape;
    expect(shape.min).toEqual([0.5, 0.5, 0.5]);
    expect(shape.max).toEqual([7.5, 2.5, 2.5]);
    const tube = fill({ points: [pt(1, 1, 1), pt(6, 1, 1)] });
    for (let x = 1; x <= 6; x++) expect(at(tube, x, 1, 1)).toBe(1);
    expect(at(tube, 3, 3, 1)).toBe(0);
    const thick = fill({ points: [pt(1, 1, 1), pt(6, 1, 1)], radius: 2 });
    expect(filled(thick)).toBeGreaterThan(filled(tube));
    // a point's own radius swells the tube there
    const swell = fill({ points: [pt(1, 3, 3), { ...pt(6, 3, 3), radius: 3 }] });
    expect(at(swell, 6, 5, 3)).toBe(1);
    expect(at(swell, 1, 5, 3)).toBe(0);
  });

  test("a smooth path curves through every point", () => {
    const points = [pt(1, 1, 1), pt(4, 6, 1), pt(6, 1, 1)];
    const straight = fill({ points, radius: 0.5 });
    const smooth = fill({ points, radius: 0.5, smooth: true });
    expect(smooth).not.toEqual(straight);
    for (const p of points) expect(at(smooth, p.at[0] - 0.5, p.at[1] - 0.5, 1)).toBe(1);
  });

  test("a wall stands on its path; a slab fills its outline", () => {
    const wall = fill({ profile: "wall", points: [pt(1, 0, 4), pt(6, 0, 4)], width: 1, height: 3 });
    expect(at(wall, 3, 0, 4)).toBe(1);
    expect(at(wall, 3, 2, 4)).toBe(1);
    expect(at(wall, 3, 3, 4)).toBe(0);
    expect(at(wall, 3, 0, 5)).toBe(0);
    const slab = fill({ profile: "slab", points: [pt(1, 0, 1), pt(5, 0, 1), pt(5, 0, 5), pt(1, 0, 5)], height: 2 });
    expect(at(slab, 3, 0, 3)).toBe(1);
    expect(at(slab, 3, 1, 3)).toBe(1);
    expect(at(slab, 3, 2, 3)).toBe(0);
    expect(at(slab, 6, 0, 3)).toBe(0);
    expect(() => fill({ profile: "slab", points: [pt(1, 0, 1), pt(5, 0, 1)] })).toThrow("three");
    expect(() => fill({ points: [] })).toThrow("at least one point");
  });

  test("a path's box moves, scales and turns its points", () => {
    const e = editor([16, 16, 16]);
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [1, 1, 1] })!;
    const step = e.addStep(id, "add", { min: [0, 0, 0], max: [0, 0, 0] }, 1, { kind: "tube", points: [pt(2, 2, 2), pt(6, 2, 2)] })!;
    const shape = () => e.shapeStack(id)!.find((s) => s.id === step)!.shape;
    expect(e.history.undoLabel).toBe("Add tube");
    // twice as long along x, moved up by 4
    const { min, max } = shape();
    expect(e.setStepBox(id, step, { min: [min[0], min[1] + 4, min[2]], max: [max[0] + 4, max[1] + 4, max[2]] })).toBe(true);
    expect(shape().points!.map((p) => p.at)).toEqual([[2.5, 6.5, 2.5], [10.5, 6.5, 2.5]]);
    // a quarter turn about y lays it along z
    e.rotateStepAbout(id, step, 1);
    const [a, b] = shape().points!.map((p) => p.at);
    expect(a[0]).toBe(b[0]);
    expect(Math.abs(a[2] - b[2])).toBe(8);
  });

  test("tapping with a tube draws a point a tap, undo takes the last back, Enter finishes", () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [8, 1, 8] })!;
    e.setShapeTool("tube");
    expect(e.tool).toBe("pen");
    expect(e.penProfile).toBe("tube");
    for (const [x, z] of [[1, 1], [5, 1], [5, 5]]) {
      e.pointerDown({ ray: down(x, z) });
      e.pointerUp();
    }
    const path = () => e.shapeStack(id)!.find((s) => s.shape.kind === "path")!;
    expect(path().shape.points!.map((p) => p.at)).toEqual([[1.5, 1.5, 1.5], [5.5, 1.5, 1.5], [5.5, 1.5, 5.5]]);
    expect(e.drawingPath?.stepId).toBe(path().id);
    expect(e.history.undoLabel).toBe("Add point");
    e.undo();
    expect(path().shape.points!.length).toBe(2);
    // dragging a new point slides it before it lands; the two are one undo step
    e.pointerDown({ ray: down(2, 6) });
    e.pointerMove({ ray: down(3, 6) });
    e.pointerUp();
    expect(path().shape.points![2].at).toEqual([3.5, 1.5, 6.5]);
    e.undo();
    expect(path().shape.points!.length).toBe(2);
    // while drawing, the path's box has no handles: its points are what the pointer works on
    expect(e.pendingShape?.editing).toBe(true);
    expect(e.shapeParamHandles.map((h) => h.id)).toContain("point-1");
    // the Pen shows where the next segment would go
    e.pointerHover({ ray: down(7, 6), hover: true });
    expect(e.preview?.lines).toEqual([[[5.5, 1.5, 1.5], [7.5, 1.5, 6.5]]]);
    // finishing ends on Select, holding the path
    e.finishPath();
    expect(e.drawingPath).toBeNull();
    expect(e.selectedStep?.step.id).toBe(path().id);
    expect(e.tool).toBe("select");
    expect(e.pendingShape?.editing).toBeUndefined();
    // the Pen again starts another path
    e.setTool("pen");
    e.pointerDown({ ray: down(7, 7) });
    e.pointerUp();
    expect(e.shapeStack(id)!.filter((s) => s.shape.kind === "path").length).toBe(2);
  });

  test("tapping a path's first point closes it and finishes; Esc drops a path of one point", () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [8, 1, 8] })!;
    e.setShapeTool("tube");
    for (const [x, z] of [[1, 1], [5, 1], [5, 5]]) {
      e.pointerDown({ ray: down(x, z) });
      e.pointerUp();
    }
    const path = () => e.shapeStack(id)!.find((s) => s.shape.kind === "path")!;
    expect(e.pointerDown({ ray: down(1, 1), handle: "point-0" })).toBe(true);
    e.pointerUp();
    expect(path().shape.closed).toBe(true);
    expect(path().shape.points!.length).toBe(3);
    expect(e.drawingPath).toBeNull();
    expect(e.tool).toBe("select");
    // one tap, then Esc: no path at all
    e.setTool("pen");
    const before = e.shapeStack(id)!.length;
    e.pointerDown({ ray: down(7, 7) });
    e.pointerUp();
    expect(e.shapeStack(id)!.length).toBe(before + 1);
    e.cancelPath();
    expect(e.shapeStack(id)!.length).toBe(before);
    expect(e.drawingPath).toBeNull();
    // two taps, then Esc: finished, like Enter
    e.pointerDown({ ray: down(6, 6) });
    e.pointerUp();
    e.pointerDown({ ray: down(7, 6) });
    e.pointerUp();
    e.cancelPath();
    expect(e.shapeStack(id)!.length).toBe(before + 1);
    expect(e.tool).toBe("select");
  });

  test("a path's points, editing it in place, drag, its + handles add points, and points delete", () => {
    const e = editor();
    const id = e.addBoxLayer({ min: [0, 0, 0], max: [8, 1, 8] })!;
    const step = e.addStep(id, "add", { min: [0, 0, 0], max: [0, 0, 0] }, 1, { kind: "tube", points: [pt(1, 2, 1), pt(5, 2, 1)] })!;
    e.editShape(step, id);
    const ids = e.shapeParamHandles.map((h) => h.id);
    expect(ids).toEqual(["point-0", "point-1", "insert-1"]);
    const shape = () => e.shapeStack(id)!.find((s) => s.id === step)!.shape;
    // drag the second point two cells along z, looking down
    e.pointerDown({ ray: { origin: [5.5, 50, 1.5], dir: [0, -1, 0] }, handle: "point-1" });
    e.pointerMove({ ray: { origin: [5.5, 50, 3.5], dir: [0, -1, 0] } });
    e.pointerUp();
    expect(shape().points![1].at).toEqual([5.5, 2.5, 3.5]);
    expect(e.history.undoLabel).toBe("Move point");
    // a tap on a point picks it for the panel
    e.pointerDown({ ray: { origin: [1.5, 50, 1.5], dir: [0, -1, 0] }, handle: "point-0" });
    e.pointerUp();
    expect(e.selectedPathPoint).toBe(0);
    // the middle's + puts a point there
    e.pointerDown({ ray: { origin: [3.5, 50, 2.5], dir: [0, -1, 0] }, handle: "insert-1" });
    e.pointerUp();
    expect(shape().points!.length).toBe(3);
    expect(shape().points![1].at).toEqual([3.5, 2.5, 2.5]);
    expect(e.removePathPoint(id, step, 1)).toBe(true);
    expect(e.removePathPoint(id, step, 0)).toBe(true);
    expect(e.removePathPoint(id, step, 0)).toBe(false);
  });

  test("paths save and load, and agents draw them by cells", () => {
    const e = editor();
    const tools = createAgentTools(e);
    const run = (name: string, input: Record<string, unknown>) => JSON.parse(tools.find((t) => t.name === name)!.execute(input));
    const { layer } = run("edit_shapes", { action: "new_layer", min: [0, 0, 0], max: [7, 0, 7] });
    const added = run("edit_shapes", { action: "add_step", layer, shape: "wall", points: [[1, 1, 1], [6, 1, 1], [6, 1, 6]], height: 3, smooth: true });
    expect(added.undo).toBe("Add wall");
    const info = added.layers.find((l: { id: string }) => l.id === layer).steps[1];
    expect(info).toMatchObject({ shape: "wall", kind: "path", profile: "wall", smooth: true, height: 3, points: [{ at: [1, 1, 1] }, { at: [6, 1, 1] }, { at: [6, 1, 6] }] });
    expect(() => run("edit_shapes", { action: "add_step", layer, shape: "tube" })).toThrow("needs points");
    const copy = new Editor(parseMoxel(serializeMoxel(e.getDocument())));
    const loaded = copy.shapeStack(copy.layers.find((l) => l.shape)!.id)![1];
    expect(loaded.shape).toEqual(e.shapeStack(layer)![1].shape);
    expect(copy.evaluate()).toEqual(e.evaluate());
  });
});
