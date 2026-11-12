// Voxeltoy mesher.
//
// Operates on raw linear memory so the JS side never marshals objects:
//
//   voxels:  u8 per cell, x-major (x + sx * (y + sy * z)). 0 = empty, otherwise
//            a palette index.
//   palette: 256 * 4 bytes (r, g, b, unused). palette[v] is the color of value v.
//   out:     [positions: capacity * 4 verts * 3 * f32][colors: capacity * 4 verts * 3 * u8]
//
// Each emitted quad has 4 vertices wound CCW (seen from outside), to be drawn with
// the fixed index pattern (0, 1, 2, 0, 2, 3). Directional face shading and
// per-vertex ambient occlusion are baked into the vertex colors.

export function alloc(size: usize): usize {
  return heap.alloc(size);
}

export function free(ptr: usize): void {
  heap.free(ptr);
}

export const BYTES_PER_QUAD: i32 = 4 * 3 * 4 + 4 * 3;

/** Skip directional face shading (e.g. for export, where the renderer lights the mesh). */
export const MESH_NO_SHADE: i32 = 1 << 0;
/** Skip ambient occlusion. */
export const MESH_NO_AO: i32 = 1 << 1;

// Face order: -x, +x, -y, +y, -z, +z
const FACE_SHADE: StaticArray<f32> = [0.78, 0.86, 0.6, 1.0, 0.7, 0.92];
const AO_SHADE: StaticArray<f32> = [1.0, 0.87, 0.77, 0.66];

let gVoxels: usize = 0;
let gSx: i32 = 0;
let gSy: i32 = 0;
let gSz: i32 = 0;

@inline
function solid(x: i32, y: i32, z: i32): i32 {
  if (<u32>x >= <u32>gSx || <u32>y >= <u32>gSy || <u32>z >= <u32>gSz) return 0;
  return load<u8>(gVoxels + <usize>(x + gSx * (y + gSy * z))) != 0 ? 1 : 0;
}

@inline
function vertexAO(side1: i32, side2: i32, corner: i32): i32 {
  if (side1 && side2) return 3;
  return side1 + side2 + corner;
}

/** AO corners in the canonical (u, v) order: (0,0), (1,0), (1,1), (0,1). */
function faceAO(nx: i32, ny: i32, nz: i32, axis: i32): i32 {
  const ux = axis == 2 ? 1 : 0, uy = axis == 0 ? 1 : 0, uz = axis == 1 ? 1 : 0;
  const vx = axis == 1 ? 1 : 0, vy = axis == 2 ? 1 : 0, vz = axis == 0 ? 1 : 0;
  let packed = 0;
  for (let i = 0; i < 4; i++) {
    const du = i == 1 || i == 2 ? 1 : -1;
    const dv = i >= 2 ? 1 : -1;
    const s1 = solid(nx + ux * du, ny + uy * du, nz + uz * du);
    const s2 = solid(nx + vx * dv, ny + vy * dv, nz + vz * dv);
    const c = solid(nx + ux * du + vx * dv, ny + uy * du + vy * dv, nz + uz * du + vz * dv);
    packed |= vertexAO(s1, s2, c) << (i * 2);
  }
  return packed;
}

/**
 * Greedily mesh exposed faces of a dense volume. Merge only equal palette indices
 * with constant AO across all corners: stretching an AO gradient over a rectangle
 * would change the original voxel shading. Nonuniform faces stay unit quads.
 * Returns the total quad count even if only `capacity` quads fit in `out`.
 */
