// A scene as glTF: a node per instance following attachment, one mesh per model and frame shared
// by its instances, a model's markers as nodes so what hangs from a marker is that node's child, and
// a placed scene as a node holding its own instances.
// See docs/scenes.md ("Files").

import { BufferAttribute, Group, Mesh, MeshStandardMaterial, Object3D, type BufferGeometry } from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { VoxelDocument } from "@voxeltoy/core/document";
import { originCells } from "@voxeltoy/core/markers";
import { EXTRAS_KEY, markerObjects } from "./marker-export";
import type { LibraryEditor } from "@voxeltoy/core/library";
import type { InstanceRecord } from "@voxeltoy/core/scene-ops";
import type { Vec3 } from "@voxeltoy/core/types";
import { Mesher, MESH_NO_AO, MESH_NO_SHADE } from "./mesher";

export interface SceneExportOptions {
  /** The frame each instance shows (a looping one: the frame showing now). Defaults to its model's open frame. */
  frameOf?: (instance: string) => string;
}

/**
 * The scene as a tree of three.js objects, ready for the glTF exporter: nodes in world units,
 * the root at the world's origin. Each instance node holds its transform; its model hangs below
 * it in a node scaled by the model's voxel size. Settings and kinds are in each node's
 * `userData`, which glTF writes as `extras`.
 */
export function buildSceneObject(scene: LibraryEditor, options: SceneExportOptions = {}): Group {
  const mesher = new Mesher();
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  /** One geometry per model and frame, so instances share meshes. */
  const geometries = new Map<string, BufferGeometry>();
  const geometryOf = (model: string, doc: VoxelDocument, frame: string, volume: () => Uint8Array, origin: Vec3) => {
    const key = `${model}|${frame}`;
    let g = geometries.get(key);
    if (!g) {
      g = linearColors(mesher.build(volume(), doc.size, doc.palette, MESH_NO_SHADE | MESH_NO_AO));
      g.translate(-origin[0], -origin[1], -origin[2]);
      g.computeVertexNormals();
      geometries.set(key, g);
    }
    return g;
  };

  /**
   * Nodes for one scene's instances, following attachment: the open scene's, or those of a scene
   * an instance places (`within` lists the scenes already being built, so none places itself).
   */
  const build = (instances: readonly InstanceRecord[], within: ReadonlySet<string>, open: boolean): Object3D[] => {
    const byId = new Map(instances.map((i) => [i.id, i]));
    const shown = (inst: InstanceRecord) => {
      if (open) return scene.isShown(inst.id);
      for (let at: InstanceRecord | undefined = inst, n = 0; at && n <= instances.length; at = at.parent ? byId.get(at.parent.instance) : undefined, n++) {
        if (!at.visible) return false;
      }
      return true;
    };
    const nodes = new Map<string, Object3D>();
    /** Where things attached to an instance's markers go: marker id to node, and the model's voxel size. */
    const joints = new Map<string, { markers: Map<string, Object3D>; voxelSize: number }>();

    for (const inst of instances) {
      // hiding an instance hides what hangs from it
      if (!shown(inst)) continue;
      const node = new Object3D();
      node.name = inst.name;
      node.position.set(...inst.position);
      node.quaternion.set(...inst.rotation);
      node.scale.setScalar(inst.scale ?? 1);
      const settings = inst.kind ? (open ? scene.settings(inst.id) : (inst.data ?? {})) : undefined;
      const model = open ? scene.modelFor(inst.id) : inst.model;
      node.userData = {
        [EXTRAS_KEY]: { instance: inst.id, ...(model ? { model } : {}), ...(inst.scene !== undefined ? { scene: inst.scene } : {}) },
        ...(inst.kind ? { kind: inst.kind, settings } : {}),
        ...(open && !model && inst.kind ? { bounds: scene.instanceBounds(inst.id) } : {}),
      };
      nodes.set(inst.id, node);
      if (inst.scene !== undefined) {
        // a placed scene: its own instances, built the same way, below this one
        if (!within.has(inst.scene)) node.add(...build(scene.sceneInstances(inst.scene), new Set(within).add(inst.scene), false));
        continue;
      }
      if (!model) continue;

      const doc = scene.document(model);
      const voxelSize = scene.model(model)?.voxelSize ?? 1;
      const frame = (open ? options.frameOf?.(inst.id) : undefined) ?? scene.recordFrame(inst, model) ?? doc.openFrameId;
      const modelNode = new Object3D();
      modelNode.name = `${doc.name} model`;
      modelNode.scale.setScalar(voxelSize);
      node.add(modelNode);
      const geometry = geometryOf(model, doc, frame, () => doc.evaluateFrame(frame), originCells(doc));
      if (geometry.getAttribute("position").count) {
        const mesh = new Mesh(geometry, material);
        mesh.name = doc.name;
        modelNode.add(mesh);
      }
      const markers = markerObjects(doc, frame);
      for (const m of markers.values()) modelNode.add(m);
      joints.set(inst.id, { markers, voxelSize });
    }

    const roots: Object3D[] = [];
    for (const inst of instances) {
      const node = nodes.get(inst.id);
      if (!node) continue;
      const parent = inst.parent ? nodes.get(inst.parent.instance) : undefined;
      if (!parent) {
        roots.push(node);
        continue;
      }
      const marker = inst.parent!.marker;
      const joint = marker ? joints.get(inst.parent!.instance) : undefined;
      const markerNode = marker ? joint?.markers.get(marker) : undefined;
      if (!joint || !markerNode) {
        parent.add(node);
        continue;
      }
      // hang from the marker's node: it is in the model's frame, so undo the voxel size it scales by
      const vs = joint.voxelSize;
      node.position.divideScalar(vs);
      node.scale.divideScalar(vs);
      markerNode.add(node);
    }
    return roots;
  };

  const root = new Group();
  root.name = scene.sceneName;
  const open = scene.scene;
  const roots = build(scene.instances, new Set(open ? [open] : []), true);
  if (roots.length) root.add(...roots);
  return root;
}

/** The scene as a binary glTF file. */
export async function exportSceneGlb(scene: LibraryEditor, options: SceneExportOptions = {}): Promise<Blob> {
  const root = buildSceneObject(scene, options);
  if (!root.children.length) throw new Error("There is nothing visible in the scene to export");
  try {
    const result = await new GLTFExporter().parseAsync(root, { binary: true, trs: true });
    return new Blob([result as ArrayBuffer], { type: "model/gltf-binary" });
  } finally {
    const seen = new Set<BufferGeometry>();
    root.traverse((o) => {
      const g = (o as Mesh).geometry;
      if (g && !seen.has(g)) {
        seen.add(g);
        g.dispose();
      }
    });
  }
}

/** glTF vertex colors are linear; the palette is sRGB. */
function linearColors(geometry: BufferGeometry): BufferGeometry {
  const srgb = geometry.getAttribute("color");
  if (!srgb) return geometry;
  const linear = new Float32Array(srgb.count * 3);
  for (let i = 0; i < srgb.count; i++) {
    linear[i * 3] = toLinear(srgb.getX(i));
    linear[i * 3 + 1] = toLinear(srgb.getY(i));
    linear[i * 3 + 2] = toLinear(srgb.getZ(i));
  }
  geometry.setAttribute("color", new BufferAttribute(linear, 3));
  return geometry;
}

function toLinear(c: number) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
