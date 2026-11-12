// The model in the headset: drawing on it with the brush, holding it in one hand or both, and
// spinning it by the turntable ring. Each is a target for the router (`../interaction.ts`) and
// what a hand does with it is an interaction it captures.

import { Box3, Vector3, type Group } from "three";
import type { Editor } from "@voxeltoy/core/editor";
import type { Vec3 } from "@voxeltoy/core/types";
import type { XRHand } from "../input";
import type { FocusedHit, Hit, Interaction, Reach, Router, Target, Trigger } from "../interaction";
import { ringDistance, Turntable, WorkspaceGrab, workspaceUp } from "../workspace";
import { boxCells, clampCell, layerCell, rayCell, type CellOp, type RayCell, type XRReach } from "./reach";

/** A pinch, trigger or grip this close to the turntable ring (metres) takes hold of it, to spin the model; once at it, until `RING_LEAVE`. */
const RING_REACH = 0.04;
const RING_LEAVE = 0.06;
/** Pinches of both hands this close together (ms) hold the model with both, to turn and scale it. */
const TOGETHER = 300;

/** Drawing: the brush follows the hand's tip, every cell it sweeps through one undo step. */
export class Stroke implements Interaction {
  constructor(private tool: VoxelTool) {}

  update(hand: XRHand) {
    const t = performance.now();
    this.tool.editor.spatial.to(this.tool.point(hand));
    this.tool.stats.edit = Math.max(this.tool.stats.edit, performance.now() - t);
  }

  end() {
    this.tool.editor.spatial.end();
  }

  cancel() {
    this.tool.editor.spatial.cancel();
  }

  /** After a gap in tracking, lift the brush and put it down where the hand is: no line across the gap. */
  resume(hand: XRHand) {
    this.tool.editor.spatial.end();
    this.tool.editor.spatial.begin(this.tool.point(hand));
  }
}

/** Holding the model, alone or with the other hand. */
export class Hold implements Interaction {
  constructor(
    private model: ModelHandles,
    private hand: XRHand,
  ) {
    model.holders.add(hand);
    model.regrab();
  }

  end() {
    this.model.holders.delete(this.hand);
    this.model.regrab();
  }

  cancel() {
    this.end();
  }

  /** After a gap in tracking, take hold again where the hand is: the model stays put. */
  resume() {
    this.model.regrab();
  }
}

/** Spinning the model by its ring, like a turntable. */
export class Spin implements Interaction {
  constructor(
    private model: ModelHandles,
    private hand: XRHand,
  ) {
    model.spinner = hand;
    model.turntable.set(reachOf(hand), model.workspace.matrix);
  }

  end() {
    if (this.model.spinner !== this.hand) return;
    this.model.spinner = null;
    this.model.turntable.set(null, this.model.workspace.matrix);
  }

  cancel() {
    this.end();
  }

  resume(hand: XRHand) {
    this.model.turntable.set(reachOf(hand), this.model.workspace.matrix);
  }
}

/** Where a hand reaches for the ring: a hand's pinch, a controller's tip. */
const reachOf = (hand: XRHand) => (hand.isHand ? hand.handle : hand.tip);

/**
 * Where the model is in the room, and the hands that move it: holding it (one hand carries it, two
 * move, turn, tip and scale it) and the turntable ring under it.
 */
export class ModelHandles {
  readonly grab = new WorkspaceGrab();
  readonly turntable = new Turntable();
  readonly holders = new Set<XRHand>();
  spinner: XRHand | null = null;
  /** The ring's radius, in voxels about the grid's base center. */
  ringRadius = 1;
  /** A hand is at the ring (it lights). */
  ringHot = false;

  constructor(
    readonly workspace: Group,
    private router: Router,
  ) {}

  /** The ring, as a target: a hand at it takes hold of it there. */
  readonly ring: Target = {
    hit: (hand: XRHand, prev: Reach | null): Hit | null => {
      if (!hand.tracking) return null;
      const center = new Vector3().setFromMatrixPosition(this.workspace.matrix);
      const scale = new Vector3().setFromMatrixScale(this.workspace.matrix).x;
      const d = ringDistance(reachOf(hand), center, this.ringRadius * scale, workspaceUp(this.workspace.matrix));
      if (d > (prev === "grab" ? RING_LEAVE : RING_REACH)) return null;
      return { target: this.ring, reach: "grab", distance: d, press: (h, t) => t !== "poke" && this.spin(h) };
    },
    focus: (hits: readonly FocusedHit[]) => {
      this.ringHot = hits.length > 0;
    },
  };

  /** Hold the model with `hand`. Holding it lets go of the ring. */
  hold(hand: XRHand): Hold {
    if (this.spinner) this.router.cancel(this.spinner);
    return new Hold(this, hand);
  }

