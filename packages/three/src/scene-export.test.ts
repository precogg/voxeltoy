import { describe, expect, test } from "bun:test";
import { Mesh, Quaternion, Vector3, type Object3D } from "three";
import { Editor } from "@voxeltoy/core/editor";
import { LibraryEditor } from "@voxeltoy/core/library";
import { transformPoint } from "@voxeltoy/core/scene-math";
import { boxShape } from "@voxeltoy/core/source";
import type { DocumentData, Vec3 } from "@voxeltoy/core/types";
import { readNativeExtras } from "./marker-export";
import { buildSceneObject } from "./scene-export";

/** An arm with a hand mount marker at [2, 6, 2], pointing down. */
function arm(): { doc: DocumentData; hand: string } {
  const e = new Editor();
  e.newDocument([4, 8, 4]);
  e.setName("Arm");
  e.transact("Arm", () => {
    for (let y = 0; y < 7; y++) e.setVoxel([1, y, 1], 2);
  });
  const hand = e.addMarker({ shape: { kind: "point", at: [2, 6, 2], up: { axis: 1, sign: -1 } }, name: "Hand", role: "mount" })!;
  e.addMarker({ shape: { kind: "volume", shape: boxShape([0, 0, 0], [4, 8, 4]) }, name: "Body", role: "collision" });
  return { doc: e.getDocument(), hand };
}

function crate(name = "Sword"): DocumentData {
  const e = new Editor();
  e.newDocument([2, 4, 2]);
  e.setName(name);
  e.setVoxel([0, 0, 0], 4);
  return e.getDocument();
}

const find = (root: Object3D, name: string) => {
  let found: Object3D | undefined;
  root.traverse((o) => {
    if (!found && o.name === name) found = o;
  });
  if (!found) throw new Error(`no node ${name}`);
  return found;
};

const worldOf = (o: Object3D) => o.getWorldPosition(new Vector3()).toArray() as Vec3;
const close = (a: readonly number[], b: readonly number[]) => a.forEach((n, i) => expect(n).toBeCloseTo(b[i], 5));

describe("scene glTF", () => {
  test("an instance attached to a marker is that marker node's child, where the scene puts it", () => {
    const s = new LibraryEditor();
    s.openScene(s.newScene("Test")!);
    const { doc, hand } = arm();
    const armModel = s.addModel(doc, { voxelSize: 2 });
    const a = s.addInstance(armModel, { position: [10, 0, 0], rotation: [0, 90, 0], name: "Arm" })!;
    const sword = s.addInstance(s.addModel(crate()), { position: [10, 13, 1], name: "Sword" })!;
    expect(s.attach(sword, { instance: a, marker: hand })).toBe(true);

    const root = buildSceneObject(s);
    root.updateMatrixWorld(true);
    const swordNode = find(root, "Sword");
    expect(swordNode.parent!.name).toBe("Hand");
    expect(swordNode.parent!.parent!.name).toBe("Arm model");
    expect(swordNode.parent!.userData.voxeltoy).toEqual({ marker: hand, role: "mount", shape: "point" });
    // a volume marker says its shape and size
    expect(find(root, "Body").userData.voxeltoy).toMatchObject({ role: "collision", shape: "box", size: [4, 8, 4] });
    // the sword's origin lands where the scene has it
    close(worldOf(swordNode), transformPoint(s.worldMatrix(sword), [0, 0, 0]));
    // and its scale doesn't pick up the arm's voxel size
    const scale = new Vector3();
    swordNode.matrixWorld.decompose(new Vector3(), new Quaternion(), scale);
    close(scale.toArray(), [1, 1, 1]);
  });

  test("instances share one mesh per model, hidden ones are left out, and kinds carry their settings", () => {
    const s = new LibraryEditor();
    s.openScene(s.newScene("Test")!);
    s.registerKinds([{ id: "zone", label: "Zone", defaults: { fov: 60 }, bounds: () => ({ min: [0, 0, 0], max: [4, 2, 4] }) }]);
    const m = s.addModel(crate("Crate"));
    s.addInstance(m, { position: [0, 0, 0], name: "A" });
    s.addInstance(m, { position: [4, 0, 0], name: "B" });
    const hidden = s.addInstance(m, { position: [8, 0, 0], name: "C" })!;
    s.setVisible(hidden, false);
    s.addInstance(null, { kind: "zone", name: "Camera", data: { w: 1 } });

    const root = buildSceneObject(s);
    const meshes: Mesh[] = [];
    root.traverse((o) => o instanceof Mesh && meshes.push(o));
    expect(meshes.length).toBe(2);
    expect(meshes[0].geometry).toBe(meshes[1].geometry);
    expect(() => find(root, "C")).toThrow();
    expect(find(root, "Camera").userData).toMatchObject({ kind: "zone", settings: { fov: 60, w: 1 }, bounds: { max: [4, 2, 4] } });
    // instance nodes are placed by their transform; the model's grid is centered under them
    root.updateMatrixWorld(true);
    close(worldOf(find(root, "B")), [4, 0, 0]);
    const box = meshes[1].geometry.boundingBox ?? (meshes[1].geometry.computeBoundingBox(), meshes[1].geometry.boundingBox!);
    close(box.min.toArray(), [-1, 0, -1]);
  });

  test("two copies of a placed rig export as two node trees with their joints", () => {
    const s = new LibraryEditor();
    const level = s.newScene("Level")!;
    const { doc, hand } = arm();
    const armModel = s.addModel(doc);
    const swordModel = s.addModel(crate());
    const rig = s.newScene("Knight")!;
    s.openScene(rig);
    const a = s.addInstance(armModel, { position: [0, 0, 0], name: "Arm" })!;
    const sword = s.addInstance(swordModel, { name: "Sword" })!;
    s.attach(sword, { instance: a, marker: hand });
    s.openScene(level);
    s.addInstance(null, { scene: rig, position: [0, 0, 0], name: "Knight 1" });
    s.addInstance(null, { scene: rig, position: [10, 0, 0], name: "Knight 2" });

    const root = buildSceneObject(s);
    root.updateMatrixWorld(true);
    expect(root.children.map((c) => c.name)).toEqual(["Knight 1", "Knight 2"]);
    const swords: Object3D[] = [];
    root.traverse((o) => {
      if (o.name === "Sword" && o.userData.voxeltoy?.instance) swords.push(o);
    });
    expect(swords).toHaveLength(2);
    // each sword hangs from its own copy's hand, and the copies are 10 apart
    for (const sw of swords) expect(sw.parent!.name).toBe("Hand");
    const [p1, p2] = swords.map(worldOf);
    close([p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]], [10, 0, 0]);
    expect(find(root, "Knight 1").userData.voxeltoy.scene).toBe(rig);
  });

  test("reads legacy extras.moxel when extras.voxeltoy is absent", () => {
    expect(readNativeExtras({ moxel: { marker: "old" } })).toEqual({ marker: "old" });
    expect(readNativeExtras({ voxeltoy: { marker: "new" }, moxel: { marker: "old" } })).toEqual({ marker: "new" });
  });
});
