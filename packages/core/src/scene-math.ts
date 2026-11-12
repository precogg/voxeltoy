// Transforms for scenes: quaternions, Euler degrees and 4×4 matrices (column-major, as three.js
// keeps them). Scenes use uniform scale only, so every transform decomposes exactly.

import type { Vec3 } from "./types";

/** A rotation as a unit quaternion [x, y, z, w]. */
export type Quat = [number, number, number, number];
/** A 4×4 matrix, column-major. */
export type Mat4 = number[];

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

const DEG = Math.PI / 180;

/** A rotation from Euler degrees, applied X then Y then Z in the rotating frame (three.js "XYZ"). */
export function quatFromEuler([x, y, z]: Vec3): Quat {
  const [cx, cy, cz] = [Math.cos((x * DEG) / 2), Math.cos((y * DEG) / 2), Math.cos((z * DEG) / 2)];
  const [sx, sy, sz] = [Math.sin((x * DEG) / 2), Math.sin((y * DEG) / 2), Math.sin((z * DEG) / 2)];
  return normalizeQuat([
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ]);
}

/** Euler degrees (three.js "XYZ") for a rotation, each in (-180, 180]. */
export function eulerFromQuat(q: Quat): Vec3 {
  const m = matFromTransform([0, 0, 0], q, 1);
  const m13 = m[8];
  const y = Math.asin(Math.max(-1, Math.min(1, m13)));
  let x: number;
  let z: number;
  if (Math.abs(m13) < 0.9999999) {
    x = Math.atan2(-m[9], m[10]);
    z = Math.atan2(-m[4], m[0]);
  } else {
    x = Math.atan2(m[6], m[5]);
    z = 0;
  }
  return [x, y, z].map((r) => clean(r / DEG)) as Vec3;
}

/** Round away float noise, so 90 reads as 90 and -0 as 0. */
function clean(n: number, scale = 1e6): number {
  const r = Math.round(n * scale) / scale;
  return r === 0 ? 0 : r;
}

/** Round away only the last digits: for values that are stored, not shown. */
const fine = (n: number) => clean(n, 1e12);

export function normalizeQuat(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!n || !Number.isFinite(n)) return [...IDENTITY_QUAT];
  // one sign for each rotation, so equal rotations compare equal
  const s = q[3] < 0 ? -1 / n : 1 / n;
  return q.map((v) => fine(v * s)) as Quat;
}

export function multiplyQuat(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function isQuat(q: unknown): q is Quat {
  return Array.isArray(q) && q.length === 4 && q.every((n) => typeof n === "number" && Number.isFinite(n)) && Math.hypot(...(q as number[])) > 1e-6;
}

/** Translation, then rotation, then uniform scale: T · R · S. */
export function matFromTransform(position: Vec3, rotation: Quat, scale: number): Mat4 {
  const [x, y, z, w] = rotation;
  const [x2, y2, z2] = [x + x, y + y, z + z];
  const [xx, xy, xz] = [x * x2, x * y2, x * z2];
  const [yy, yz, zz] = [y * y2, y * z2, z * z2];
  const [wx, wy, wz] = [w * x2, w * y2, w * z2];
  const s = scale;
  return [
    (1 - (yy + zz)) * s, (xy + wz) * s, (xz - wy) * s, 0,
    (xy - wz) * s, (1 - (xx + zz)) * s, (yz + wx) * s, 0,
    (xz + wy) * s, (yz - wx) * s, (1 - (xx + yy)) * s, 0,
    position[0], position[1], position[2], 1,
  ];
}

export function multiplyMat(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function translationMat(v: Vec3): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1];
}

/** Position, rotation and uniform scale of a matrix made of them. */
export function decomposeMat(m: Mat4): { position: Vec3; rotation: Quat; scale: number } {
  const scale = Math.hypot(m[0], m[1], m[2]);
  const s = scale || 1;
  const r = [m[0] / s, m[1] / s, m[2] / s, m[4] / s, m[5] / s, m[6] / s, m[8] / s, m[9] / s, m[10] / s];
  // rotation matrix to quaternion (column-major r: r[0]=m11 r[1]=m21 r[2]=m31 r[3]=m12 ...)
  const [m11, m21, m31, m12, m22, m32, m13, m23, m33] = r;
  const trace = m11 + m22 + m33;
  let q: Quat;
  if (trace > 0) {
    const t = 0.5 / Math.sqrt(trace + 1);
    q = [(m32 - m23) * t, (m13 - m31) * t, (m21 - m12) * t, 0.25 / t];
  } else if (m11 > m22 && m11 > m33) {
    const t = 2 * Math.sqrt(1 + m11 - m22 - m33);
    q = [0.25 * t, (m12 + m21) / t, (m13 + m31) / t, (m32 - m23) / t];
  } else if (m22 > m33) {
    const t = 2 * Math.sqrt(1 + m22 - m11 - m33);
    q = [(m12 + m21) / t, 0.25 * t, (m23 + m32) / t, (m13 - m31) / t];
  } else {
    const t = 2 * Math.sqrt(1 + m33 - m11 - m22);
    q = [(m13 + m31) / t, (m23 + m32) / t, 0.25 * t, (m21 - m12) / t];
  }
  return { position: [fine(m[12]), fine(m[13]), fine(m[14])], rotation: normalizeQuat(q), scale: fine(scale) };
}

/** The inverse of T · R · S with uniform scale. */
export function invertMat(m: Mat4): Mat4 {
  const { position, rotation, scale } = decomposeMat(m);
  const inv: Quat = [-rotation[0], -rotation[1], -rotation[2], rotation[3]];
  const s = 1 / (scale || 1);
  const r = matFromTransform([0, 0, 0], inv, s);
  const p = transformPoint(r, position);
  r[12] = -p[0];
  r[13] = -p[1];
  r[14] = -p[2];
  return r;
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** A direction through a matrix: rotated and scaled, not moved. */
export function transformDirection(m: Mat4, d: Vec3): Vec3 {
  return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
}

/** The quarter turn that takes +Y to an axis, `sign` its way along it: standing out of a face. */
export function quatUpTo(axis: 0 | 1 | 2, sign: 1 | -1): Quat {
  if (axis === 1) return sign > 0 ? [0, 0, 0, 1] : quatFromEuler([180, 0, 0]);
  return axis === 0 ? quatFromEuler([0, 0, sign > 0 ? -90 : 90]) : quatFromEuler([sign > 0 ? 90 : -90, 0, 0]);
}