  /** Spin the model by the ring with `hand`. Hands holding the model let go first. */
  spin(hand: XRHand): Spin {
    for (const h of this.router.hands) if (this.router.captureOf(h)?.interaction instanceof Hold) this.router.cancel(h);
    if (this.spinner && this.spinner !== hand) this.router.cancel(this.spinner);
    return new Spin(this, hand);
  }

  /** The hands holding it changed, or the model moved under them: the grab starts over from where it is. */
  regrab() {
    this.grab.set(
      [...this.holders].map((h) => ({ point: h.handle, rotation: h.rotation })),
      this.workspace.matrix,
    );
  }

  /** Where the hands put the model this frame, if they hold it. */
  update() {
    return this.grab.update() ?? this.turntable.update();
  }
}

/** What the tool asks of the view: how the palette has it set, and which hand carries the palette. */
export interface ToolHost {
  /** The voxel tool the palette has on, or null when it isn't drawing (Move, or nothing offered). */
  op(): CellOp | null;
  /** How the drawing hand reaches cells. */
  reach(): XRReach;
  isPaletteHand(hand: XRHand): boolean;
  /** A press in free space while the tool isn't drawing: the scene's, if it takes it. */
  press?(hand: XRHand): Interaction | boolean | null;
}

/** Drawing along the ray: the brush on the cell the ray points at, keeping to the layer of cells the stroke started on. */
export class RayStroke implements Interaction {
  /** The cell the brush is on. */
  cell: Vec3;
  /**
   * From where the ray crosses the layer (through the cells' middles, half a cell past the face it
   * hit) to the cell it pointed at: a hand held still keeps to that one cell.
   */
  private offset: Vec3 = [0, 0, 0];

  constructor(
    private tool: VoxelTool,
    private layer: { axis: 0 | 1 | 2; level: number },
    start: Vec3,
    hand: XRHand,
  ) {
    this.cell = start;
    const crossing = this.crossing(hand);
    if (crossing) this.offset = start.map((n, a) => n - crossing[a]) as Vec3;
  }

  private crossing(hand: XRHand): Vec3 | null {
    const { origin, dir } = this.tool.voxelRay(hand);
    return layerCell(origin, dir, this.layer.axis, this.layer.level, null);
  }

  update(hand: XRHand) {
    const t = performance.now();
    const crossing = this.crossing(hand);
    const cell = crossing ? (crossing.map((n, a) => n + this.offset[a]) as Vec3) : null;
    if (cell && this.tool.editor.inBounds(cell) && cell.some((n, a) => n !== this.cell[a])) {
      this.cell = cell;
      this.tool.editor.spatial.to(center(cell));
    }
    this.tool.stats.edit = Math.max(this.tool.stats.edit, performance.now() - t);
  }

  end() {
    this.tool.editor.spatial.end();
  }

  cancel() {
    this.tool.editor.spatial.cancel();
  }
}

/** A box from the cell the tip went down in to the cell it is in: filled, erased or painted as one undo step when let go. */
export class BoxDraw implements Interaction {
  /** The box's corners, in cells. */
  readonly from: Vec3;
  to: Vec3;

  constructor(
    private tool: VoxelTool,
    private op: CellOp,
    hand: XRHand,
  ) {
    this.from = tool.tipCell(hand);
    this.to = this.from;
  }

  update(hand: XRHand) {
    this.to = this.tool.tipCell(hand);
  }

  end() {
    const { editor } = this.tool;
    const t = performance.now();
    editor.beginStroke(this.op === "add" ? "Fill box" : this.op === "erase" ? "Erase box" : "Paint box");
    editor.applyCells(boxCells(this.from, this.to), this.op);
    editor.endStroke();
    this.tool.stats.edit = Math.max(this.tool.stats.edit, performance.now() - t);
  }
}

/** The middle of a cell. */
const center = (cell: Vec3): Vec3 => [cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5];

/**
 * The brush, as the app's tool. With the tip, it is the router's last resort ("free"), so a hand at
 * a window, the palette or the ring works those instead; along the ray, it is a ray hit as far off
 * as the face it points at, so a window in front of the model takes the ray and one behind it
 * doesn't. Pinching or the trigger draws with the drawing hand (a stroke at the tip, a stroke
 * across the layer the ray points at, or a box); the palette hand holds the model, both hands
 * pinched together hold it with both. While the palette isn't on a voxel tool, the drawing hand
 * holds the model too, unless the scene takes the press.
 */
export class VoxelTool implements Target {
  readonly stats = { edit: 0 };

