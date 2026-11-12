import { Group, Quaternion, Ray, Vector3, type Object3D, type WebGLRenderer, type XRGripSpace, type XRHandSpace, type XRTargetRaySpace } from "three";
import { PointFilter } from "./smoothing";

/** How far ahead of a controller its tip is, in metres. */
export const CONTROLLER_TIP = 0.05;

/**
 * One hand: a controller or a tracked hand (Quest switches between them as the controllers are put
 * down or picked up), as plain state the rest reads each frame: where it points, where it holds,
 * its fingertip. What it does with them is the router's (`interaction.ts`). `bindHand` fills it in
 * from a session; tests set the fields themselves.
 */
export class XRHand {
  source: XRInputSource | null = null;
  /** Its pose is known this frame. */
  tracking = false;
  /** When it was last tracked (`performance.now()`). */
  seenAt = 0;
  /** Where it points from and along, in the room. */
  readonly ray = new Ray(new Vector3(), new Vector3(0, 0, -1));
  /** Where it holds: a hand's pinch (between thumb and index tips, unsmoothed), a controller's grip. */
  readonly handle = new Vector3();
  /** Its tip, for drawing: the pinch through a One Euro filter, or a little ahead of a controller. */
  readonly tip = new Vector3();
  /** A tracked hand's index fingertip, for pushing buttons. Null for a controller, or while it is hidden. */
  finger: Vector3 | null = null;
  /** How the wrist (or a controller's grip) is turned. */
  readonly rotation = new Quaternion();
  /** Follows the wrist or grip, in the scene's root: what the hand carries (a palette) goes in it. */
  readonly anchor = new Group();

  constructor(readonly index: number) {
    this.anchor.matrixAutoUpdate = false;
    this.anchor.visible = false;
  }

  /** A tracked hand, not a controller. */
  get isHand() {
    return !!this.source?.hand;
  }

  get handedness(): XRHandedness {
    return this.source?.handedness ?? "none";
  }

  /** A controller's buttons and thumbstick (none for a tracked hand). */
  get gamepad(): Gamepad | null {
    return this.isHand ? null : (this.source?.gamepad ?? null);
  }
}

export interface HandEvents {
  connect(hand: XRHand): void;
  disconnect(hand: XRHand): void;
  down(hand: XRHand, trigger: "select" | "squeeze"): void;
  up(hand: XRHand, trigger: "select" | "squeeze"): void;
}

/**
 * Wire `hand` to input source `index` of `renderer`'s session: its spaces go in `root` (so their
 * matrices are world matrices), and `update` reads its pose once a frame.
 */
export function bindHand(renderer: WebGLRenderer, hand: XRHand, root: Object3D, events: HandEvents) {
  const xr = renderer.xr;
  const ray: XRTargetRaySpace = xr.getController(hand.index);
  const grip: XRGripSpace = xr.getControllerGrip(hand.index);
  const joints: XRHandSpace = xr.getHand(hand.index);
  const smooth = new PointFilter();
  const finger = new Vector3();
  const v = new Vector3();
  root.add(ray, grip, joints, hand.anchor);

  ray.addEventListener("connected", (e) => {
    hand.source = e.data;
    smooth.reset();
    events.connect(hand);
  });
  ray.addEventListener("disconnected", () => {
    events.disconnect(hand);
    hand.source = null;
    hand.tracking = false;
    hand.finger = null;
    hand.anchor.visible = false;
  });
  ray.addEventListener("selectstart", () => events.down(hand, "select"));
  ray.addEventListener("selectend", () => events.up(hand, "select"));
  ray.addEventListener("squeezestart", () => events.down(hand, "squeeze"));
  ray.addEventListener("squeezeend", () => events.up(hand, "squeeze"));

  return {
    /** The target ray's space: things that point with the hand (its pointer line) go in it. */
    raySpace: ray,
    update(time: number) {
      hand.tracking = false;
      hand.finger = null;
      if (!hand.source) {
        hand.anchor.visible = false;
        return;
      }
      // the anchor: a tracked hand's wrist (three.js doesn't move the grip for hands), a controller's grip
      const wrist = hand.isHand ? joints.joints["wrist"] : null;
      const from = hand.isHand ? (wrist?.visible ? wrist : null) : grip.visible ? grip : null;
      hand.anchor.visible = !!from;
      if (from) {
        hand.anchor.matrix.copy(from.matrix);
        hand.anchor.updateMatrixWorld(true);
        hand.rotation.setFromRotationMatrix(from.matrix);
      }
      if (ray.visible) {
        hand.ray.origin.setFromMatrixPosition(ray.matrix);
        hand.ray.direction.set(0, 0, -1).transformDirection(ray.matrix);
      }
      if (hand.isHand) {
        const thumb = joints.joints["thumb-tip"];
        const index = joints.joints["index-finger-tip"];
        if (!thumb?.visible || !index?.visible) return;
        hand.handle.setFromMatrixPosition(thumb.matrix).add(v.setFromMatrixPosition(index.matrix)).multiplyScalar(0.5);
        hand.tip.copy(smooth.filter(hand.handle, time / 1000));
        hand.finger = finger.setFromMatrixPosition(index.matrix);
      } else {
        if (!ray.visible) return;
        hand.handle.setFromMatrixPosition(hand.anchor.visible ? hand.anchor.matrix : ray.matrix);
        hand.tip.set(0, 0, -CONTROLLER_TIP).applyMatrix4(ray.matrix);
      }
      hand.tracking = true;
      hand.seenAt = performance.now();
    },
  };
}
