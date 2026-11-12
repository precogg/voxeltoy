import { Matrix4, Quaternion, Vector3 } from "three";

/** Metres per voxel the workspace may be scaled to: a grain of sand to a big step. */
export const MIN_SCALE = 0.001;
export const MAX_SCALE = 1;

const UP = new Vector3(0, 1, 0);
/** Within this of upright (radians), a model held in two hands snaps upright. */
export const UPRIGHT_SNAP = (6 * Math.PI) / 180;

/** The angle of `v` about the vertical, counterclockwise from above: turning by `a` about +Y adds `a`. */
export const heading = (v: Vector3) => Math.atan2(-v.z, v.x);

/** The angle of `v` about `axis` (a unit vector), increasing as `v` turns about it: from a basis across the axis. */
function angleAbout(v: Vector3, axis: Vector3) {
  const e1 = Math.abs(axis.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  e1.sub(axis.clone().multiplyScalar(e1.dot(axis))).normalize();
  const e2 = axis.clone().cross(e1);
  return Math.atan2(v.dot(e2), v.dot(e1));
}

/** Where a hand holds the workspace: a point, and how the hand is turned (for twisting). Both live. */
export interface Handle {
  point: Vector3;
  rotation: Quaternion;
}

/** How far `q` turns about `axis` (a unit vector), radians: the twist in its swing-twist split. */
export function twistAbout(q: Quaternion, axis: Vector3) {
  const along = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  let a = 2 * Math.atan2(along, q.w);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Grabbing the workspace (the model and everything drawn in voxel space) by points in the room:
 * a hand's pinch, a controller's grip. One hand carries it: the point held moves with the hand,
 * without turning, so placing it is steady. Two hands handle it like an object held in both:
 * the points pinched stay under the pinches as the hands move, turn and spread (spreading them
 * twice as far makes it twice as big), raising one hand tips it, and twisting both wrists rolls it
 * about the line between them. Within `UPRIGHT_SNAP` of upright it snaps upright. This is only
 * how the model is seen: the document is unchanged, and nothing here is undoable.
 *
 * The handles are live: `update` reads where they are now. It returns the workspace's new world
 * matrix (uniformly scaled), or null when nothing holds it.
 */
export class WorkspaceGrab {
  private start = new Matrix4();
  private handles: Handle[] = [];
  private from: Handle[] = [];

  get holding() {
    return this.handles.length;
  }

  /** Start (or start over) from the workspace's current matrix, with these handles holding it. */
  set(handles: Handle[], workspace: Matrix4) {
    this.handles = handles.slice(0, 2);
    this.from = this.handles.map((h) => ({ point: h.point.clone(), rotation: h.rotation.clone() }));
    this.start.copy(workspace);
  }

  update(): Matrix4 | null {
    const n = this.handles.length;
    if (!n) return null;
    const pos = new Vector3();
    const rot = new Quaternion();
    const scl = new Vector3();
    this.start.decompose(pos, rot, scl);
    if (n === 1) {
      pos.add(this.handles[0].point.clone().sub(this.from[0].point));
      return new Matrix4().compose(pos, rot, scl);
    }

    const [a0, b0] = this.from.map((h) => h.point);
    const [a, b] = this.handles.map((h) => h.point);
    const mid0 = a0.clone().add(b0).multiplyScalar(0.5);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const span0 = b0.clone().sub(a0);
    const span = b.clone().sub(a);
    const d0 = span0.length();
    const d = span.length();
    if (d0 < 1e-3 || d < 1e-3) return null;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scl.x * (d / d0)));
    const k = scale / scl.x;

    // the line between the hands carries the model round (swing); both hands twisting about that
    // line (as on a rolling pin) roll it, by how far each has turned about it since taking hold
    const axis = span.clone().divideScalar(d);
    const swing = new Quaternion().setFromUnitVectors(span0.clone().divideScalar(d0), axis);
    const twists = this.handles.map((h, i) => twistAbout(h.rotation.clone().multiply(this.from[i].rotation.clone().invert()), axis));
    const roll = (twists[0] + twists[1]) / 2;
    const turn = new Quaternion().setFromAxisAngle(axis, roll).multiply(swing);

    rot.premultiply(turn);
    // near upright, upright
    const modelUp = UP.clone().applyQuaternion(rot);
    if (modelUp.angleTo(UP) < UPRIGHT_SNAP) {
      const level = new Quaternion().setFromUnitVectors(modelUp, UP);
      rot.premultiply(level);
      turn.premultiply(level);
    }

    // the point that was between the hands stays between them, turned and scaled about it
    pos.sub(mid0).multiplyScalar(k).applyQuaternion(turn).add(mid);
    return new Matrix4().compose(pos, rot, new Vector3(scale, scale, scale));
  }
}

/** The workspace's own up, in the world: the model's vertical, tilted with it. */
export function workspaceUp(workspace: Matrix4) {
  return new Vector3().setFromMatrixColumn(workspace, 1).normalize();
}

/**
 * Spinning the workspace about its own vertical axis through its origin (the model's base
 * center), like a turntable (tilted with the model), by a point dragged around it.
 */
export class Turntable {
  private start = new Matrix4();
  private center = new Vector3();
  private axis = new Vector3(0, 1, 0);
  private angle = 0;
  private handle: Vector3 | null = null;

  get spinning() {
    return !!this.handle;
  }

  set(handle: Vector3 | null, workspace: Matrix4) {
    this.handle = handle;
    this.start.copy(workspace);
    this.center.setFromMatrixPosition(workspace);
    this.axis.copy(workspaceUp(workspace));
    if (handle) this.angle = angleAbout(handle.clone().sub(this.center), this.axis);
  }

  update(): Matrix4 | null {
    if (!this.handle) return null;
    const v = this.handle.clone().sub(this.center);
    const across = v.clone().sub(this.axis.clone().multiplyScalar(v.dot(this.axis)));
    if (across.length() < 1e-3) return null;
    const turn = angleAbout(v, this.axis) - this.angle;
    const c = this.center;
    return new Matrix4()
      .makeTranslation(c.x, c.y, c.z)
      .multiply(new Matrix4().makeRotationAxis(this.axis, turn))
      .multiply(new Matrix4().makeTranslation(-c.x, -c.y, -c.z))
      .multiply(this.start);
  }
}

/** How far `point` is from a ring of `radius` about `center`, square to `axis` (a unit vector), in the same units. */
export function ringDistance(point: Vector3, center: Vector3, radius: number, axis = UP) {
  const v = point.clone().sub(center);
  const h = v.dot(axis);
  const across = v.sub(axis.clone().multiplyScalar(h)).length();
  return Math.hypot(across - radius, h);
}

/**
 * Where to put a model of `size` voxels so it sits on a table in front of a viewer at `head`
 * looking along `forward`: about 40 cm across, half a metre ahead and a little below the eyes,
 * turned to face them.
 */
export function tabletop(size: readonly number[], head: Vector3, forward: Vector3): Matrix4 {
  const longest = Math.max(1, ...size);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, 0.4 / longest));
  const flat = new Vector3(forward.x, 0, forward.z);
  if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
  flat.normalize();
  const position = head.clone().addScaledVector(flat, 0.55);
  position.y = Math.max(0.3, head.y - 0.45);
  // the model's front (+z) faces the viewer
  const yaw = Math.atan2(-flat.x, -flat.z);
  const rotation = new Quaternion().setFromAxisAngle(UP, yaw);
  return new Matrix4().compose(position, rotation, new Vector3(scale, scale, scale));
}
