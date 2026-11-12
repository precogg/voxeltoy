// A small game on VoxelVolume (docs/voxel-runtime.md, stage 3): animated critters walk around an
// arena; tap one to blast voxels out of it. Hits carve every pose, throw the voxels as debris and
// flash; enough damage dissolves a critter, and it dissolves back in elsewhere. Eyes glow.
// Open /dev/voxel-game.html with `pnpm dev:app`. Not part of the build.
import {
  AmbientLight,
  BoxGeometry,
  Clock,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  Fog,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Vec3 } from "@voxeltoy/core/types";
import { VoxelVolume, type VoxelIntersection } from "@voxeltoy/three/voxel-volume";
import { ANTENNA, critter, CRITTER_PALETTE as PALETTE, EYE } from "./samples";

const ANIMATION = critter();
const [SX, , SZ] = ANIMATION.size;
const CRITTERS = 8;
const DEBRIS = 3000;

const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.shadowMap.enabled = true;
const scene = new Scene();
scene.background = new Color(0xb9d3e8);
scene.fog = new Fog(0xb9d3e8, 180, 360);
const camera = new PerspectiveCamera(45, 1, 1, 1000);
camera.position.set(0, 120, 170);
camera.lookAt(0, 0, 10);

const sun = new DirectionalLight(0xffffff, 2.4);
sun.position.set(60, 140, 80);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -130, right: 130, top: 130, bottom: -130, near: 1, far: 400 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.05;
scene.add(sun, new AmbientLight(0xffffff, 0.7));

const ground = new Mesh(new PlaneGeometry(600, 600), new MeshStandardMaterial({ color: 0xd9c9a3, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Critters
interface Critter {
  volume: VoxelVolume;
  angle: number;
  radius: number;
  speed: number;
  solid: number;
  state: "alive" | "dying" | "spawning";
  t: number;
}

function countVoxels(v: VoxelVolume) {
  // the body is the same in every pose; count the pose on show
  let n = 0;
  for (const b of v.volume.data) if (b !== 0) n++;
  return n;
}

const critters: Critter[] = [];
for (let i = 0; i < CRITTERS; i++) {
  const volume = VoxelVolume.fromAnimation(ANIMATION, { lighting: "lit" });
  volume.castShadow = volume.receiveShadow = true;
  volume.setEmission(EYE, 1);
  volume.setEmission(ANTENNA, 1);
  volume.emissiveIntensity = 1.5;
  volume.time = Math.random() * 500;
  volume.play();
  scene.add(volume);
  critters.push({
    volume,
    angle: (i / CRITTERS) * Math.PI * 2,
    radius: 30 + (i % 3) * 22,
    speed: (0.25 + Math.random() * 0.2) * (i % 2 ? 1 : -1),
    solid: countVoxels(volume),
    state: "alive",
    t: 0,
  });
}

/** Place a critter on its circle, facing the way it walks. Its origin is its grid corner. */
const _q = new Quaternion();
const _up = new Vector3(0, 1, 0);
function place(c: Critter) {
  const x = Math.cos(c.angle) * c.radius, z = Math.sin(c.angle) * c.radius;
  // Face along the walk. Turning by θ about Y takes the grid's front (+z) to (sin θ, 0, cos θ).
  const tx = -Math.sin(c.angle) * Math.sign(c.speed), tz = Math.cos(c.angle) * Math.sign(c.speed);
  _q.setFromAxisAngle(_up, Math.atan2(tx, tz));
  c.volume.quaternion.copy(_q);
  // center the grid on (x, z): offset by half the grid, turned with the critter
  const center = new Vector3(SX / 2, 0, SZ / 2).applyQuaternion(_q);
  c.volume.position.set(x - center.x, 0, z - center.z);
}

// Debris: one instanced cube per flying voxel.
const debrisMesh = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ roughness: 1 }), DEBRIS);
debrisMesh.instanceMatrix.setUsage(DynamicDrawUsage);
debrisMesh.castShadow = true;
debrisMesh.count = 0;
scene.add(debrisMesh);
interface Piece {
  p: Vector3;
  v: Vector3;
  spin: Vector3;
  rot: Quaternion;
  life: number;
  color: Color;
}
let pieces: Piece[] = [];
const _m = new Matrix4();
const _s = new Vector3();

