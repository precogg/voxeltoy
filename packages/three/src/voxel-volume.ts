import {
  BackSide,
  BoxGeometry,
  Color,
  ColorManagement,
  Data3DTexture,
  DataTexture,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  NoColorSpace,
  Plane,
  Ray,
  RedFormat,
  RGBAFormat,
  ShaderChunk,
  ShaderMaterial,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
  Vector4,
  type ColorRepresentation,
  type Intersection,
  type IUniform,
  type Object3DEventMap,
  type Raycaster,
  type WebGLProgramParametersWithUniforms,
} from "three";
import { frameAt, frameStart, ticksToMs, totalTicks } from "@voxeltoy/core/animation";
import { readVolumes, readVolumesZip, type PlacedVolume, type VoxelAnimation } from "@voxeltoy/core/formats/volumes";
import { raycastVolume } from "@voxeltoy/core/raycast";
import type { Vec3 } from "@voxeltoy/core/types";

/**
 * Draws a voxel volume without a mesh: a box whose fragment shader walks the grid along each
 * pixel's ray (Amanatides & Woo) and writes the depth of the voxel it hits. See
 * docs/voxel-runtime.md.
 *
 * Local space is cell space, as in the mesher: cell [x, y, z] spans x to x + 1 on each axis.
 */
export interface VoxelVolumeOptions {
  /**
   * `flat` (default): unlit, shaded like the editor viewport. `lit`: three.js lights and shadows,
   * through a `MeshStandardMaterial` that `material` then returns.
   */
  lighting?: VoxelLighting;
  /** Directional face shading in `flat` lighting, as the editor viewport draws it. Default true. */
  shade?: boolean;
  /**
   * Ambient occlusion from neighboring voxels, by the mesher's rule. Default true. In `lit`
   * lighting it darkens indirect light only.
   */
  ao?: boolean;
}

export type VoxelLighting = "flat" | "lit";

export interface VoxelFlashOptions {
  /** Default white. */
  color?: ColorRepresentation;
  /** In voxels, from the center of the hit cell. Default 3. */
  radius?: number;
  /** Seconds to fade out, as `update` is called. Default 0.25. */
  duration?: number;
}

export interface VoxelFillOptions {
  /**
   * Change every pose of an animation, not only the one on show. The same grid cells change in
   * each, so this suits parts that hold still, such as a body whose legs move.
   */
  allFrames?: boolean;
}

/**
 * The shader's random number for a cell of the document grid, in [0, 1) in steps of 1/65536.
 * Dissolve hides a cell when this is below `dissolve`.
 */
export function voxelHash(x: number, y: number, z: number): number {
  const h = Math.imul((Math.imul(x, 1597334673) ^ Math.imul(y, 3812015801 | 0) ^ Math.imul(z, 2798796415 | 0)) >>> 0, 1597334677) >>> 0;
  return (h >>> 16) / 65536;
}

export interface VoxelHit {
  cell: Vec3;
  /** Outward normal of the face that was hit, in cell space. */
  normal: Vec3;
  /** Palette index. */
  value: number;
}

export interface VoxelIntersection extends Intersection<VoxelVolume> {
  voxel: VoxelHit;
}

/** The ray toward each box vertex, in cell space, for the fragment shader to march. */
const vertexPars = /* glsl */ `
uniform vec3 uOffset;
varying vec3 vVoxelLocal;
varying vec3 vVoxelCamera;
varying vec3 vVoxelViewDir;
`;

const vertexMain = /* glsl */ `
{
  mat4 voxelToLocal = inverse(modelMatrix);
  // Cell space of the volume on show, which sits at uOffset in the document grid.
  vVoxelLocal = position - uOffset;
  vVoxelCamera = (voxelToLocal * vec4(cameraPosition, 1.0)).xyz - uOffset;
  // The camera looks down its -Z axis: row 2 of the view matrix, negated.
  vec3 forward = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vVoxelViewDir = (voxelToLocal * vec4(forward, 0.0)).xyz;
}
`;

