import { describe, expect, test } from "bun:test";
import { Matrix4, Quaternion, Vector3 } from "three";
import { heading, MAX_SCALE, ringDistance, tabletop, Turntable, twistAbout, WorkspaceGrab, workspaceUp } from "./workspace";

const parts = (m: Matrix4) => {
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  m.decompose(p, q, s);
  return { p, q, s };
};
const near = (a: Vector3, b: Vector3) => expect(a.distanceTo(b)).toBeLessThan(1e-6);
/** A hand: a point, and how it is turned (still, unless a test turns it). */
const at = (x: number, y: number, z: number, rotation = new Quaternion()) => ({ point: new Vector3(x, y, z), rotation });
const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
/** Where a point fixed in the workspace (local) ends up in the world. */
const world = (m: Matrix4, local: Vector3) => local.clone().applyMatrix4(m);
const local = (m: Matrix4, point: Vector3) => point.clone().applyMatrix4(m.clone().invert());

describe("workspace grab", () => {
  test("one hand carries it without turning it", () => {
    const grab = new WorkspaceGrab();
    const hand = at(0, 1, 0);
    const workspace = new Matrix4().compose(new Vector3(0, 1, -0.5), new Quaternion().setFromAxisAngle(Y, 0.3), new Vector3(0.01, 0.01, 0.01));
    grab.set([hand], workspace);
    hand.point.set(0.2, 1.1, 0.05);
    hand.rotation.setFromAxisAngle(X, 0.5);
    const after = grab.update()!;
    const { p, q } = parts(after);
    near(p, new Vector3(0.2, 1.1, -0.45));
    expect(q.angleTo(parts(workspace).q)).toBeLessThan(1e-6);
  });

  test("spreading two pinches scales by exactly the spread, and the pinched points stay under them", () => {
    const grab = new WorkspaceGrab();
    const a = at(-0.1, 1.2, -0.4);
    const b = at(0.1, 1.2, -0.4);
    const workspace = new Matrix4().compose(new Vector3(0, 1, -0.5), new Quaternion(), new Vector3(0.01, 0.01, 0.01));
    const la = local(workspace, a.point);
    const lb = local(workspace, b.point);
    grab.set([a, b], workspace);
    a.point.set(-0.25, 1.25, -0.35);
    b.point.set(0.15, 1.25, -0.35);
    const after = grab.update()!;
    expect(parts(after).s.x).toBeCloseTo(0.02, 9);
    near(world(after, la), a.point);
    near(world(after, lb), b.point);
  });

  test("two hands turn it, and raising one tips it, with the pinched points following", () => {
    const grab = new WorkspaceGrab();
    const a = at(-0.1, 1.2, -0.4);
    const b = at(0.1, 1.2, -0.4);
    const workspace = new Matrix4().compose(new Vector3(0, 1, -0.5), new Quaternion(), new Vector3(0.01, 0.01, 0.01));
    const la = local(workspace, a.point);
    const lb = local(workspace, b.point);
    grab.set([a, b], workspace);
    // a quarter turn across the floor
    a.point.set(0, 1.2, -0.3);
    b.point.set(0, 1.2, -0.5);
    let after = grab.update()!;
    near(world(after, la), a.point);
    near(world(after, lb), b.point);
    // the right hand raised: tipped 45°
    a.point.set(-0.1, 1.1, -0.4);
    b.point.set(0.1, 1.3, -0.4);
    after = grab.update()!;
    near(world(after, la), a.point);
    near(world(after, lb), b.point);
    expect(workspaceUp(after).angleTo(Y)).toBeCloseTo(Math.PI / 4);
  });

  test("a tilt of a few degrees snaps upright", () => {
    const grab = new WorkspaceGrab();
    const a = at(-0.1, 1.2, -0.4);
    const b = at(0.1, 1.2, -0.4);
    grab.set([a, b], new Matrix4().makeTranslation(0, 1, -0.5));
    b.point.set(0.1, 1.21, -0.4);
    near(workspaceUp(grab.update()!), Y);
  });

  test("twisting both hands about the line between them rolls it, whichever way the hands face", () => {
    const grab = new WorkspaceGrab();
    // palms facing each other: the hands turned opposite ways about the line between them
    const a = at(-0.1, 1.2, -0.4, new Quaternion().setFromAxisAngle(X, Math.PI / 2));
    const b = at(0.1, 1.2, -0.4, new Quaternion().setFromAxisAngle(X, -Math.PI / 2));
    grab.set([a, b], new Matrix4().makeTranslation(0, 1, -0.5));
    const roll = new Quaternion().setFromAxisAngle(X, Math.PI / 6);
    a.rotation.premultiply(roll);
    b.rotation.premultiply(roll);
    near(workspaceUp(grab.update()!), Y.clone().applyQuaternion(roll));
    expect(twistAbout(roll, X)).toBeCloseTo(Math.PI / 6);
    expect(twistAbout(roll, Y)).toBeCloseTo(0);
  });

  test("scale stops at the limit; nothing holds it without hands", () => {
    const grab = new WorkspaceGrab();
    const a = at(-0.1, 1, 0);
    const b = at(0.1, 1, 0);
    grab.set([a, b], new Matrix4().makeScale(0.5, 0.5, 0.5));
    a.point.set(-5, 1, 0);
    b.point.set(5, 1, 0);
    expect(parts(grab.update()!).s.x).toBeCloseTo(MAX_SCALE);
    grab.set([], new Matrix4());
    expect(grab.update()).toBeNull();
  });
});

