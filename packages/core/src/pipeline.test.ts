import { describe, expect, test } from "bun:test";
import { applyEffects, checkEffects, type Effect } from "./effects";
import { applyStep, blendCell, blendStage, composeCell, composeLayers, layerBlend, stageTree, stepBlend, type Blend } from "./evaluate";
import { boxStep } from "./source";

// docs/pipeline.md, "Stages: content and blend": every layer kind and step mode is a blend.
describe("blends", () => {
  test("layers and steps map onto occupancy and keep", () => {
    expect(layerBlend({})).toEqual({ occupancy: "union", keep: false });
    expect(layerBlend({ coverage: new Uint8Array(1) })).toEqual({ occupancy: "replace", keep: false });
    expect(stepBlend({ mode: "add" })).toEqual({ occupancy: "union", keep: false });
    expect(stepBlend({ mode: "add", keep: true })).toEqual({ occupancy: "union", keep: true });
    expect(stepBlend({ mode: "cut", keep: true })).toEqual({ occupancy: "subtract", keep: false });
    expect(stepBlend({ mode: "intersect" })).toEqual({ occupancy: "intersect", keep: false });
    expect(stepBlend({ mode: "intersect", keep: true })).toEqual({ occupancy: "intersect", keep: true });
    expect(stepBlend({ mode: "paint" })).toEqual({ occupancy: "none", keep: false });
  });

  // below: empty (0) or solid (5); stage: no alpha, covered empty, or solid 9
  const cases: [Blend, number[]][] = [
    // results for [below 0, below 5] × [no alpha, alpha empty, alpha 9]
    [{ occupancy: "union", keep: false }, [0, 0, 9, 5, 5, 9]],
    [{ occupancy: "union", keep: true }, [0, 0, 9, 5, 5, 5]],
    [{ occupancy: "replace", keep: false }, [0, 0, 9, 5, 0, 9]],
    [{ occupancy: "subtract", keep: false }, [0, 0, 0, 5, 5, 0]],
    [{ occupancy: "intersect", keep: false }, [0, 0, 0, 0, 0, 9]],
    [{ occupancy: "intersect", keep: true }, [0, 0, 0, 0, 0, 5]],
    [{ occupancy: "none", keep: false }, [0, 0, 0, 5, 5, 9]],
  ];
  for (const [blend, want] of cases) {
    test(`${blend.occupancy}${blend.keep ? " keep" : ""}`, () => {
      const got: number[] = [];
      for (const below of [0, 5])
        for (const [alpha, value] of [
          [false, 0],
          [true, 0],
          [true, 9],
        ] as const)
          got.push(blendCell(below, alpha, value, blend));
      expect(got).toEqual(want);
    });
  }

  test("a step applies its blend inside its shape", () => {
    const grid = { size: [4, 1, 1] as [number, number, number], resolution: 1 };
    const below = () => Uint8Array.from([0, 5, 5, 0]);
    const run = (mode: "add" | "cut" | "intersect" | "paint", keep = false) => {
      const v = below();
      // a box over cells 1 and 2, whose neighbors 0 and 3 are empty
      applyStep(boxStep([1, 0, 0], [3, 1, 1], 9, mode, { keep }), grid, v);
      return [...v];
    };
    expect(run("add")).toEqual([0, 9, 9, 0]);
    expect(run("add", true)).toEqual([0, 5, 5, 0]);
    expect(run("cut")).toEqual([0, 0, 0, 0]);
    expect(run("paint")).toEqual([0, 9, 9, 0]);
    expect(run("intersect")).toEqual([0, 9, 9, 0]);
    expect(run("intersect", true)).toEqual([0, 5, 5, 0]);
  });

  test("an intersect stage empties cells it has no content for", () => {
    const volume = Uint8Array.from([5, 5, 5]);
    blendStage(volume, Uint8Array.from([0, 9, 0]), null, { occupancy: "intersect", keep: true });
    expect([...volume]).toEqual([0, 5, 0]);
  });

  test("layers compose as their blends say", () => {
    const grid = { size: [3, 1, 1] as [number, number, number], resolution: 1 };
    const out = composeLayers(
      [
        { data: Uint8Array.from([1, 1, 1]) },
        { data: Uint8Array.from([0, 2, 0]) },
        { data: Uint8Array.from([0, 0, 3]), coverage: Uint8Array.from([1, 0, 1]) },
      ],
      grid,
    );
    expect([...out]).toEqual([0, 2, 3]);
  });
});