const fragmentPars = /* glsl */ `
uniform sampler3D uVolume;
uniform sampler2D uPalette;
uniform vec3 uSize;
uniform vec3 uOffset;
uniform bool uShade;
uniform bool uAO;
// Effects; see the VoxelVolume properties of the same names.
uniform float uDissolve;
uniform float uDissolveEdge;
uniform vec3 uDissolveColor;
uniform bool uClipEnabled;
uniform vec4 uClip;
uniform vec3 uFlashCenter;
uniform float uFlashRadius;
uniform vec3 uFlashColor;
uniform float uFlashAmount;
uniform float uEmissiveIntensity;
// Vertex-only in three.js unless a feature already declares them.
#ifndef USE_TRANSMISSION
uniform mat4 modelMatrix;
uniform mat4 projectionMatrix;
#endif
#ifndef USE_NORMALMAP_OBJECTSPACE
uniform mat3 normalMatrix;
#endif
#if defined(USE_LOGARITHMIC_DEPTH_BUFFER) && !defined(VOXEL_LIT)
uniform float logDepthBufFC;
#endif

varying vec3 vVoxelLocal;
varying vec3 vVoxelCamera;
varying vec3 vVoxelViewDir;

struct VoxelHit {
  int value;
  ivec3 cell;
  int axis;
  vec3 normal;   // outward, cell space
  vec3 position; // cell space
};

int voxelAt(ivec3 c) {
  return int(texelFetch(uVolume, c, 0).r * 255.0 + 0.5);
}

// A stable random number in [0, 1) for a cell of the document grid, in steps of 1/65536.
// voxelHash in voxel-volume.ts computes the same.
float voxelHash(ivec3 c) {
  uvec3 v = uvec3(c + ivec3(uOffset)) * uvec3(1597334673u, 3812015801u, 2798796415u);
  uint h = (v.x ^ v.y ^ v.z) * 1597334677u;
  return float(h >> 16u) / 65536.0;
}

// Whether a cell is cut away or dissolved: drawn, shadowed and occluded as if empty.
bool voxelHidden(ivec3 c) {
  if (uDissolve > 0.0 && voxelHash(c) < uDissolve) return true;
  return uClipEnabled && dot(uClip.xyz, vec3(c) + 0.5 + uOffset) + uClip.w > 0.0;
}

int voxelShown(ivec3 c) {
  int v = voxelAt(c);
  return v != 0 && voxelHidden(c) ? 0 : v;
}

float voxelSolid(ivec3 c, ivec3 size) {
  if (any(lessThan(c, ivec3(0))) || any(greaterThanEqual(c, size))) return 0.0;
  return voxelShown(c) != 0 ? 1.0 : 0.0;
}

// The first solid voxel along the ray. With throughSolid, hit.position is instead where the ray
// leaves that run of solid voxels: the nearest back face, which is what three.js stores in shadow
// maps for front-sided meshes, so lit faces never shadow themselves.
bool voxelMarch(bool throughSolid, out VoxelHit hit) {
  ivec3 size = ivec3(uSize + 0.5);

  // The ray in cell space. An orthographic ray starts on the camera plane.
  vec3 rd, ro;
  if (isOrthographic) {
    rd = normalize(vVoxelViewDir);
    ro = vVoxelLocal - rd * dot(vVoxelLocal - vVoxelCamera, rd);
  } else {
    ro = vVoxelCamera;
    rd = normalize(vVoxelLocal - vVoxelCamera);
  }
  rd = vec3(
    abs(rd.x) < 1e-6 ? 1e-6 : rd.x,
    abs(rd.y) < 1e-6 ? 1e-6 : rd.y,
    abs(rd.z) < 1e-6 ? 1e-6 : rd.z
  );
  vec3 inv = 1.0 / rd;

  // Clip the ray to the box.
  vec3 t0 = -ro * inv;
  vec3 t1 = (uSize - ro) * inv;
  vec3 tNear = min(t0, t1);
  vec3 tFar = max(t0, t1);
  float tEnter = max(max(tNear.x, tNear.y), tNear.z);
  float tExit = min(min(tFar.x, tFar.y), tFar.z);
  float t = max(tEnter, 0.0);
  if (tExit <= t) return false;
  int axis = tEnter < 0.0 ? -1 : tEnter == tNear.x ? 0 : tEnter == tNear.y ? 1 : 2;

  ivec3 cell = clamp(ivec3(floor(ro + rd * (t + 1e-4))), ivec3(0), size - 1);
  ivec3 stp = ivec3(sign(rd));
  vec3 tDelta = abs(inv);
  vec3 tMax = (vec3(cell) + max(vec3(stp), 0.0) - ro) * inv;

  // A ray crosses at most sx + sy + sz cells.
  int value = 0;
  ivec3 hitCell = cell;
  int hitAxis = axis;
  float hitT = t;
  int steps = size.x + size.y + size.z + 3;
  for (int i = 0; i < steps; i++) {
    int v = voxelShown(cell);
    if (value == 0) {
      if (v != 0) {
        value = v;
        hitCell = cell;
        hitAxis = axis;
        hitT = t;
        if (!throughSolid) break;
      }
    } else if (v == 0) {
      break;
    }
    if (tMax.x < tMax.y && tMax.x < tMax.z) {
      cell.x += stp.x; t = tMax.x; tMax.x += tDelta.x; axis = 0;
      if (cell.x < 0 || cell.x >= size.x) break;
    } else if (tMax.y < tMax.z) {
      cell.y += stp.y; t = tMax.y; tMax.y += tDelta.y; axis = 1;
      if (cell.y < 0 || cell.y >= size.y) break;
    } else {
      cell.z += stp.z; t = tMax.z; tMax.z += tDelta.z; axis = 2;
      if (cell.z < 0 || cell.z >= size.z) break;
    }
  }
  if (value == 0) return false;

  // Started inside a solid cell: face the camera along the dominant axis, as core's raycast does.
  if (hitAxis < 0) {
    vec3 a = abs(rd);
    hitAxis = a.x >= a.y && a.x >= a.z ? 0 : a.y >= a.z ? 1 : 2;
  }
  hit.value = value;
  hit.cell = hitCell;
  hit.axis = hitAxis;
  hit.normal = vec3(0.0);
  hit.normal[hitAxis] = -float(stp[hitAxis]);
  hit.position = ro + rd * (throughSolid ? t : hitT);
  return true;
}

// A cell-space point in the object's local space.
vec4 voxelModelPosition(vec3 p) {
  return vec4(p + uOffset, 1.0);
}

// The depth buffer value at a cell-space point, or -1 outside the clip range (a mesh would be
// clipped there too).
float voxelFragDepth(vec3 p) {
  vec4 clip = projectionMatrix * viewMatrix * modelMatrix * voxelModelPosition(p);
  float ndc = clip.z / clip.w;
#if defined(USE_LOGARITHMIC_DEPTH_BUFFER)
  return isOrthographic ? ndc * 0.5 + 0.5 : log2(1.0 + clip.w) * logDepthBufFC * 0.5;
#elif defined(USE_REVERSED_DEPTH_BUFFER)
  return ndc < 0.0 || ndc > 1.0 ? -1.0 : ndc;
#else
  return ndc < -1.0 || ndc > 1.0 ? -1.0 : ndc * 0.5 + 0.5;
#endif
}

vec3 voxelColor(int value) {
  return texelFetch(uPalette, ivec2(value, 0), 0).rgb;
}

// How much a palette entry glows, 0 to 1: the palette texture's alpha.
float voxelEmission(int value) {
  return texelFetch(uPalette, ivec2(value, 0), 0).a;
}

// Light a hit gives off besides its color: the dissolve edge, then a hit flash. .a is how much it
// replaces the voxel's own color.
vec4 voxelGlow(VoxelHit hit) {
  vec4 glow = vec4(0.0);
  if (uDissolve > 0.0 && voxelHash(hit.cell) < uDissolve + uDissolveEdge) glow = vec4(uDissolveColor, 1.0);
  if (uFlashAmount > 0.0) {
    float d = distance(vec3(hit.cell) + 0.5 + uOffset, uFlashCenter);
    float k = uFlashAmount * clamp(1.0 - d / max(uFlashRadius, 1e-3), 0.0, 1.0);
    glow = vec4(mix(glow.rgb, uFlashColor, k), max(glow.a, k));
  }
  return glow;
}

// Face order: -x, +x, -y, +y, -z, +z (the mesher's FACE_SHADE).
const float VOXEL_FACE_SHADE[6] = float[6](0.78, 0.86, 0.6, 1.0, 0.7, 0.92);

float voxelFaceShade(VoxelHit hit) {
  return VOXEL_FACE_SHADE[hit.axis * 2 + (hit.normal[hit.axis] > 0.0 ? 1 : 0)];
}

// The mesher's vertexAO and AO_SHADE.
float voxelCornerAO(float side1, float side2, float corner) {
  float n = side1 > 0.5 && side2 > 0.5 ? 3.0 : side1 + side2 + corner;
  return n < 0.5 ? 1.0 : n < 1.5 ? 0.87 : n < 2.5 ? 0.77 : 0.66;
}

// The mesher's corners in (u, v): (0,0), (1,0), (1,1), (0,1), blended across the face.
float voxelAO(VoxelHit hit) {
  ivec3 size = ivec3(uSize + 0.5);
  ivec3 n = hit.cell + ivec3(hit.normal);
  ivec3 u = hit.axis == 0 ? ivec3(0, 1, 0) : hit.axis == 1 ? ivec3(0, 0, 1) : ivec3(1, 0, 0);
  ivec3 v = hit.axis == 0 ? ivec3(0, 0, 1) : hit.axis == 1 ? ivec3(1, 0, 0) : ivec3(0, 1, 0);
  float uMinus = voxelSolid(n - u, size), uPlus = voxelSolid(n + u, size);
  float vMinus = voxelSolid(n - v, size), vPlus = voxelSolid(n + v, size);
  float a0 = voxelCornerAO(uMinus, vMinus, voxelSolid(n - u - v, size));
  float a1 = voxelCornerAO(uPlus, vMinus, voxelSolid(n + u - v, size));
  float a2 = voxelCornerAO(uPlus, vPlus, voxelSolid(n + u + v, size));
  float a3 = voxelCornerAO(uMinus, vPlus, voxelSolid(n - u + v, size));
  vec3 inCell = clamp(hit.position - vec3(hit.cell), 0.0, 1.0);
  float fu = dot(inCell, vec3(u));
  float fv = dot(inCell, vec3(v));
  return mix(mix(a0, a1, fu), mix(a3, a2, fu), fv);
}
`;