describe("turntable", () => {
  test("dragging a point a quarter around spins the model a quarter about its base", () => {
    const spin = new Turntable();
    const workspace = new Matrix4().compose(new Vector3(0, 1, -0.5), new Quaternion(), new Vector3(0.01, 0.01, 0.01));
    const hand = new Vector3(0.3, 1, -0.5);
    const corner = new Vector3(10, 0, 0);
    spin.set(hand, workspace);
    hand.set(0, 1, -0.8);
    const after = spin.update()!;
    near(parts(after).p, new Vector3(0, 1, -0.5));
    // the cell to the right of the base is now behind it, as the hand went
    near(world(after, corner), new Vector3(0, 1, -0.6));
    expect(heading(new Vector3(0, 0, -1))).toBeCloseTo(Math.PI / 2);
  });

  test("a tilted model spins about its own axis", () => {
    const spin = new Turntable();
    const tilt = new Quaternion().setFromAxisAngle(X, Math.PI / 2);
    const workspace = new Matrix4().compose(new Vector3(0, 1, -0.5), tilt, new Vector3(0.01, 0.01, 0.01));
    const axis = workspaceUp(workspace);
    const hand = new Vector3(0.3, 1, -0.5);
    spin.set(hand, workspace);
    hand.set(0, 1.3, -0.5);
    const after = spin.update()!;
    near(workspaceUp(after), axis);
    near(parts(after).p, new Vector3(0, 1, -0.5));
  });

  test("ring distance", () => {
    expect(ringDistance(new Vector3(0.5, 0, 0), new Vector3(), 0.5)).toBeCloseTo(0);
    expect(ringDistance(new Vector3(0.5, 0.03, 0), new Vector3(), 0.5)).toBeCloseTo(0.03);
    expect(ringDistance(new Vector3(0, 0.5, 0), new Vector3(), 0.5, new Vector3(0, 0, 1))).toBeCloseTo(0);
  });
});

describe("tabletop", () => {
  test("puts a model about 40 cm across in front of the viewer", () => {
    const { p, s } = parts(tabletop([32, 16, 8], new Vector3(0, 1.6, 0), new Vector3(0, 0, -1)));
    expect(s.x * 32).toBeCloseTo(0.4);
    expect(p.z).toBeLessThan(-0.4);
    expect(p.y).toBeCloseTo(1.15);
  });
});