function spawnDebris(volume: VoxelVolume, center: Vec3, radius: number, hitNormalWorld: Vector3) {
  const r2 = radius * radius;
  const origin = volume.localToWorld(new Vector3(...center));
  for (let z = Math.floor(center[2] - radius); z <= center[2] + radius; z++)
    for (let y = Math.floor(center[1] - radius); y <= center[1] + radius; y++)
      for (let x = Math.floor(center[0] - radius); x <= center[0] + radius; x++) {
        if ((x + 0.5 - center[0]) ** 2 + (y + 0.5 - center[1]) ** 2 + (z + 0.5 - center[2]) ** 2 > r2) continue;
        const value = volume.getVoxel(x, y, z);
        if (!value || pieces.length >= DEBRIS) continue;
        const p = volume.localToWorld(new Vector3(x + 0.5, y + 0.5, z + 0.5));
        const out = p.clone().sub(origin).normalize().add(hitNormalWorld).normalize();
        pieces.push({
          p,
          v: out.multiplyScalar(25 + Math.random() * 25).add(new Vector3(0, 20 + Math.random() * 15, 0)),
          spin: new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(12),
          rot: new Quaternion(),
          life: 1.6 + Math.random() * 0.8,
          color: new Color(PALETTE[value]),
        });
      }
}

function updateDebris(dt: number) {
  const _e = new Quaternion();
  pieces = pieces.filter((d) => (d.life -= dt) > 0);
  for (const [i, d] of pieces.entries()) {
    d.v.y -= 90 * dt;
    d.p.addScaledVector(d.v, dt);
    if (d.p.y < 0.5) {
      d.p.y = 0.5;
      d.v.y *= -0.35;
      d.v.x *= 0.7;
      d.v.z *= 0.7;
      d.spin.multiplyScalar(0.7);
    }
    _e.setFromAxisAngle(_s.copy(d.spin).normalize(), d.spin.length() * dt);
    d.rot.premultiply(_e);
    const scale = Math.min(1, d.life * 2);
    debrisMesh.setMatrixAt(i, _m.compose(d.p, d.rot, _s.set(scale, scale, scale)));
    debrisMesh.setColorAt(i, d.color);
  }
  debrisMesh.count = pieces.length;
  debrisMesh.instanceMatrix.needsUpdate = true;
  if (debrisMesh.instanceColor) debrisMesh.instanceColor.needsUpdate = true;
}

// Shooting
let score = 0, shots = 0;
const raycaster = new Raycaster();
canvas.addEventListener("pointerdown", (e) => {
  const rect = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
  shots++;
  const live = critters.filter((c) => c.state === "alive").map((c) => c.volume);
  const [hit] = raycaster.intersectObjects(live, false) as VoxelIntersection[];
  if (!hit) return;
  const c = critters.find((c) => c.volume === hit.object)!;
  const cell = hit.voxel.cell;
  const center: Vec3 = [cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5];
  const normal = hit.face!.normal.clone().transformDirection(c.volume.matrixWorld);
  spawnDebris(c.volume, center, 3.2, normal);
  c.volume.fillSphere(center, 3.2, 0, { allFrames: true });
  c.volume.flash(cell, { color: 0xffe9a8, radius: 6, duration: 0.3 });
  score++;
  if (countVoxels(c.volume) < c.solid * 0.6) {
    c.state = "dying";
    c.t = 0;
  }
});

// Loop
const clock = new Clock();
const hud = document.querySelector<HTMLElement>("#hud")!;
const frameTimes: number[] = [];
let respawns = 0;

function resize() {
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());
  frameTimes.push(dt * 1000);
  if (frameTimes.length > 120) frameTimes.shift();
  for (const c of critters) {
    c.volume.update(dt);
    if (c.state === "alive") c.angle += (c.speed * dt * 60) / c.radius;
    if (c.state === "dying") {
      c.t += dt;
      c.volume.dissolve = c.t / 0.8;
      if (c.t >= 0.8) {
        // back as new, somewhere else, dissolving in
        c.volume.setAnimation(ANIMATION);
        c.volume.play();
        c.angle = Math.random() * Math.PI * 2;
        c.state = "spawning";
        c.t = 0;
        respawns++;
      }
    } else if (c.state === "spawning") {
      c.t += dt;
      c.volume.dissolve = 1 - c.t / 0.8;
      if (c.t >= 0.8) {
        c.volume.dissolve = 0;
        c.state = "alive";
      }
    }
    place(c);
  }
  updateDebris(dt);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

setInterval(() => {
  const ms = frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, frameTimes.length);
  hud.textContent =
    `Tap a critter to blast it\n` +
    `Hits ${score} of ${shots} · knocked out ${respawns}\n` +
    `${CRITTERS} critters, ${pieces.length} debris · ${ms.toFixed(1)} ms a frame`;
}, 250);

// For scripted checks from the console.
Object.assign(window, { voxelGame: { critters, camera, canvas, pieces: () => pieces } });