const flatVertexShader = /* glsl */ `
${vertexPars}
void main() {
  ${vertexMain}
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const flatFragmentShader = /* glsl */ `
${fragmentPars}
void main() {
  VoxelHit hit;
  if (!voxelMarch(false, hit)) discard;
  float depth = voxelFragDepth(hit.position);
  if (depth < 0.0) discard;
  gl_FragDepth = depth;

  float f = 1.0;
  if (uShade) f = voxelFaceShade(hit);
  if (uAO) f *= voxelAO(hit);
  // Glowing palette entries ignore shading; flat lighting has nothing brighter to give them.
  f = mix(f, 1.0, voxelEmission(hit.value));
  vec4 glow = voxelGlow(hit);
  gl_FragColor = vec4(mix(voxelColor(hit.value) * f, glow.rgb, glow.a), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Shadow maps are depth textures for every light type, so only the depth matters. */
const depthFragmentShader = /* glsl */ `
${fragmentPars}
void main() {
  VoxelHit hit;
  if (!voxelMarch(true, hit)) discard;
  float depth = voxelFragDepth(hit.position);
  if (depth < 0.0) discard;
  gl_FragDepth = depth;
  gl_FragColor = vec4(1.0);
}
`;

// three.js computes shadow-map coordinates per vertex, from the box. The lit material recomputes
// them per fragment from the hit, with three's own chunk, into arrays that stand in for the varyings.
const shadowCoordPars = /* glsl */ `
#if NUM_SPOT_LIGHT_COORDS > 0
  uniform mat4 spotLightMatrix[ NUM_SPOT_LIGHT_COORDS ];
  vec4 voxelSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
  #define vSpotLightCoord voxelSpotLightCoord
#endif
#ifdef USE_SHADOWMAP
  #if NUM_DIR_LIGHT_SHADOWS > 0
    uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
    vec4 voxelDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
    #define vDirectionalShadowCoord voxelDirectionalShadowCoord
  #endif
  #if NUM_POINT_LIGHT_SHADOWS > 0
    uniform mat4 pointShadowMatrix[ NUM_POINT_LIGHT_SHADOWS ];
    vec4 voxelPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
    #define vPointShadowCoord voxelPointShadowCoord
  #endif
#endif
`;

const shadowCoordMain = ShaderChunk.shadowmap_vertex
  .replace("inverseTransformDirection( transformedNormal, viewMatrix )", "voxelWorldNormal")
  .replace(/\bworldPosition\b/g, "voxelWorldPosition");

const litMarch = /* glsl */ `
  VoxelHit voxelHit;
  if (!voxelMarch(false, voxelHit)) discard;
  float voxelDepth = voxelFragDepth(voxelHit.position);
  if (voxelDepth < 0.0) discard;
  gl_FragDepth = voxelDepth;
  voxelViewPosition = -(viewMatrix * modelMatrix * voxelModelPosition(voxelHit.position)).xyz;
  vec3 voxelNormalView = normalize(normalMatrix * voxelHit.normal);
  float voxelOcclusion = uAO ? voxelAO(voxelHit) : 1.0;
#if defined( USE_SHADOWMAP ) || ( NUM_SPOT_LIGHT_COORDS > 0 )
  {
    vec4 voxelWorldPosition = modelMatrix * voxelModelPosition(voxelHit.position);
    vec3 voxelWorldNormal = inverseTransformDirection(voxelNormalView, viewMatrix);
    ${shadowCoordMain}
  }
#endif
  vec3 voxelBase = voxelColor(voxelHit.value);
  vec4 voxelGlowing = voxelGlow(voxelHit);
  vec3 voxelEmissive = voxelBase * voxelEmission(voxelHit.value) * uEmissiveIntensity + voxelGlowing.rgb * voxelGlowing.a;
  vec4 diffuseColor = vec4( diffuse * voxelBase * (1.0 - voxelGlowing.a), opacity );
`;

function patch(source: string, search: string, replacement: string) {
  if (!source.includes(search)) throw new Error(`VoxelVolume: three.js shader has no "${search}"`);
  return source.replace(search, replacement);
}

/** `MeshStandardMaterial` lighting at the voxel each ray hits. Its color multiplies the palette. */
export class VoxelStandardMaterial extends MeshStandardMaterial {
  readonly isVoxelStandardMaterial = true;

  constructor(private readonly voxelUniforms: Record<string, IUniform>) {
    super({ roughness: 1, metalness: 0, side: BackSide });
    this.shadowSide = BackSide;
    this.defines = { ...this.defines, VOXEL_LIT: "" };
  }

  override onBeforeCompile(shader: WebGLProgramParametersWithUniforms) {
    Object.assign(shader.uniforms, this.voxelUniforms);
    let v = shader.vertexShader;
    v = patch(v, "#include <common>", `#include <common>\n${vertexPars}`);
    v = patch(v, "#include <fog_vertex>", `#include <fog_vertex>\n${vertexMain}`);
    shader.vertexShader = v;

    let f = shader.fragmentShader;
    // Lighting reads the surface position from vViewPosition: make it the hit's.
    f = patch(
      f,
      "varying vec3 vViewPosition;",
      "varying vec3 vViewPosition;\nvec3 voxelViewPosition;\n#define vViewPosition voxelViewPosition",
    );
    f = patch(f, "#include <shadowmap_pars_fragment>", `#include <shadowmap_pars_fragment>\n${shadowCoordPars}`);
    f = patch(f, "#include <clipping_planes_pars_fragment>", `#include <clipping_planes_pars_fragment>\n${fragmentPars}`);
    f = patch(f, "vec4 diffuseColor = vec4( diffuse, opacity );", litMarch);
    f = patch(f, "#include <logdepthbuf_fragment>", "");
    f = patch(f, "vec3 totalEmissiveRadiance = emissive;", "vec3 totalEmissiveRadiance = emissive + voxelEmissive;");
    f = patch(
      f,
      "#include <normal_fragment_begin>",
      "float faceDirection = 1.0;\nvec3 normal = voxelNormalView;\nvec3 nonPerturbedNormal = normal;",
    );
    f = patch(
      f,
      "#include <aomap_fragment>",
      "#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= voxelOcclusion;\nreflectedLight.indirectSpecular *= voxelOcclusion;",
    );
    shader.fragmentShader = f;
  }

  override customProgramCacheKey() {
    return "voxel-volume-lit";
  }
}

/**
 * The box is drawn this much (in voxels) larger than the volume on each side; the march still
 * clips rays to the volume. A camera exactly in the plane of a face puts that face's vertices at
 * w = 0, where some rasterizers interpolate varyings badly; an odd margin makes that unlikely.
 */
export const BOX_MARGIN = 0.0137;

const _inverse = new Matrix4();
const _ray = new Ray();
const _point = new Vector3();
const _cellCenter = new Vector3();

export interface VoxelVolumeEventMap extends Object3DEventMap {
  /** A different frame is showing, during playback or after setting `frame`. */
  frame: { frame: number };
  /** Playback without `loop` reached the end of the last frame. */
  finished: object;
}

/** A volume with its GPU texture and box. */
interface ShownVolume extends PlacedVolume {
  texture: Data3DTexture;
  geometry: BoxGeometry;
}

/**
 * One volume, or an animation of them (see `fromAnimation`). Coordinates in `getVoxel`, `setVoxel`
 * and `raycast` are in the document grid; the object's origin is the grid's corner, cell space.
 */
export class VoxelVolume extends Mesh<BoxGeometry, ShaderMaterial | VoxelStandardMaterial, VoxelVolumeEventMap> {
  readonly isVoxelVolume = true;
  /** Playback speed: 2 plays twice as fast. */
  speed = 1;
  /** Wrap around after the last frame, rather than stop on it. */
  loop = true;
  private _grid: Vec3 = [1, 1, 1];
  private _fps = 12;
  private _frames: { id: string; duration: number; volume: number }[] = [];
  private _frame = 0;
  private _time = 0;
  private _playing = false;
  private _lighting: VoxelLighting = "flat";
  private _clipPlane: Plane | null = null;
  private flashFade = 0;
  private readonly emission = new Float32Array(256);
  private volumes: ShownVolume[] = [];
  private paletteTexture: DataTexture;
  private readonly uniforms: Record<string, IUniform>;
  private readonly flatMaterial: ShaderMaterial;
  private litMaterial: VoxelStandardMaterial | null = null;
  private readonly depthMaterial: ShaderMaterial;

  /** An animation, from `readVolumes` or `loadVoxelAnimation`. It starts paused on frame 0. */
  static fromAnimation(animation: VoxelAnimation, options: VoxelVolumeOptions = {}) {
    const volume = new VoxelVolume(new Uint8Array(1), [1, 1, 1], animation.palette, options);
    volume.setAnimation(animation);
    return volume;
  }

  constructor(volume: Uint8Array, size: Vec3, palette: readonly number[], options: VoxelVolumeOptions = {}) {
    const paletteTexture = new DataTexture(new Uint8Array(256 * 4), 256, 1, RGBAFormat, UnsignedByteType);
    paletteTexture.magFilter = paletteTexture.minFilter = NearestFilter;
    // Shared by every material, so a new volume or palette reaches all of them.
    const uniforms: Record<string, IUniform> = {
      uVolume: { value: null },
      uPalette: { value: paletteTexture },
      uSize: { value: new Vector3() },
      uOffset: { value: new Vector3() },
      uShade: { value: options.shade ?? true },
      uAO: { value: options.ao ?? true },
      uDissolve: { value: 0 },
      uDissolveEdge: { value: 0.04 },
      uDissolveColor: { value: new Color(0xffb04a) },
      uClipEnabled: { value: false },
      uClip: { value: new Vector4() },
      uFlashCenter: { value: new Vector3() },
      uFlashRadius: { value: 3 },
      uFlashColor: { value: new Color(0xffffff) },
      uFlashAmount: { value: 0 },
      uEmissiveIntensity: { value: 1 },
    };
    const flatMaterial = new ShaderMaterial({
      vertexShader: flatVertexShader,
      fragmentShader: flatFragmentShader,
      side: BackSide,
      uniforms,
    });
    // Shadow passes would otherwise draw the front faces, which the march does not expect.
    flatMaterial.shadowSide = BackSide;
    super(new BoxGeometry(), flatMaterial);
    this.uniforms = uniforms;
    this.flatMaterial = flatMaterial;
    this.paletteTexture = paletteTexture;
    // One depth-only march for every light type: three.js shadow maps are depth textures.
    this.depthMaterial = new ShaderMaterial({
      vertexShader: flatVertexShader,
      fragmentShader: depthFragmentShader,
      side: BackSide,
      uniforms,
    });
    this.customDepthMaterial = this.depthMaterial;
    this.customDistanceMaterial = this.depthMaterial;
    this.setVolume(volume, size);
    this.setPalette(palette);
    this.lighting = options.lighting ?? "flat";
  }

  /** The document grid, in voxels. */
  get size(): Vec3 {
    return [...this._grid];
  }

  /** The volume on show: its voxels (x-major), size and place in the grid. Change it through `setVoxel`. */
  get volume(): Readonly<PlacedVolume> {
    return this.volumes[this._frames[this._frame].volume];
  }

  get lighting(): VoxelLighting {
    return this._lighting;
  }

  set lighting(mode: VoxelLighting) {
    this._lighting = mode;
    if (mode === "lit") this.litMaterial ??= new VoxelStandardMaterial(this.uniforms);
    this.material = mode === "lit" ? this.litMaterial! : this.flatMaterial;
  }

  get shade() {
    return this.uniforms.uShade.value as boolean;
  }

  set shade(on: boolean) {
    this.uniforms.uShade.value = on;
  }

  get ao() {
    return this.uniforms.uAO.value as boolean;
  }

  set ao(on: boolean) {
    this.uniforms.uAO.value = on;
  }

  // #region Effects

  /**
   * 0 to 1: the share of voxels gone, picked at random per grid cell, so 0 → 1 dissolves the
   * model and the same cells go first every time. Dissolved voxels cast no shadow and can't be hit.
   */
  get dissolve(): number {
    return this.uniforms.uDissolve.value;
  }

  set dissolve(amount: number) {
    this.uniforms.uDissolve.value = Math.min(1, Math.max(0, amount));
  }

  /** How far ahead of `dissolve` voxels glow in `dissolveColor` before they go. Default 0.04. */
  get dissolveEdge(): number {
    return this.uniforms.uDissolveEdge.value;
  }

  set dissolveEdge(width: number) {
    this.uniforms.uDissolveEdge.value = Math.max(0, width);
  }

  get dissolveColor(): Color {
    return this.uniforms.uDissolveColor.value;
  }

  /**
   * A cutaway: voxels whose centers are on the plane's positive side (where
   * `plane.distanceToPoint` > 0) are hidden, in grid coordinates (the object's local space). The
   * ray goes on to the voxels behind, so the model looks solid inside. Set to null for none.
   */
  get clipPlane(): Plane | null {
    return this._clipPlane;
  }

  set clipPlane(plane: Plane | null) {
    this._clipPlane = plane ? plane.clone() : null;
    this.uniforms.uClipEnabled.value = !!plane;
    if (plane) this.uniforms.uClip.value.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
  }

  /** Light up the voxels around a cell, fading out as `update` is called: a hit. */
  flash(cell: Readonly<Vec3>, { color = 0xffffff, radius = 3, duration = 0.25 }: VoxelFlashOptions = {}) {
    this.uniforms.uFlashCenter.value.set(cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5);
    this.uniforms.uFlashColor.value.set(color);
    this.uniforms.uFlashRadius.value = radius;
    this.uniforms.uFlashAmount.value = 1;
    this.flashFade = duration > 0 ? 1 / duration : Infinity;
  }

  /**
   * Make a palette entry glow, 0 (default) to 1. Lit, it adds its color as emission (times
   * `emissiveIntensity`), for bloom to pick up; flat, it ignores face shading and AO.
   */
  setEmission(index: number, strength: number) {
    if (index < 1 || index > 255) return;
    this.emission[index] = Math.min(1, Math.max(0, strength));
    this.writePaletteAlpha();
  }

  getEmission(index: number): number {
    return this.emission[index] ?? 0;
  }

  /** Scales glowing palette entries in lit lighting. Default 1; raise it for bloom. */
  get emissiveIntensity(): number {
    return this.uniforms.uEmissiveIntensity.value;
  }

  set emissiveIntensity(value: number) {
    this.uniforms.uEmissiveIntensity.value = Math.max(0, value);
  }

  /** Whether a grid cell is cut away or dissolved, as the shader decides. */
  isHidden(x: number, y: number, z: number): boolean {
    if (this.dissolve > 0 && voxelHash(x, y, z) < this.dissolve) return true;
    return !!this._clipPlane && this._clipPlane.distanceToPoint(_cellCenter.set(x + 0.5, y + 0.5, z + 0.5)) > 0;
  }

  // #endregion

  // #region Animation

  /** Each frame's id, duration in ticks and volume. */
  get frames(): readonly { readonly id: string; readonly duration: number; readonly volume: number }[] {
    return this._frames;
  }

  get fps() {
    return this._fps;
  }

  /** The frame on show, from 0. Setting it moves the playhead to that frame's start. */
  get frame() {
    return this._frame;
  }

  set frame(index: number) {
    const i = Math.min(this._frames.length - 1, Math.max(0, Math.floor(index)));
    this._time = ticksToMs(frameStart(this.durations(), i), this._fps);
    this.show(i);
  }

  /** Milliseconds since the first frame started, at `speed` 1. */
  get time() {
    return this._time;
  }

  set time(ms: number) {
    this._time = Math.max(0, ms);
    this.show(frameAt(this.durations(), this._fps, this._time, this.loop));
  }

  get playing() {
    return this._playing;
  }

  /** Start or resume playback. Call `update` every frame to advance it. */
  play() {
    // a finished one-shot starts over
    if (!this.loop && this._time >= this.length()) this._time = 0;
    this._playing = this._frames.length > 1;
  }

  pause() {
    this._playing = false;
  }

  /** Advance playback by `seconds` of real time, as from `Clock.getDelta()` or a render loop. */
  update(seconds: number) {
    if (this.uniforms.uFlashAmount.value > 0) {
      this.uniforms.uFlashAmount.value = Math.max(0, this.uniforms.uFlashAmount.value - seconds * this.flashFade);
    }
    if (!this._playing) return;
    this._time += seconds * 1000 * this.speed;
    const end = this.length();
    if (!this.loop && this._time >= end) {
      this._time = end;
      this._playing = false;
      this.show(this._frames.length - 1);
      this.dispatchEvent({ type: "finished" });
      return;
    }
    if (this.loop && this._time >= end) this._time %= end;
    this.show(frameAt(this.durations(), this._fps, this._time, this.loop));
  }

  /** Show an animation's frames. The palette comes with it. */
  setAnimation(animation: VoxelAnimation) {
    if (!animation.frames.length || !animation.volumes.length) throw new Error("An animation needs at least one frame");
    for (const f of animation.frames) {
      if (!animation.volumes[f.volume]) throw new Error(`Frame ${f.id} refers to a missing volume`);
    }
    this.replaceVolumes(animation.volumes, animation.size);
    this._fps = animation.fps;
    this._frames = animation.frames.map((f) => ({ ...f }));
    this._time = 0;
    this._playing = false;
    this.setPalette(animation.palette);
    this.show(0, true);
  }

  // #endregion

  /** Replace everything with one volume filling a `size` grid: a new model. The volume is copied. */
  setVolume(volume: Uint8Array, size: Vec3) {
    const [sx, sy, sz] = size;
    if (!(sx > 0 && sy > 0 && sz > 0) || volume.length !== sx * sy * sz) {
      throw new Error(`Volume of ${volume.length} cells does not match size ${size.join("×")}`);
    }
    const only = this.volumes.length === 1 ? this.volumes[0] : null;
    if (only && only.offset.every((n) => n === 0) && size.every((n, i) => n === only.size[i] && n === this._grid[i])) {
      only.data.set(volume);
      only.texture.needsUpdate = true;
      return;
    }
    this.replaceVolumes([{ size: [sx, sy, sz], offset: [0, 0, 0], data: volume }], size);
    this._frames = [{ id: "frame:0", duration: 1, volume: 0 }];
    this._time = 0;
    this._playing = false;
    this.show(0, true);
  }

  /** Palette colors as 0xRRGGBB; index 0 is empty and never drawn. */
  setPalette(palette: readonly number[]) {
    const bytes = this.paletteTexture.image.data as Uint8Array;
    for (let i = 0; i < 256; i++) {
      const c = palette[i] ?? 0;
      bytes[i * 4] = (c >> 16) & 255;
      bytes[i * 4 + 1] = (c >> 8) & 255;
      bytes[i * 4 + 2] = c & 255;
    }
    this.writePaletteAlpha();
    // With color management on, palette colors are sRGB and are lit in linear space. With it off
    // (as in the editor viewport), the bytes pass through unchanged.
    this.paletteTexture.colorSpace = ColorManagement.enabled ? SRGBColorSpace : NoColorSpace;
    this.paletteTexture.needsUpdate = true;
  }

  /** The palette index at a cell of the grid in the frame on show, or 0. */
  getVoxel(x: number, y: number, z: number): number {
    const i = this.cellIndex(this.volume, x, y, z);
    return i < 0 ? 0 : this.volume.data[i];
  }

  /**
   * Set a cell of the volume on show (0 empties it); it is uploaded again before the next render.
   * Every frame that shows the same pose changes too. An animation's volumes are cropped to their
   * voxels, so cells outside the crop are ignored.
   */
  setVoxel(x: number, y: number, z: number, value: number) {
    const volume = this.volumes[this._frames[this._frame].volume];
    const i = this.cellIndex(volume, x, y, z);
    if (i < 0) return;
    volume.data[i] = value;
    volume.texture.needsUpdate = true;
  }

  /**
   * Set every cell from `min` to `max` (inclusive, grid coordinates) to `value`. Returns how many
   * cells changed. Cells outside a pose's crop are ignored, as in `setVoxel`.
   */
  fillBox(min: Readonly<Vec3>, max: Readonly<Vec3>, value: number, options: VoxelFillOptions = {}): number {
    return this.fill(options, (x, y, z) => x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2], value);
  }

  /** Set every cell whose center is within `radius` of `center` (grid coordinates) to `value`. Returns how many changed. */
  fillSphere(center: Readonly<Vec3>, radius: number, value: number, options: VoxelFillOptions = {}): number {
    const r2 = radius * radius;
    return this.fill(options, (x, y, z) => (x + 0.5 - center[0]) ** 2 + (y + 0.5 - center[1]) ** 2 + (z + 0.5 - center[2]) ** 2 <= r2, value);
  }

  /** Hits the voxel a ray reaches first, not the box: `Raycaster` results include `voxel`. */
  override raycast(raycaster: Raycaster, intersects: Intersection[]) {
    const { data, size, offset } = this.volume;
    _inverse.copy(this.matrixWorld).invert();
    _ray.copy(raycaster.ray).applyMatrix4(_inverse);
    const origin = _ray.origin.toArray().map((n, i) => n - offset[i]) as Vec3;
    const [sx, sy] = size;
    const shown = (i: number) => {
      if (data[i] === 0) return false;
      if (this.dissolve <= 0 && !this._clipPlane) return true;
      const x = i % sx, y = Math.floor(i / sx) % sy, z = Math.floor(i / (sx * sy));
      return !this.isHidden(x + offset[0], y + offset[1], z + offset[2]);
    };
    const hit = raycastVolume({ origin, dir: _ray.direction.toArray() }, size, shown);
    if (!hit) return;
    _ray.at(hit.distance, _point).applyMatrix4(this.matrixWorld);
    const distance = raycaster.ray.origin.distanceTo(_point);
    if (distance < raycaster.near || distance > raycaster.far) return;
    const cell = hit.cell.map((n, i) => n + offset[i]) as Vec3;
    const intersection: VoxelIntersection = {
      distance,
      point: _point.clone(),
      object: this,
      face: { a: 0, b: 0, c: 0, normal: new Vector3(...hit.normal), materialIndex: 0 },
      voxel: { cell, normal: hit.normal, value: this.getVoxel(...cell) },
    };
    intersects.push(intersection);
  }

  dispose() {
    for (const v of this.volumes) {
      v.texture.dispose();
      v.geometry.dispose();
    }
    this.flatMaterial.dispose();
    this.litMaterial?.dispose();
    this.depthMaterial.dispose();
    this.paletteTexture.dispose();
  }

  private writePaletteAlpha() {
    const bytes = this.paletteTexture.image.data as Uint8Array;
    for (let i = 0; i < 256; i++) bytes[i * 4 + 3] = Math.round(this.emission[i] * 255);
    this.paletteTexture.needsUpdate = true;
  }

  private fill(options: VoxelFillOptions, inside: (x: number, y: number, z: number) => boolean, value: number) {
    const targets = options.allFrames ? this.volumes : [this.volumes[this._frames[this._frame].volume]];
    let changed = 0;
    for (const volume of targets) {
      const { size, offset, data } = volume;
      let touched = false;
      for (let z = 0, i = 0; z < size[2]; z++) {
        for (let y = 0; y < size[1]; y++) {
          for (let x = 0; x < size[0]; x++, i++) {
            if (data[i] === value || !inside(x + offset[0], y + offset[1], z + offset[2])) continue;
            data[i] = value;
            changed++;
            touched = true;
          }
        }
      }
      if (touched) volume.texture.needsUpdate = true;
    }
    return changed;
  }

  private durations() {
    return this._frames.map((f) => f.duration);
  }

  private length() {
    return ticksToMs(totalTicks(this.durations()), this._fps);
  }

  private cellIndex({ size, offset }: Readonly<PlacedVolume>, x: number, y: number, z: number) {
    const lx = x - offset[0], ly = y - offset[1], lz = z - offset[2];
    if (lx < 0 || ly < 0 || lz < 0 || lx >= size[0] || ly >= size[1] || lz >= size[2]) return -1;
    return lx + size[0] * (ly + size[1] * lz);
  }

  private replaceVolumes(volumes: readonly PlacedVolume[], grid: Vec3) {
    for (const v of this.volumes) {
      v.texture.dispose();
      v.geometry.dispose();
    }
    this._grid = [...grid];
    this.volumes = volumes.map((v) => {
      const data = v.data.slice();
      const [sx, sy, sz] = v.size;
      const [ox, oy, oz] = v.offset;
      const m = 2 * BOX_MARGIN;
      const geometry = new BoxGeometry(sx + m, sy + m, sz + m).translate(ox + sx / 2, oy + sy / 2, oz + sz / 2);
      return { size: [...v.size], offset: [...v.offset], data, texture: this.createVolumeTexture(data, v.size), geometry };
    });
  }

  private show(index: number, force = false) {
    const changed = index !== this._frame;
    this._frame = index;
    const volume = this.volumes[this._frames[index].volume];
    if (changed || force) {
      this.uniforms.uVolume.value = volume.texture;
      this.uniforms.uSize.value.set(...volume.size);
      this.uniforms.uOffset.value.set(...volume.offset);
      this.geometry = volume.geometry;
    }
    if (changed && !force) this.dispatchEvent({ type: "frame", frame: index });
  }

  private createVolumeTexture(data: Uint8Array, [sx, sy, sz]: Vec3) {
    // Voxeltoy's byte order is the texture's: width x, height y, depth z. No swizzle.
    const texture = new Data3DTexture(data, sx, sy, sz);
    texture.format = RedFormat;
    texture.type = UnsignedByteType;
    texture.magFilter = texture.minFilter = NearestFilter;
    texture.unpackAlignment = 1;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }
}

/**
 * Load a voxel volumes export: its .moxelvol (a zip), or its volumes.json with the PNGs beside it
 * (fetched relative to it). Pass the result to `VoxelVolume.fromAnimation`.
 */
export async function loadVoxelAnimation(url: string | URL, init?: RequestInit): Promise<VoxelAnimation> {
  const base = new URL(url, globalThis.location?.href);
  const fetchBytes = async (at: URL) => {
    const response = await fetch(at, init);
    if (!response.ok) throw new Error(`Couldn't load ${at}: ${response.status} ${response.statusText}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const bytes = await fetchBytes(base);
  // a zip starts with a local file header, "PK\x03\x04"
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) return readVolumesZip(bytes);
  return readVolumes((name) => (name === base.href ? bytes : fetchBytes(new URL(name, base))), base.href);
}
