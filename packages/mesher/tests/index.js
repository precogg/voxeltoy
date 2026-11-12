import assert from "node:assert/strict";
import { memory, alloc, free, mesh, BYTES_PER_QUAD, MESH_NO_AO, MESH_NO_SHADE } from "../build/debug.js";

const NO_AO = MESH_NO_AO.value;
const NO_SHADE = MESH_NO_SHADE.value;
const palette = Array.from({ length: 256 }, (_, i) => [200, 80 + (i % 128), 60]);

function meshVolume(voxels, sx, sy, sz, capacity = 4096, flags = 0) {
  const vPtr = alloc(Math.max(1, voxels.length));
  const pPtr = alloc(1024);
  const bytes = capacity * BYTES_PER_QUAD.value;
  const allocation = alloc(bytes + 32);
  const oPtr = allocation + 16;
  new Uint8Array(memory.buffer, vPtr, voxels.length).set(voxels);
  const pal = new Uint8Array(memory.buffer, pPtr, 1024);
  palette.forEach((rgb, i) => pal.set([...rgb, 0], i * 4));
  new Uint8Array(memory.buffer, allocation, bytes + 32).fill(0xab);
  const count = mesh(vPtr, sx, sy, sz, pPtr, oPtr, capacity, flags);
  const written = Math.min(count, capacity);
  const positions = new Float32Array(memory.buffer, oPtr, written * 12).slice();
  const colors = new Uint8Array(memory.buffer, oPtr + capacity * 48, written * 12).slice();
  assert.ok(new Uint8Array(memory.buffer, allocation, 16).every((b) => b === 0xab));
  assert.ok(new Uint8Array(memory.buffer, oPtr + bytes, 16).every((b) => b === 0xab));
  free(vPtr); free(pPtr); free(allocation);
  return { count, positions, colors };
}

assert.equal(meshVolume(new Uint8Array([1]), 1, 1, 1).count, 6);
assert.equal(meshVolume(new Uint8Array([1, 1]), 2, 1, 1).count, 6);
assert.equal(meshVolume(new Uint8Array([1, 2]), 2, 1, 1).count, 10);
assert.equal(meshVolume(new Uint8Array(8), 2, 2, 2).count, 0);
assert.equal(meshVolume(new Uint8Array(0), 0, 2, 2).count, 0);
assert.equal(meshVolume(new Uint8Array(7 * 5 * 3).fill(1), 7, 5, 3).count, 6);

for (const capacity of [0, 1, 3, 6]) {
  const full = meshVolume(new Uint8Array([1, 1]), 2, 1, 1);
  const truncated = meshVolume(new Uint8Array([1, 1]), 2, 1, 1, capacity);
  assert.equal(truncated.count, full.count);
  assert.deepEqual(truncated.positions, full.positions.slice(0, capacity * 12));
  assert.deepEqual(truncated.colors, full.colors.slice(0, capacity * 12));
}