export function mesh(
  voxels: usize,
  sx: i32,
  sy: i32,
  sz: i32,
  palette: usize,
  out: usize,
  capacity: i32,
  flags: i32,
): i32 {
  if (sx <= 0 || sy <= 0 || sz <= 0) return 0;
  const useShade = (flags & MESH_NO_SHADE) == 0;
  const useAO = (flags & MESH_NO_AO) == 0;
  gVoxels = voxels;
  gSx = sx;
  gSy = sy;
  gSz = sz;

  // One reusable face mask for the largest cross section, independent of output
  // capacity. A cell stores its palette index and four two-bit AO values.
  const mask = heap.alloc(<usize>max(sx * sy, max(sy * sz, sz * sx)) * 4);
  const colorsBase = out + <usize>capacity * 48;
  let count = 0;

  for (let face = 0; face < 6; face++) {
    const axis = face >> 1;
    const positive = face & 1;
    const dir = positive ? 1 : -1;
    const ax = axis == 0 ? 1 : 0, ay = axis == 1 ? 1 : 0, az = axis == 2 ? 1 : 0;
    // Cyclic axes ensure u x v == the positive normal.
    const ux = axis == 2 ? 1 : 0, uy = axis == 0 ? 1 : 0, uz = axis == 1 ? 1 : 0;
    const vx = axis == 1 ? 1 : 0, vy = axis == 2 ? 1 : 0, vz = axis == 0 ? 1 : 0;
    const depth = axis == 0 ? sx : axis == 1 ? sy : sz;
    const nu = axis == 0 ? sy : axis == 1 ? sz : sx;
    const nv = axis == 0 ? sz : axis == 1 ? sx : sy;
    const shade: f32 = useShade ? FACE_SHADE[face] : 1.0;

    for (let d = 0; d < depth; d++) {
      for (let v = 0; v < nv; v++) {
        for (let u = 0; u < nu; u++) {
          const x = ax * d + ux * u + vx * v;
          const y = ay * d + uy * u + vy * v;
          const z = az * d + uz * u + vz * v;
          const value = load<u8>(voxels + <usize>(x + sx * (y + sy * z)));
          const nx = x + ax * dir, ny = y + ay * dir, nz = z + az * dir;
          let key = 0;
          if (value != 0 && !solid(nx, ny, nz)) {
            key = value | ((useAO ? faceAO(nx, ny, nz, axis) : 0) << 8);
          }
          store<i32>(mask + <usize>(u + nu * v) * 4, key);
        }
      }

      for (let v = 0; v < nv; v++) {
        for (let u = 0; u < nu; u++) {
          const cell = mask + <usize>(u + nu * v) * 4;
          const key = load<i32>(cell);
          if (key == 0) continue;
          const ao = key >> 8;
          const uniform = ao == (ao & 3) * 85;
          let width = 1, height = 1;
          if (uniform) {
            while (u + width < nu && load<i32>(cell + <usize>width * 4) == key) width++;
            while (v + height < nv) {
              let matches = true;
              for (let du = 0; du < width; du++) {
                if (load<i32>(cell + <usize>(height * nu + du) * 4) != key) {
                  matches = false;
                  break;
                }
              }
              if (!matches) break;
              height++;
            }
          }
          for (let dv = 0; dv < height; dv++) {
            memory.fill(cell + <usize>(dv * nu) * 4, 0, <usize>width * 4);
          }

          if (count < capacity) {
            const value = key & 255;
            const pr = <f32>load<u8>(palette + (<usize>value << 2));
            const pg = <f32>load<u8>(palette + (<usize>value << 2) + 1);
            const pb = <f32>load<u8>(palette + (<usize>value << 2) + 2);
            // Keep the original AO-aware diagonal, including on negative faces.
            const start = (ao & 3) + ((ao >> 4) & 3) > ((ao >> 2) & 3) + ((ao >> 6) & 3) ? 1 : 0;
            const plane = d + positive;
            const posPtr = out + <usize>count * 48;
            const colPtr = colorsBase + <usize>count * 12;
            for (let k = 0; k < 4; k++) {
              const ring = (k + start) & 3;
              const i = positive ? ring : (4 - ring) & 3;
              const cu = u + (i == 1 || i == 2 ? width : 0);
              const cv = v + (i >= 2 ? height : 0);
              store<f32>(posPtr + <usize>k * 12, <f32>(ax * plane + ux * cu + vx * cv));
              store<f32>(posPtr + <usize>k * 12 + 4, <f32>(ay * plane + uy * cu + vy * cv));
              store<f32>(posPtr + <usize>k * 12 + 8, <f32>(az * plane + uz * cu + vz * cv));
              const f = shade * AO_SHADE[(ao >> (i * 2)) & 3];
              store<u8>(colPtr + <usize>k * 3, <u8>min<f32>(255, pr * f));
              store<u8>(colPtr + <usize>k * 3 + 1, <u8>min<f32>(255, pg * f));
              store<u8>(colPtr + <usize>k * 3 + 2, <u8>min<f32>(255, pb * f));
            }
          }
          count++;
        }
      }
    }
  }
  heap.free(mask);
  return count;
}
