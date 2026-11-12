import { describe, expect, test } from "bun:test";
import { OrthographicCamera, Raycaster, Vector2, Vector3 } from "three";
import { OrbitCamera } from "./camera";

describe("camera projection", () => {
  test("switching preserves angle, target and scale at the target plane", () => {
    const orbit = new OrbitCamera();
    orbit.setAspect(1.5);
    orbit.frame(new Vector3(12, 16, 8), 10);
    const position = orbit.camera.position.clone();
    const target = orbit.target.clone();
    const right = new Vector3().setFromMatrixColumn(orbit.camera.matrix, 0);
    const point = target.clone().addScaledVector(right, 3);
    const before = point.clone().project(orbit.camera);
    orbit.setProjection("orthographic");
    expect(orbit.camera).toBeInstanceOf(OrthographicCamera);
    expect(orbit.camera.position.distanceTo(position)).toBeCloseTo(0);
    expect(orbit.target.distanceTo(target)).toBeCloseTo(0);
    expect(point.clone().project(orbit.camera).x).toBeCloseTo(before.x);
    orbit.setProjection("perspective");
    expect(point.clone().project(orbit.camera).x).toBeCloseTo(before.x);
  });

  test("orthographic picking rays are parallel with distinct origins", () => {
    const orbit = new OrbitCamera();
    orbit.setProjection("orthographic");
    const a = new Raycaster();
    const b = new Raycaster();
    a.setFromCamera(new Vector2(-0.5, 0), orbit.camera);
    b.setFromCamera(new Vector2(0.5, 0), orbit.camera);
    expect(a.ray.direction.distanceTo(b.ray.direction)).toBeCloseTo(0);
    expect(a.ray.origin.distanceTo(b.ray.origin)).toBeGreaterThan(0);
    const near = orbit.target.clone().addScaledVector(a.ray.direction, -10);
    const far = orbit.target.clone().addScaledVector(a.ray.direction, 10);
    expect(near.project(orbit.camera).x).toBeCloseTo(far.project(orbit.camera).x);
  });

  test("orthographic zoom, pan and portrait framing use the visible span", () => {
    const orbit = new OrbitCamera();
    orbit.setProjection("orthographic");
    orbit.setAspect(0.5);
    orbit.frame(new Vector3(), 20);
    const camera = orbit.camera as OrthographicCamera;
    expect(camera.right).toBeCloseTo(21);
    expect(camera.top).toBeCloseTo(42);
    orbit.zoom(0.5);
    expect(camera.top).toBeCloseTo(21);
    const before = orbit.target.clone();
    orbit.pan(100, 0, 1000);
    expect(orbit.target.distanceTo(before)).toBeCloseTo(4.2);
    orbit.setAspect(2);
    expect(camera.right / camera.top).toBeCloseTo(2);
  });
});

describe("camera insets", () => {
  test("a panel over the bottom lifts the view's middle and fits into the space above it", () => {
    const orbit = new OrbitCamera();
    orbit.setAspect(400 / 800);
    orbit.frame(new Vector3(), 10);
    const open = orbit.distance;
    orbit.setInsets(0, 200, 400, 800);
    // the target sits in the middle of the 600 pixels above the panel: 100 pixels above the canvas's middle
    expect(orbit.target.clone().project(orbit.camera).y).toBeCloseTo(100 / 400);
    orbit.setProjection("orthographic");
    expect(orbit.target.clone().project(orbit.camera).y).toBeCloseTo(100 / 400);
    orbit.setProjection("perspective");
    orbit.frame(new Vector3(), 10);
    expect(orbit.distance).toBeGreaterThanOrEqual(open - 1e-9);
    // a picking ray through the lifted middle meets the target
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2(0, 100 / 400), orbit.camera);
    expect(ray.ray.distanceToPoint(orbit.target)).toBeCloseTo(0);
    orbit.setInsets(0, 0, 400, 800);
    expect(orbit.target.clone().project(orbit.camera).y).toBeCloseTo(0);
  });
});