// Independent unit-face oracle: every exposed voxel face, including its original
// corner AO. Expand greedy rectangles into unit faces to verify coverage, winding,
// palette boundaries, and shading without depending on rectangle ordering.
function verify(voxels, size, flags = 0) {
  const [sx, sy, sz] = size;
  const value = (p) => p.some((n, a) => n < 0 || n >= size[a]) ? 0 : voxels[p[0] + sx * (p[1] + sy * p[2])];
  const solid = (p) => value(p) ? 1 : 0;
  const expected = new Map();
  const shades = [0.78, 0.86, 0.6, 1, 0.7, 0.92].map(Math.fround);
  const aoShades = [1, 0.87, 0.77, 0.66].map(Math.fround);
  for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) {
    const p = [x, y, z], color = value(p);
    if (!color) continue;
    for (let face = 0; face < 6; face++) {
      const axis = face >> 1, positive = face & 1, u = (axis + 1) % 3, v = (axis + 2) % 3;
      const n = [...p]; n[axis] += positive ? 1 : -1;
      if (solid(n)) continue;
      const corners = new Map();
      const aos = [];
      for (const [cu, cv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const s1 = [...n], s2 = [...n], c = [...n];
        s1[u] += cu ? 1 : -1; s2[v] += cv ? 1 : -1;
        c[u] = s1[u]; c[v] = s2[v];
        const a = solid(s1), b = solid(s2);
        const ao = flags & NO_AO ? 0 : a && b ? 3 : a + b + solid(c);
        aos.push(ao);
        const shade = Math.fround((flags & NO_SHADE ? 1 : shades[face]) * aoShades[ao]);
        const point = [...p]; point[axis] += positive; point[u] += cu; point[v] += cv;
        corners.set(point.join(), palette[color].map((c) => Math.trunc(Math.fround(c * shade))));
      }
      expected.set(`${face}:${p.join()}`, { corners, aos });
    }
  }
  const result = meshVolume(voxels, ...size, 4096, flags);
  for (let q = 0; q < result.count; q++) {
    const points = Array.from({ length: 4 }, (_, i) => [...result.positions.slice(q * 12 + i * 3, q * 12 + i * 3 + 3)]);
    const colors = Array.from({ length: 4 }, (_, i) => [...result.colors.slice(q * 12 + i * 3, q * 12 + i * 3 + 3)]);
    const [a, b, c] = points;
    const ab = b.map((n, i) => n - a[i]), ac = c.map((n, i) => n - a[i]);
    const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const axis = normal.findIndex((n) => n !== 0);
    assert.ok(axis >= 0, "nondegenerate quad");
    assert.equal(normal.filter((n) => n !== 0).length, 1);
    const positive = normal[axis] > 0 ? 1 : 0, face = axis * 2 + positive;
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const lo = [0, 1, 2].map((a) => Math.min(...points.map((p) => p[a])));
    const hi = [0, 1, 2].map((a) => Math.max(...points.map((p) => p[a])));
    assert.equal(lo[axis], hi[axis]);
    assert.ok(points.flat().every(Number.isInteger));
    const merged = (hi[u] - lo[u]) * (hi[v] - lo[v]) > 1;
    if (merged) colors.forEach((color) => assert.deepEqual(color, colors[0], "only flat AO may stretch"));
    for (let dv = lo[v]; dv < hi[v]; dv++) for (let du = lo[u]; du < hi[u]; du++) {
      const p = [...lo]; p[axis] -= positive; p[u] = du; p[v] = dv;
      const key = `${face}:${p.join()}`, original = expected.get(key);
      assert.ok(original, `unexpected or duplicate face ${key}`);
      for (const [point, color] of original.corners) {
        const i = merged ? 0 : points.findIndex((p) => p.join() === point);
        assert.ok(i >= 0);
        assert.deepEqual(colors[i], color, `shading at ${key}, ${point}`);
      }
      if (!merged) {
        const ao = original.aos;
        const diagonal = ao[0] + ao[2] > ao[1] + ao[3] ? 1 : 0;
        const first = [...p]; first[axis] += positive;
        if (diagonal) first[positive ? u : v]++;
        assert.deepEqual(points[0], first, "AO diagonal preserved");
      }
      expected.delete(key);
    }
  }
  assert.equal(expected.size, 0, "all exposed faces covered");
}

verify(new Uint8Array(7 * 5 * 3).fill(1), [7, 5, 3]);
verify(new Uint8Array([1, 2]), [2, 1, 1]);
const cavity = new Uint8Array(5 ** 3).fill(1);
cavity[2 + 5 * (2 + 5 * 2)] = 0;
verify(cavity, [5, 5, 5]);
assert.equal(meshVolume(cavity, 5, 5, 5).count, 12);
const step = new Uint8Array(4 * 3 * 2);
for (let z = 0; z < 2; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) {
  if (y === 0 || x < 2) step[x + 4 * (y + 3 * z)] = 1;
}
verify(step, [4, 3, 2]);
const fullStep = meshVolume(step, 4, 3, 2);
for (const capacity of [0, 2, fullStep.count - 1]) {
  const partial = meshVolume(step, 4, 3, 2, capacity);
  assert.equal(partial.count, fullStep.count);
  assert.deepEqual(partial.positions, fullStep.positions.slice(0, capacity * 12));
  assert.deepEqual(partial.colors, fullStep.colors.slice(0, capacity * 12));
}

// Steps, holes, cavities, disjoint pieces, and palette boundaries, reproducibly.
let seed = 12345;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
for (let trial = 0; trial < 60; trial++) {
  const size = [1 + random() % 7, 1 + random() % 6, 1 + random() % 5];
  const voxels = Uint8Array.from({ length: size[0] * size[1] * size[2] }, () => (random() >>> 16) % 4);
  for (const flags of [0, NO_AO, NO_SHADE, NO_AO | NO_SHADE]) verify(voxels, size, flags);
}

console.log("greedy mesher: coverage, winding, colors, AO, flags, and capacity ok");
