import { OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import type { ProjectionMode } from "@voxeltoy/core/types";

/** A turntable camera: yaw/pitch around a target, at a distance. */
export class OrbitCamera {
  private readonly perspective = new PerspectiveCamera(40, 1, 0.1, 5000);
  private readonly orthographic = new OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  private projection: ProjectionMode = "perspective";

  get camera(): PerspectiveCamera | OrthographicCamera {
    return this.projection === "orthographic" ? this.orthographic : this.perspective;
  }

  /** Half the visible height at the orbit target, shared by both projections. */
  private get halfHeight() {
    return this.distance * Math.tan((this.perspective.fov * Math.PI) / 360);
  }
  /** Pixels the view's middle sits above the canvas's (a lens shift), the canvas's size, and the share of its height in view. */
  private inset = { shift: 0, width: 1, height: 1, visible: 1 };
  target = new Vector3();
  distance = 60;
  yaw = Math.PI / 4;
  pitch = Math.PI / 6;

  constructor() {
    this.update();
  }

  setProjection(projection: ProjectionMode) {
    this.projection = projection;
    this.update();
  }

  orbit(dYaw: number, dPitch: number) {
    this.yaw += dYaw;
    this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch + dPitch));
    this.update();
  }

  /** Pan by screen-space pixels. */
  pan(dx: number, dy: number, viewportHeight: number) {
    const worldPerPixel = (2 * this.halfHeight) / viewportHeight;
    const right = new Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    this.target.addScaledVector(right, -dx * worldPerPixel).addScaledVector(up, dy * worldPerPixel);
    this.update();
  }

  zoom(factor: number) {
    this.distance = Math.max(2, Math.min(2000, this.distance * factor));
    this.update();
  }

  /** Frame a sphere of `radius` around `center`. */
  frame(center: Vector3, radius: number, yaw = this.yaw, pitch = this.pitch) {
    this.target.copy(center);
    this.yaw = yaw;
    this.pitch = pitch;
    const fov = (this.perspective.fov * Math.PI) / 180;
    const tall = 2 * Math.atan(Math.tan(fov / 2) * this.inset.visible);
    const fit = Math.min(tall, 2 * Math.atan(Math.tan(fov / 2) * this.perspective.aspect));
    this.distance = (radius / (this.projection === "orthographic" ? Math.tan(fit / 2) : Math.sin(fit / 2))) * 1.05;
    this.update();
  }

  setAspect(aspect: number) {
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
    this.update();
  }

  /**
   * Keep what is framed clear of panels over the top and bottom of a `width` × `height` canvas
   * (pixels): the view's middle moves to the middle of the space between them (a lens shift, so
   * orbiting still turns about it), and `frame` fits into that space. Zeros undo it.
   */
  setInsets(top: number, bottom: number, width: number, height: number) {
    const shift = Math.round((bottom - top) / 2);
    this.inset = { shift, width, height, visible: Math.max(0.2, (height - top - bottom) / height) };
    for (const camera of [this.perspective, this.orthographic]) {
      if (shift) camera.setViewOffset(width, height, 0, shift, width, height);
      else camera.clearViewOffset();
    }
    this.update();
  }

  /** Run `fn` with the view centred on the canvas again (for pictures of the whole canvas). */
  centred<T>(fn: () => T): T {
    const { shift, width, height } = this.inset;
    if (!shift) return fn();
    for (const camera of [this.perspective, this.orthographic]) camera.clearViewOffset();
    try {
      return fn();
    } finally {
      for (const camera of [this.perspective, this.orthographic]) camera.setViewOffset(width, height, 0, shift, width, height);
    }
  }

  update() {
    const halfHeight = this.halfHeight;
    const halfWidth = halfHeight * this.perspective.aspect;
    this.orthographic.left = -halfWidth;
    this.orthographic.right = halfWidth;
    this.orthographic.top = halfHeight;
    this.orthographic.bottom = -halfHeight;
    this.orthographic.updateProjectionMatrix();
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + this.distance * cp * Math.sin(this.yaw),
      this.target.y + this.distance * Math.sin(this.pitch),
      this.target.z + this.distance * cp * Math.cos(this.yaw),
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }
}
