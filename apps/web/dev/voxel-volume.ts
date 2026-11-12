// Dev page for VoxelVolume (docs/voxel-runtime.md, stages 0 and 1): the ray-marched volume beside
// today's mesh of the same voxels, flat or lit with shadows, with an image diff and frame timings.
// Open /dev/voxel-volume.html with `pnpm dev:app`. Not part of the build.
import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  ColorManagement,
  DirectionalLight,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  OrthographicCamera,
  Plane,
  PerspectiveCamera,
  PointLight,
  Raycaster,
  Scene,
  SpotLight,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Editor } from "@voxeltoy/core/editor";
import { parseMoxel } from "@voxeltoy/core/formats/moxel";
import { readLocal } from "../src/storage";
import { readVolumesZip, toVoxelAnimation, writeVolumes } from "@voxeltoy/core/formats/volumes";
import { writeZip } from "@voxeltoy/core/formats/zip";
import { sampleAnimation } from "./samples";
import { Mesher, MESH_NO_AO, MESH_NO_SHADE } from "@voxeltoy/three/mesher";
import { VoxelVolume, type VoxelIntersection } from "@voxeltoy/three/voxel-volume";

// As in the editor viewport: palette bytes in, bytes out.
ColorManagement.enabled = false;

type View = "split" | "mesh" | "volume";
type Lighting = "flat" | "lit";
type LightKind = "sun" | "spot" | "lamp";

/** The document's frames, or a sample, as one VoxelAnimation. */
function loadFrames() {
  const text = new URLSearchParams(location.search).has("sample") ? null : readLocal("voxeltoy:document", "moxel:document");
  if (text) {
    try {
      const editor = new Editor(parseMoxel(text));
      const frames = editor.frames.map((f) => ({ id: f.id, duration: f.duration, voxels: editor.evaluateFrame(f.id) }));
      if (frames.some((f) => f.voxels.some((v) => v !== 0))) {
        return toVoxelAnimation({ name: editor.name, fps: editor.fps, size: editor.size, palette: editor.palette, frames });
      }
    } catch (error) {
      console.warn("Could not read the autosaved document", error);
    }
  }
  return sampleAnimation();
}

// Through a real export and read, zip included, so the page also checks the file format.
const animation = await readVolumesZip(writeZip(await writeVolumes(loadFrames())));
const model = { name: animation.name, size: animation.size, palette: animation.palette };
const [sx, sy, sz] = model.size;
const extent = Math.max(sx, sy, sz);

const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.outputColorSpace = LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setClearColor(0xf4f5f7, 1);
renderer.setScissorTest(true);
renderer.shadowMap.enabled = true;

const meshScene = new Scene();
const volumeScene = new Scene();
const mesher = new Mesher();
const meshMaterials = {
  flat: new MeshBasicMaterial({ vertexColors: true }),
  lit: new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }),
};
// One mesh per distinct pose, built when first shown.
const meshCache = new Map<number, BufferGeometry>();
let volumes: VoxelVolume[] = [];
let meshes: Mesh[] = [];
const state = {
  view: "split" as View,
  ortho: false,
  count: 1,
  shade: true,
  ao: true,
  lighting: "flat" as Lighting,
  light: "sun" as LightKind,
  playing: false,
  glow: false,
  // the most used palette entry glows
  glowIndex: 1,
};