  constructor(
    readonly editor: Editor,
    private router: Router,
    private model: ModelHandles,
    private voxels: Group,
    private host: ToolHost,
  ) {}

  hit(hand: XRHand): Hit | null {
    if (!hand.tracking) return null;
    const press = (h: XRHand, t: Trigger) => this.press(h, t);
    const aim = this.aim(hand);
    if (aim) {
      const point = this.voxels.localToWorld(new Vector3(...aim.origin).addScaledVector(new Vector3(...aim.dir), aim.target.distance));
      return { target: this, reach: "ray", distance: point.distanceTo(hand.ray.origin), point, press };
    }
    return { target: this, reach: "free", distance: 0, press };
  }

  /** The brush tip of `hand`, in voxel space. */
  point(hand: XRHand): Vec3 {
    const p = this.voxels.worldToLocal(hand.tip.clone());
    return [p.x, p.y, p.z];
  }

  /** The cell `hand`'s tip is in, or the nearest one in the grid. */
  tipCell(hand: XRHand): Vec3 {
    return clampCell(this.point(hand), this.editor.size);
  }

  /** `hand`'s ray in voxel space (its direction a unit vector there). */
  voxelRay(hand: XRHand): { origin: Vec3; dir: Vec3 } {
    const inv = this.voxels.matrixWorld.clone().invert();
    const o = hand.ray.origin.clone().applyMatrix4(inv);
    const d = hand.ray.direction.clone().transformDirection(inv);
    return { origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z] };
  }

  /**
   * Where `hand`'s ray would draw: the cell, its layer and how far along (voxel units), with the
   * ray. Null with another reach, for the palette hand, or with nothing to change.
   */
  aim(hand: XRHand): { target: RayCell; origin: Vec3; dir: Vec3 } | null {
    const op = this.host.op();
    if (!op || this.host.reach() !== "ray" || this.host.isPaletteHand(hand) || !hand.tracking) return null;
    const ray = this.voxelRay(hand);
    const composite = this.editor.composite;
    const target = rayCell(ray.origin, ray.dir, this.editor.size, (i) => composite[i] !== 0, op);
    return target ? { ...ray, target } : null;
  }

  /** How far `hand`'s reach is from the model's grid, in metres (0 inside it). */
  fromModel(hand: XRHand) {
    const p = this.voxels.worldToLocal(reachOf(hand).clone());
    const size = this.editor.size;
    const box = new Box3(new Vector3(0, 0, 0), new Vector3(size[0], size[1], size[2]));
    const scale = new Vector3().setFromMatrixScale(this.voxels.matrixWorld).x;
    return box.distanceToPoint(p) * scale;
  }

  private press(hand: XRHand, trigger: Trigger): Interaction | boolean {
    if (trigger === "poke") return false;
    // a controller's grip holds the model
    if (trigger === "squeeze") return this.model.hold(hand);
    const { router } = this;
    const other = router.hands.find((h) => h !== hand);
    const theirs = other ? router.captureOf(other) : null;
    const drawing = isDrawing(theirs?.interaction);
    const palette = this.host.isPaletteHand(hand);
    if (hand.isHand) {
      // the palette hand holds the model and the other draws (on it, while it is held). Both
      // hold it, to turn and scale it, when they pinch together, or when the palette hand pinches
      // while the other draws (that stroke is taken back and becomes a hold)
      const joins = !!other?.isHand && theirs?.interaction instanceof Hold && performance.now() - theirs.since < TOGETHER;
      if (palette || joins) {
        if (other && drawing) router.take(other, this.model.hold(other), { target: this });
        return this.model.hold(hand);
      }
    } else if (palette) {
      // the palette's controller doesn't draw
      return true;
    }
    // a second trigger while the other hand draws takes that stroke back
    if (other && drawing) {
      router.cancel(other);
      return true;
    }
    const op = this.host.op();
    if (!op) return this.host.press?.(hand) || this.model.hold(hand);
    const blocker = this.editor.editBlocker();
    if (blocker) {
      this.editor.notify(blocker);
      return true;
    }
    const reach = this.host.reach();
    if (reach === "box") return new BoxDraw(this, op, hand);
    if (reach === "ray") {
      const aim = this.aim(hand);
      if (!aim) return true;
      const { cell, axis, level } = aim.target;
      if (!this.editor.spatial.begin(center(cell), op)) return true;
      return new RayStroke(this, { axis, level }, cell, hand);
    }
    if (!this.editor.spatial.begin(this.point(hand), op)) return true;
    return new Stroke(this);
  }
}

/** Whether a hand is drawing: a stroke at the tip or along the ray, or a box. */
export const isDrawing = (i: Interaction | undefined) => i instanceof Stroke || i instanceof RayStroke || i instanceof BoxDraw;