describe("layer blends, masks and groups", () => {
  const grid = { size: [4, 1, 1] as [number, number, number], resolution: 1 };
  const row = (...v: number[]) => Uint8Array.from(v);

  test("a layer cuts what is below it with a subtract blend", () => {
    const out = composeLayers([{ data: row(1, 1, 1, 1) }, { data: row(0, 9, 9, 0), blend: { occupancy: "subtract", keep: false } }], grid);
    expect([...out]).toEqual([1, 0, 0, 1]);
  });

  test("a mask limits where a layer acts, even an intersect", () => {
    const out = composeLayers(
      [{ data: row(1, 1, 1, 1) }, { data: row(0, 9, 0, 0), blend: { occupancy: "intersect", keep: true }, mask: row(0, 1, 1, 0) }],
      grid,
    );
    // inside the mask, the intersect empties what it doesn't cover; outside, nothing changes
    expect([...out]).toEqual([1, 1, 0, 1]);
  });

  test("a group isolates its members: a cut inside it cuts only them", () => {
    const groups = [{ id: "g" }];
    const out = composeLayers(
      [
        { data: row(1, 1, 1, 1) },
        { data: row(0, 2, 2, 2), group: "g" },
        { data: row(0, 0, 9, 0), group: "g", blend: { occupancy: "subtract", keep: false } },
      ],
      grid,
      { groups },
    );
    expect([...out]).toEqual([1, 2, 1, 2]);
    // with a paint blend the group only recolors what is below it
    const painted = composeLayers([{ data: row(1, 0, 1, 0) }, { data: row(5, 5, 0, 0), group: "g" }], grid, {
      groups: [{ id: "g", blend: { occupancy: "none", keep: false } }],
    });
    expect([...painted]).toEqual([5, 0, 1, 0]);
  });

  test("a hidden group hides its members; a group sits where its lowest member is", () => {
    const layers = [{ data: row(3, 0, 0, 0), group: "g" }, { data: row(4, 4, 0, 0) }, { data: row(0, 0, 6, 0), group: "g" }];
    expect([...composeLayers(layers, grid, { groups: [{ id: "g", visible: false }] })]).toEqual([4, 4, 0, 0]);
    // the group (3 and 6) composes first, then the layer above it covers cell 0
    expect([...composeLayers(layers, grid, { groups: [{ id: "g" }] })]).toEqual([4, 4, 6, 0]);
  });

  test("one cell composes as the whole volume does", () => {
    let seed = 7;
    const r = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const occupancies = ["union", "replace", "subtract", "intersect", "none"] as const;
    const size: [number, number, number] = [5, 1, 1];
    for (let trial = 0; trial < 200; trial++) {
      const groups = [{ id: "a", blend: { occupancy: occupancies[Math.floor(r() * 5)], keep: r() < 0.3 } }, { id: "b", group: "a" }];
      const layers = Array.from({ length: 4 }, () => {
        const data = Uint8Array.from({ length: 5 }, () => (r() < 0.5 ? 0 : 1 + Math.floor(r() * 3)));
        return {
          data,
          ...(r() < 0.3 ? { coverage: Uint8Array.from(data, (v) => (v || r() < 0.3 ? 1 : 0)) } : {}),
          ...(r() < 0.5 ? { blend: { occupancy: occupancies[Math.floor(r() * 5)], keep: r() < 0.3 } } : {}),
          ...(r() < 0.3 ? { mask: Uint8Array.from({ length: 5 }, () => (r() < 0.6 ? 1 : 0)) } : {}),
          ...(r() < 0.5 ? { group: r() < 0.5 ? "a" : "b" } : {}),
        };
      });
      const whole = composeLayers(layers, { size, resolution: 1 }, { groups });
      const tree = stageTree(layers, groups);
      for (let i = 0; i < 5; i++) {
        expect(composeCell(tree, i, { include: () => true, valueOf: (l) => l.data[i] })).toBe(whole[i]);
      }
    }
  });
});

describe("effects", () => {
  const size: [number, number, number] = [5, 1, 1];
  const row = (...v: number[]) => Uint8Array.from(v);
  const run = (values: Uint8Array, effects: Effect[], alpha: Uint8Array | null = null) => applyEffects(values, alpha, effects, size);

  test("mirror keeps both sides", () => {
    expect([...run(row(1, 2, 0, 0, 0), [{ kind: "mirror", axis: 0 }]).values]).toEqual([1, 2, 0, 2, 1]);
  });

  test("outline adds a skin across faces, covering what it adds", () => {
    const { values, alpha } = run(row(0, 0, 3, 0, 0), [{ kind: "outline", color: 7 }], row(0, 0, 1, 0, 0));
    expect([...values]).toEqual([0, 7, 3, 7, 0]);
    expect([...alpha!]).toEqual([0, 1, 1, 1, 0]);
  });

  test("hollow keeps the surface", () => {
    const cube = new Uint8Array(27).fill(1);
    const out = applyEffects(cube, null, [{ kind: "hollow" }], [3, 3, 3]).values;
    expect(out[13]).toBe(0);
    expect(out.reduce((n, v) => n + (v ? 1 : 0), 0)).toBe(26);
  });

  test("noise recolors the same cells every time, about as many as it says", () => {
    const solid = new Uint8Array(4096).fill(1);
    const a = applyEffects(solid, null, [{ kind: "noise", color: 2, amount: 4, seed: 9 }], [16, 16, 16]).values;
    const b = applyEffects(solid, null, [{ kind: "noise", color: 2, amount: 4, seed: 9 }], [16, 16, 16]).values;
    expect(a).toEqual(b);
    const share = a.reduce((n, v) => n + (v === 2 ? 1 : 0), 0) / 4096;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.3);
  });

  test("a layer's effects run before it blends; a group's after its members compose", () => {
    const grid = { size, resolution: 1 };
    const out = composeLayers([{ data: row(0, 0, 3, 0, 0), effects: [{ kind: "outline", color: 7 }] }], grid);
    expect([...out]).toEqual([0, 7, 3, 7, 0]);
    const grouped = composeLayers([{ data: row(1, 0, 0, 0, 0), group: "g" }, { data: row(0, 2, 0, 0, 0), group: "g" }], grid, {
      groups: [{ id: "g", effects: [{ kind: "mirror", axis: 0 }] }],
    });
    expect([...grouped]).toEqual([1, 2, 0, 2, 1]);
    expect(() => checkEffects([{ kind: "outline", color: 99 }], 8)).toThrow("palette");
  });
});