// Geometry that cuts through the model, to check depth and shadows against ordinary meshes.
const propMaterials = {
  flat: [new MeshBasicMaterial({ color: 0x9aa3ad }), new MeshBasicMaterial({ color: 0x3d4450 })],
  lit: [new MeshStandardMaterial({ color: 0x9aa3ad, roughness: 1 }), new MeshStandardMaterial({ color: 0x3d4450, roughness: 1 })],
};
const floorGeometry = new BoxGeometry(extent * 1.6, 0.25, extent * 1.6);
const poleGeometry = new BoxGeometry(extent * 0.08, extent * 1.4, extent * 0.08);
const props: Mesh[][] = [];
const lights: Record<LightKind, DirectionalLight | SpotLight | PointLight>[] = [];
for (const scene of [meshScene, volumeScene]) {
  const floor = new Mesh(floorGeometry, propMaterials.flat[0]);
  floor.position.y = sy * 0.3;
  const pole = new Mesh(poleGeometry, propMaterials.flat[1]);
  pole.position.set(extent * 0.15, sy * 0.5, extent * 0.1);
  for (const m of [floor, pole]) m.castShadow = m.receiveShadow = true;
  props.push([floor, pole]);
  scene.add(floor, pole);

  // A sun, a spot and a lamp from the same side, so each shadow path can be checked on its own.
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(extent * 1.2, extent * 2.4, extent * 0.7);
  Object.assign(sun.shadow.camera, { left: -extent * 6, right: extent * 6, top: extent * 6, bottom: -extent * 6, far: extent * 8 });
  sun.shadow.mapSize.set(4096, 4096);
  const spot = new SpotLight(0xffffff, 2.6, 0, 0.55, 0.3, 0);
  spot.position.set(extent * 1.1, extent * 2.2, extent * 0.9);
  const lamp = new PointLight(0xffffff, 2.4, 0, 0);
  lamp.position.set(extent * 0.75, extent * 1.3, extent * 0.55);
  for (const light of [sun, spot, lamp]) {
    light.castShadow = true;
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = 0.05;
    light.shadow.camera.near = 0.5;
    if (light !== sun) light.shadow.mapSize.set(2048, 2048);
    scene.add(light);
  }
  scene.add(new AmbientLight(0xffffff, 0.45));
  lights.push({ sun, spot, lamp });
}

function applyLighting() {
  const lit = state.lighting === "lit";
  for (const v of volumes) v.lighting = state.lighting;
  for (const m of meshes) m.material = meshMaterials[state.lighting];
  for (const [floor, pole] of props) {
    floor.material = propMaterials[state.lighting][0];
    pole.material = propMaterials[state.lighting][1];
  }
  for (const set of lights) {
    for (const [kind, light] of Object.entries(set)) light.visible = lit && kind === state.light;
  }
  rebuildMesh();
}

function meshFlags() {
  // Lit meshes are shaded by the lights, not by baked face shading.
  const shade = state.shade && state.lighting === "flat";
  return (shade ? 0 : MESH_NO_SHADE) | (state.ao ? 0 : MESH_NO_AO);
}

function placements(count: number) {
  const columns = Math.ceil(Math.sqrt(count));
  const step = extent * 1.25;
  return Array.from({ length: count }, (_, i) => {
    const col = i % columns, row = Math.floor(i / columns);
    const offset = ((columns - 1) * step) / 2;
    return [col * step - offset - sx / 2, 0, row * step - offset - sz / 2] as const;
  });
}

/** A pose's voxels placed in the whole grid, as the mesher wants them. */
function poseVoxels(index: number) {
  const { size, offset, data } = animation.volumes[index];
  const voxels = new Uint8Array(sx * sy * sz);
  for (let z = 0; z < size[2]; z++) {
    for (let y = 0; y < size[1]; y++) {
      const from = size[0] * (y + size[1] * z);
      voxels.set(data.subarray(from, from + size[0]), offset[0] + sx * (offset[1] + y + sy * (offset[2] + z)));
    }
  }
  return voxels;
}

function showMeshPose() {
  const pose = volumes[0] ? volumes[0].frames[volumes[0].frame].volume : 0;
  let geometry = meshCache.get(pose);
  if (!geometry) {
    geometry = mesher.build(poseVoxels(pose), model.size, model.palette, meshFlags());
    // The mesher writes no normals; the lit material needs them. Each quad has its own four vertices.
    geometry.computeVertexNormals();
    meshCache.set(pose, geometry);
  }
  for (const m of meshes) m.geometry = geometry;
}

function rebuildMesh(pose?: number) {
  for (const [i, g] of meshCache) {
    if (pose !== undefined && i !== pose) continue;
    g.dispose();
    meshCache.delete(i);
  }
  showMeshPose();
}

function rebuild() {
  const frame = volumes[0]?.frame ?? 0;
  for (const v of volumes) {
    volumeScene.remove(v);
    v.dispose();
  }
  for (const m of meshes) meshScene.remove(m);
  volumes = [];
  meshes = [];
  for (const [x, y, z] of placements(state.count)) {
    const volume = VoxelVolume.fromAnimation(animation, { shade: state.shade, ao: state.ao, lighting: state.lighting });
    volume.frame = frame;
    volume.position.set(x, y, z);
    volume.castShadow = volume.receiveShadow = true;
    volumes.push(volume);
    volumeScene.add(volume);
    const mesh = new Mesh(new BufferGeometry(), meshMaterials[state.lighting]);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    meshes.push(mesh);
    meshScene.add(mesh);
  }
  volumes[0].addEventListener("frame", showMeshPose);
  applyEffects();
  if (state.playing) for (const v of volumes) v.play();
  showMeshPose();
}

