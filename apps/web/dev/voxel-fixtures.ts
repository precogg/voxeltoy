// Renders integrations/godot/fixtures/views.json with VoxelVolume, flat, the way the Godot spike
// does (docs/voxel-runtime.md, stage 4), so compare.ts can diff the two engines. Color management
// stays on, as in Godot: the palette is sRGB, shading happens in linear, output is sRGB.
// window.renderFixture(name) returns a PNG data URL. Not part of the build.
import { OrthographicCamera, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three";
import { loadVoxelAnimation, VoxelVolume } from "@voxeltoy/three/voxel-volume";

const files = import.meta.glob("../../../integrations/godot/fixtures/**/*.json", { query: "?url", import: "default", eager: true }) as Record<string, string>;
const url = (path: string) => Object.entries(files).find(([key]) => key.endsWith(path))![1];

interface View {
  name: string;
  model: string;
  frame: number;
  width: number;
  height: number;
  camera: { position: number[]; target: number[]; fov: number; near: number; far: number; orthoHeight?: number };
  shade: boolean;
  ao: boolean;
}

const views: View[] = await (await fetch(url("fixtures/views.json"))).json();
const models = {
  ball: await loadVoxelAnimation(url("fixtures/ball/volumes.json")),
  critter: await loadVoxelAnimation(url("fixtures/critter/volumes.json")),
};

const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const renderer = new WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setClearColor(0x9aa3ad, 1);

function renderFixture(name: string): string {
  return renderView(views.find((v) => v.name === name)!);
}

function renderView(view: View): string {
  renderer.setSize(view.width, view.height, false);
  canvas.style.width = `${view.width}px`;
  const aspect = view.width / view.height;
  const c = view.camera;
  const camera = c.orthoHeight
    ? new OrthographicCamera((-c.orthoHeight * aspect) / 2, (c.orthoHeight * aspect) / 2, c.orthoHeight / 2, -c.orthoHeight / 2, c.near, c.far)
    : new PerspectiveCamera(c.fov, aspect, c.near, c.far);
  camera.position.fromArray(c.position);
  camera.lookAt(new Vector3().fromArray(c.target));
  const scene = new Scene();
  const volume = VoxelVolume.fromAnimation(models[view.model as keyof typeof models], { shade: view.shade, ao: view.ao });
  volume.frame = view.frame;
  scene.add(volume);
  renderer.render(scene, camera);
  volume.dispose();
  return canvas.toDataURL("image/png");
}

Object.assign(window, { renderFixture, renderView, fixtureViews: views.map((v) => v.name), fixtureView: (name: string) => views.find((v) => v.name === name) });
document.querySelector("#status")!.textContent = `Ready: ${views.length} views`;
