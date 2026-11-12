import { describe, expect, test } from "bun:test";
import { Editor } from "./editor";
import { parseMoxel, serializeMoxel } from "./formats/moxel";
import type { Vec3 } from "./types";

function editor(size: Vec3 = [6, 6, 6]) {
  const e = new Editor();
  e.newDocument(size);
  return e;
}

const reopen = (e: Editor) => new Editor(parseMoxel(serializeMoxel(e.getDocument())));
/** What the display shows at a cell, and what the document evaluates to there. */
const at = (e: Editor, c: Vec3) => {
  const i = c[0] + e.size[0] * (c[1] + e.size[1] * c[2]);
  return [e.composite[i], e.evaluate()[i]];
};

describe("layer stages in the editor", () => {
  test("a layer with a cut blend cuts the layers below it, live and undoably", () => {
    const e = editor();
    e.setCells([[1, 0, 1], [2, 0, 1]], 2);
    const top = e.createLayer("Hole")!;
    e.setLayerBlend(top, { occupancy: "subtract", keep: false });
    e.setCells([[1, 0, 1]], 5);
    expect(at(e, [1, 0, 1])).toEqual([0, 0]);
    expect(at(e, [2, 0, 1])).toEqual([2, 2]);
    e.undo(); // the voxel
    expect(at(e, [1, 0, 1])).toEqual([2, 2]);
    e.undo(); // the blend
    e.redo();
    e.redo();
    expect(at(e, [1, 0, 1])).toEqual([0, 0]);
  });

  test("a mask from the selection limits where a layer acts", () => {
    const e = editor();
    const below = e.activeLayerId;
    e.setCells([[0, 0, 0], [1, 0, 0]], 2);
    const top = e.createLayer("Paint")!;
    e.setLayerBlend(top, { occupancy: "none", keep: false });
    e.selectBox({ min: [0, 0, 0], max: [0, 0, 0] });
    e.maskLayerToSelection(top);
    e.deselect();
    e.selectLayer(top);
    e.setCells([[0, 0, 0], [1, 0, 0]], 7);
    // the paint only recolors inside the mask
    expect(at(e, [0, 0, 0])).toEqual([7, 7]);
    expect(at(e, [1, 0, 0])).toEqual([2, 2]);
    e.selectLayerMask(top);
    expect(e.hasSelection).toBe(true);
    e.clearLayerMask(top);
    expect(at(e, [1, 0, 0])).toEqual([7, 7]);
    expect(e.layers.find((l) => l.id === below)).toBeTruthy();
  });

  test("groups isolate, hide, ungroup and delete, each one undo step", () => {
    const e = editor();
    const base = e.activeLayerId;
    e.setCells([[0, 0, 0], [1, 0, 0]], 1);
    const a = e.createLayer("A")!;
    e.setCells([[0, 1, 0], [1, 1, 0]], 3);
    const cut = e.createLayer("Cut")!;
    e.setLayerBlend(cut, { occupancy: "subtract", keep: false });
    e.setCells([[1, 0, 0], [1, 1, 0]], 9);
    // ungrouped, the cut takes both
    expect(at(e, [1, 0, 0])).toEqual([0, 0]);
    const g = e.createGroup([a, cut], "Arm")!;
    // grouped, it only cuts what is in its group
    expect(at(e, [1, 0, 0])).toEqual([1, 1]);
    expect(at(e, [1, 1, 0])).toEqual([0, 0]);
    e.setGroupVisible(g, false);
    expect(at(e, [0, 1, 0])).toEqual([0, 0]);
    e.setGroupVisible(g, true);
    e.ungroup(g);
    expect(e.groups).toHaveLength(0);
    expect(at(e, [1, 0, 0])).toEqual([0, 0]);
    e.undo();
    expect(e.groups.map((x) => x.name)).toEqual(["Arm"]);
    expect(e.layers.filter((l) => l.group === g)).toHaveLength(2);
    e.deleteGroup(g);
    expect(e.layers.map((l) => l.id)).toEqual([base]);
    e.undo();
    expect(e.layers).toHaveLength(3);
  });

  test("effects show in the display, which composes again as a whole", async () => {
    const e = editor();
    e.setCells([[2, 2, 2]], 3);
    e.addLayerEffect(e.activeLayerId, { kind: "outline", color: 5 });
    expect(at(e, [2, 2, 3])).toEqual([5, 5]);
    e.setCells([[0, 0, 0]], 3);
    await Promise.resolve();
    expect(at(e, [1, 0, 0])).toEqual([5, 5]);
    e.removeLayerEffect(e.activeLayerId, 0);
    expect(at(e, [2, 2, 3])).toEqual([0, 0]);
  });

  test("blends, masks, effects and groups survive a save and reload", () => {
    const e = editor();
    e.setCells([[1, 1, 1]], 2);
    const top = e.createLayer("Top")!;
    e.setLayerBlend(top, { occupancy: "union", keep: true });
    e.addLayerEffect(top, { kind: "noise", color: 4, amount: 3, seed: 2 });
    e.selectBox({ min: [0, 0, 0], max: [2, 2, 2] });
    e.maskLayerToSelection(top);
    const g = e.createGroup([top], "Fx")!;
    e.setGroupEffects(g, [{ kind: "mirror", axis: 0 }]);
    const copy = reopen(e);
    expect(copy.groups).toEqual(e.groups);
    const t = copy.layers.find((l) => l.name === "Top")!;
    expect(t.blend).toEqual({ occupancy: "union", keep: true });
    expect(t.effects).toEqual([{ kind: "noise", color: 4, amount: 3, seed: 2 }]);
    expect(t.group).toBe(g);
    expect(t.mask!.reduce((n, v) => n + v, 0)).toBe(27);
    expect(copy.evaluate()).toEqual(e.evaluate());
  });

  test("a resize moves masks, and undo puts them back", () => {
    const e = editor([4, 4, 4]);
    e.selectBox({ min: [3, 0, 0], max: [3, 0, 0] });
    e.maskLayerToSelection();
    e.resize([3, 4, 4], [0, 0, 0]);
    expect(e.activeLayer!.mask!.reduce((n, v) => n + v, 0)).toBe(0);
    e.undo();
    expect(e.activeLayer!.mask![3]).toBe(1);
  });
});