// Cameras
const perspective = new PerspectiveCamera(40, 1, 0.1, extent * 50);
const orthographic = new OrthographicCamera(-1, 1, 1, -1, 0.1, extent * 50);
perspective.position.set(extent * 2, extent * 1.5, extent * 2.4);
let camera: PerspectiveCamera | OrthographicCamera = perspective;
let controls = new OrbitControls(camera, canvas);
controls.target.set(0, sy * 0.45, 0);
controls.update();

function setCamera(ortho: boolean) {
  const next = ortho ? orthographic : perspective;
  next.position.copy(camera.position);
  next.quaternion.copy(camera.quaternion);
  const target = controls.target.clone();
  controls.dispose();
  camera = next;
  controls = new OrbitControls(camera, canvas);
  controls.target.copy(target);
  controls.update();
  state.ortho = ortho;
  resize();
}

function viewportWidth() {
  return state.view === "split" ? canvas.clientWidth / 2 : canvas.clientWidth;
}

function resize() {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  renderer.setSize(width, height, false);
  const aspect = viewportWidth() / height;
  perspective.aspect = aspect;
  perspective.updateProjectionMatrix();
  const half = extent * 0.9;
  orthographic.left = -half * aspect;
  orthographic.right = half * aspect;
  orthographic.top = half;
  orthographic.bottom = -half;
  orthographic.updateProjectionMatrix();
  document.querySelector<HTMLElement>("#tag-mesh")!.style.cssText =
    state.view === "volume" ? "display:none" : `left:${state.view === "split" ? width / 2 - 60 : width - 60}px`;
  document.querySelector<HTMLElement>("#tag-volume")!.style.cssText =
    state.view === "mesh" ? "display:none" : `left:${width - 110}px`;
}
new ResizeObserver(resize).observe(canvas);

// Rendering and timing
const gl = renderer.getContext() as WebGL2RenderingContext;
const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2") as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
const pending: WebGLQuery[] = [];
const gpuTimes: number[] = [];
const frameTimes: number[] = [];
let lastFrame = performance.now();

function drawScenes() {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (state.view === "split") {
    renderer.setViewport(0, 0, width / 2, height);
    renderer.setScissor(0, 0, width / 2, height);
    renderer.render(meshScene, camera);
    renderer.setViewport(width / 2, 0, width / 2, height);
    renderer.setScissor(width / 2, 0, width / 2, height);
    renderer.render(volumeScene, camera);
  } else {
    renderer.setViewport(0, 0, width, height);
    renderer.setScissor(0, 0, width, height);
    renderer.render(state.view === "mesh" ? meshScene : volumeScene, camera);
  }
}

function frame(now: number) {
  requestAnimationFrame(frame);
  frameTimes.push(now - lastFrame);
  // every copy keeps the same time; the first one's frame events switch the mesh
  for (const v of volumes) v.update((now - lastFrame) / 1000);
  lastFrame = now;
  if (frameTimes.length > 120) frameTimes.shift();

  let query: WebGLQuery | null = null;
  if (timer && pending.length < 4) {
    query = gl.createQuery();
    gl.beginQuery(timer.TIME_ELAPSED_EXT, query!);
  }
  drawScenes();
  if (query) {
    gl.endQuery(timer!.TIME_ELAPSED_EXT);
    pending.push(query);
  }
  while (timer && pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
    const q = pending.shift()!;
    if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) gpuTimes.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
    gl.deleteQuery(q);
    if (gpuTimes.length > 120) gpuTimes.shift();
  }
}
requestAnimationFrame(frame);

const average = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const statsEl = document.querySelector<HTMLElement>("#stats")!;
setInterval(() => {
  const size = renderer.getDrawingBufferSize(new Vector2());
  statsEl.textContent =
    `${model.name}: ${sx}×${sy}×${sz}, ${state.count} × ${state.view}\n` +
    `Frame ${(volumes[0]?.frame ?? 0) + 1} of ${animation.frames.length}, ${animation.volumes.length} distinct poses\n` +
    `Frame interval ${average(frameTimes).toFixed(2)} ms\n` +
    (timer ? `GPU ${average(gpuTimes).toFixed(2)} ms` : "GPU timer unavailable") +
    ` at ${size.x}×${size.y}`;
}, 500);

