import { BufferAttribute, Group, Mesh, MeshStandardMaterial, Object3D, type BufferGeometry } from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { Editor } from "@voxeltoy/core/editor";
import { originCells } from "@voxeltoy/core/markers";
import type { Vec3 } from "@voxeltoy/core/types";
import { markerObjects } from "./marker-export";
import type { Viewport } from "./viewport";

/**
 * Visible layers as one binary glTF mesh with flat vertex colors, its origin at the model's: what
 * the model evaluates to on the open frame, one unit per source unit (one voxel at 1× resolution,
 * two at 2×). Markers become named empty nodes beside the mesh, with what they are in `extras`.
 */
export async function exportGlb(viewport: Viewport, editor: Editor): Promise<Blob> {
  const frame = editor.activeFrameId;
  const doc = editor.doc;
  const volume = editor.evaluateFrame(frame);
  const geometry = exportGeometry(viewport, volume, originCells(doc));
  const mesh = new Mesh(geometry, voxelMaterial());
  mesh.name = editor.name;
  const markers = [...markerObjects(doc, frame).values()];
  if (!markers.length) {
    const scale = 1 / editor.resolution;
    if (scale !== 1) geometry.scale(scale, scale, scale);
    return encodeGlb(mesh);
  }
  const root = new Group();
  root.name = editor.name;
  root.scale.setScalar(1 / editor.resolution);
  root.add(mesh, ...markers);
  return encodeGlb(root);
}

/** A volume meshed with flat linear vertex colors, translated so `origin` (in grid units) is at (0, 0, 0). */
function exportGeometry(viewport: Viewport, volume: Uint8Array, origin: Vec3): BufferGeometry {
  const geometry = viewport.buildExportGeometry(volume);
  geometry.translate(-origin[0], -origin[1], -origin[2]);
  // Quads have their own vertices, so indexed geometry still gives flat normals.
  geometry.computeVertexNormals();

  // glTF vertex colors are linear; the palette is sRGB.
  const srgb = geometry.getAttribute("color");
  const linear = new Float32Array(srgb.count * 3);
  for (let i = 0; i < srgb.count; i++) {
    linear[i * 3] = toLinear(srgb.getX(i));
    linear[i * 3 + 1] = toLinear(srgb.getY(i));
    linear[i * 3 + 2] = toLinear(srgb.getZ(i));
  }
  geometry.setAttribute("color", new BufferAttribute(linear, 3));
  return geometry;
}

function voxelMaterial() {
  return new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
}

async function encodeGlb(root: Object3D): Promise<Blob> {
  try {
    // translation / rotation / scale rather than matrices: glTF only animates nodes that use them
    const result = await new GLTFExporter().parseAsync(root, { binary: true, trs: true });
    return new Blob([result as ArrayBuffer], { type: "model/gltf-binary" });
  } finally {
    root.traverse((o) => (o as Mesh).geometry?.dispose());
  }
}

function toLinear(c: number) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