// Image diff: render both scenes alone, without MSAA, and compare pixels.
function renderToPixels(scene: Scene, width: number, height: number) {
  const target = new WebGLRenderTarget(width, height, { minFilter: NearestFilter, magFilter: NearestFilter });
  // A render target uses its own full-size viewport; setViewport would scale by the pixel ratio.
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  const pixels = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  renderer.setRenderTarget(null);
  target.dispose();
  return pixels;
}

function diff(tolerance = 3) {
  const width = Math.floor(viewportWidth()), height = canvas.clientHeight;
  const a = renderToPixels(meshScene, width, height);
  const b = renderToPixels(volumeScene, width, height);
  const out = document.querySelector<HTMLCanvasElement>("#diff")!;
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d")!;
  const image = ctx.createImageData(width, height);
  let differ = 0, covered = 0, max = 0, volumeDarker = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (x + y * width) * 4;
      const o = (x + (height - 1 - y) * width) * 4; // render targets are bottom-up
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      const background = a[i] === 0xf4 && a[i + 1] === 0xf5 && a[i + 2] === 0xf7;
      if (!background) covered++;
      max = Math.max(max, d);
      const bad = d > tolerance;
      if (bad) differ++;
      if (bad && b[i] + b[i + 1] + b[i + 2] < a[i] + a[i + 1] + a[i + 2]) volumeDarker++;
      image.data[o] = bad ? 255 : a[i] * 0.25;
      image.data[o + 1] = bad ? 0 : a[i + 1] * 0.25;
      image.data[o + 2] = bad ? 0 : a[i + 2] * 0.25;
      image.data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  out.style.display = "block";
  const result = { width, height, covered, differ, volumeDarker, percent: (100 * differ) / Math.max(1, covered), max, tolerance };
  document.querySelector("#result")!.textContent =
    `${differ} of ${covered} covered pixels differ by more than ${tolerance} (${result.percent.toFixed(3)}%), largest difference ${max}`;
  return result;
}
document.querySelector<HTMLCanvasElement>("#diff")!.addEventListener("click", (e) => {
  (e.currentTarget as HTMLElement).style.display = "none";
});

// Tap a voxel to remove it, in every copy and in the mesh.
const raycaster = new Raycaster();
let down: { x: number; y: number } | null = null;
canvas.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
canvas.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
  down = null;
  // Both halves show the same voxels in the same place, so either side picks through the volumes.
  const width = viewportWidth();
  const local = e.clientX % width;
  const ndc = new Vector2((local / width) * 2 - 1, -(e.clientY / canvas.clientHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const [hit] = raycaster.intersectObjects(volumes, false) as VoxelIntersection[];
  if (!hit) return;
  const [x, y, z] = hit.voxel.cell;
  for (const v of volumes) {
    v.setVoxel(x, y, z, 0);
    v.flash([x, y, z], { color: 0xfff2c0, radius: 4 });
  }
  // Keep the source in step, so new copies and the mesh see the edit. It hits the shared pose.
  const pose = volumes[0].frames[volumes[0].frame].volume;
  const { size, offset, data } = animation.volumes[pose];
  data[x - offset[0] + size[0] * (y - offset[1] + size[1] * (z - offset[2]))] = 0;
  rebuildMesh(pose);
});

// Effects
function applyEffects() {
  const dissolve = Number(document.querySelector<HTMLInputElement>("#dissolve")!.value);
  const cut = Number(document.querySelector<HTMLInputElement>("#cutaway")!.value);
  // Cut from the camera's side of the model: hide x above a level that the slider moves.
  const plane = cut < 1 ? new Plane(new Vector3(1, 0, 0), -(cut * sx)) : null;
  for (const v of volumes) {
    v.dissolve = dissolve;
    v.clipPlane = plane;
    v.setEmission(state.glowIndex, state.glow ? 1 : 0);
    v.emissiveIntensity = 3;
  }
}
for (const id of ["#dissolve", "#cutaway"]) document.querySelector(id)!.addEventListener("input", applyEffects);

/**
 * Render the volumes alone and cast a ray through every 4th pixel: a pixel should be covered
 * exactly where the CPU raycast hits a voxel. Checks that the CPU's hidden cells match the GPU's.
 */
function checkPicking(step = 4) {
  const hiddenProps = props.flat();
  for (const m of hiddenProps) m.visible = false;
  const width = Math.floor(viewportWidth()), height = canvas.clientHeight;
  const pixels = renderToPixels(volumeScene, width, height);
  for (const m of hiddenProps) m.visible = true;
  let checked = 0, covered = 0, mismatched = 0;
  for (let y = step / 2; y < height; y += step) {
    for (let x = step / 2; x < width; x += step) {
      const i = (Math.floor(x) + Math.floor(height - 1 - y) * width) * 4;
      const drawn = !(pixels[i] === 0xf4 && pixels[i + 1] === 0xf5 && pixels[i + 2] === 0xf7);
      raycaster.setFromCamera(new Vector2(((x + 0.5) / width) * 2 - 1, -((y + 0.5) / height) * 2 + 1), camera);
      const hit = raycaster.intersectObjects(volumes, false).length > 0;
      checked++;
      if (drawn) covered++;
      if (drawn !== hit) mismatched++;
    }
  }
  const result = { checked, covered, mismatched, percent: (100 * mismatched) / Math.max(1, covered) };
  document.querySelector("#result")!.textContent =
    `Picking: ${mismatched} of ${covered} covered samples disagree with the drawing (${result.percent.toFixed(3)}%)`;
  return result;
}

// Controls
function buttons<T extends string | number | boolean>(
  selector: string,
  options: [label: string, value: T][],
  get: () => T,
  set: (value: T) => void,
) {
  const host = document.querySelector(selector)!;
  const els = options.map(([label, value]) => {
    const button = document.createElement("button");
    button.textContent = label;
    button.addEventListener("click", () => {
      set(value);
      update();
    });
    host.append(button);
    return { button, value };
  });
  const update = () => els.forEach(({ button, value }) => button.setAttribute("aria-pressed", String(get() === value)));
  update();
}

function toggle(selector: string, label: string, get: () => boolean, set: (on: boolean) => void) {
  const button = document.createElement("button");
  button.textContent = label;
  const update = () => button.setAttribute("aria-pressed", String(get()));
  button.addEventListener("click", () => {
    set(!get());
    update();
  });
  document.querySelector(selector)!.append(button);
  update();
}

buttons("#view-buttons", [["Split", "split"], ["Mesh", "mesh"], ["Volume", "volume"]], () => state.view, (v) => {
  state.view = v;
  resize();
});
buttons("#camera-buttons", [["Perspective", false], ["Orthographic", true]], () => state.ortho, setCamera);
buttons("#count-buttons", [["1", 1], ["10", 10], ["50", 50]], () => state.count, (n) => {
  state.count = n;
  rebuild();
});
buttons("#lighting-buttons", [["Flat", "flat"], ["Lit", "lit"]], () => state.lighting, (mode) => {
  state.lighting = mode;
  applyLighting();
});
buttons("#light-buttons", [["Sun", "sun"], ["Spot", "spot"], ["Lamp", "lamp"]], () => state.light, (kind) => {
  state.light = kind;
  applyLighting();
});
toggle("#shading-buttons", "Faces", () => state.shade, (on) => {
  state.shade = on;
  for (const v of volumes) v.shade = on;
  rebuildMesh();
});
toggle("#shading-buttons", "AO", () => state.ao, (on) => {
  state.ao = on;
  for (const v of volumes) v.ao = on;
  rebuildMesh();
});
document.querySelector("#diff-button")!.addEventListener("click", () => diff());
document.querySelector("#pick-button")!.addEventListener("click", () => checkPicking());
toggle("#glow-buttons", "Glow", () => state.glow, (on) => {
  state.glow = on;
  applyEffects();
});
toggle("#animation-buttons", "Play", () => state.playing, (on) => {
  state.playing = on;
  for (const v of volumes) (on ? v.play() : v.pause());
});
buttons("#animation-buttons", [["◀", -1], ["▶", 1]], () => 0, (step) => {
  const n = animation.frames.length;
  for (const v of volumes) v.frame = (v.frame + step + n) % n;
});

rebuild();
applyLighting();
resize();

// For scripted checks from the console.
Object.assign(window, {
  voxelDev: { diff, checkPicking, applyEffects, renderToPixels, volumeScene, state, volumes: () => volumes, meshes: () => meshes, lights, camera: () => camera, controls: () => controls },
});
