// The palette on the hand: tool and how it reaches, colors, brush size, undo and redo, Fit (and
// Life size), and a button for each window.

import { Matrix4, Vector3, type ColorSpace } from "three";
import type { Editor } from "@voxeltoy/core/editor";
import type { XRHand } from "../input";
import { Panel, type Control } from "../panel";
import { PanelTarget } from "../surface";
import type { XRWindows } from "../windows";
import type { XRReach, XRTool } from "./reach";

/** A palm turned at least this much toward the eyes (cosine) shows the palette. */
const PALM_FACING = 0.25;
/** How long a notice shows (ms). */
const NOTICE_MS = 3500;
/** The palette's size (millimetres): it fills a palm. */
const WIDTH = 120;
const HEIGHT = 186;

/** A color the palette offers: the value it paints with, how it looks, and its name. */
export interface XRSwatch {
  value: number;
  color: number;
  label: string;
}

const TOOL_LABELS: Record<XRTool, string> = { add: "Add", erase: "Erase", paint: "Paint", move: "Move" };
const REACH_LABELS: Record<XRReach, string> = { tip: "Tip", ray: "Ray", box: "Box" };

export interface PaletteHost {
  editor: Editor;
  windows: XRWindows;
  /** The windows the palette has a button for, in order, with their labels. */
  windowButtons: { id: string; label: string }[];
  fit(): void;
  colorSpace: ColorSpace;
  /** The tools it offers, and the one on (null: none of them). */
  tools(): readonly XRTool[];
  tool(): XRTool | null;
  setTool(tool: XRTool): void;
  /** How the drawing hand reaches cells. */
  reach(): XRReach;
  setReach(reach: XRReach): void;
  /** The colors it offers. */
  swatches(): readonly XRSwatch[];
  /** Life size, when the host has one: whether it is on, and turning it on or off. */
  life?: { on(): boolean; toggle(): void };
}

/**
 * The palette rides on one hand (`attach`): flat on a tracked hand's palm, showing while the palm
 * faces you; above a controller's grip, always. The other hand works it.
 */
export class Palette {
  readonly panel: Panel;
  readonly target: PanelTarget;
  private page = 0;
  private notice = "";
  private noticeTimer = 0;
  private hand: XRHand | null = null;

  constructor(private host: PaletteHost) {
    this.panel = new Panel({ width: WIDTH, height: HEIGHT, density: 4, radius: 7, overlay: true, colorSpace: host.colorSpace, layout: (w) => this.layout(w) });
    // not from the hand it rides on, nor while that hand isn't seen
    this.target = new PanelTarget(this.panel, { available: (hand) => !!this.hand && hand !== this.hand && this.hand.anchor.visible });
  }

  /** The hand it rides on. */
  get on() {
    return this.hand;
  }

  /** Put it on `hand`, or take it off (null). */
  attach(hand: XRHand | null) {
    const mesh = this.panel.mesh;
    mesh.removeFromParent();
    this.hand = hand;
    if (!hand) return;
    if (hand.isHand) {
      // flat on the palm like a painter's palette: facing out of the palm (the wrist's -Y), its
      // top toward the fingers (-Z), a little off the skin; turned 45° clockwise as you look at a
      // right palm (counterclockwise on a left), for a natural angle
      const turn = new Matrix4().makeRotationZ(((hand.handedness === "right" ? -1 : 1) * Math.PI) / 4);
      mesh.matrix
        .makeBasis(new Vector3(-1, 0, 0), new Vector3(0, 0, -1), new Vector3(0, -1, 0))
        .multiply(turn)
        .setPosition(0, -0.03, -0.08);
    } else {
      // a controller fills the palm: above the back of the wrist, tilted toward the eyes
      mesh.matrix.makeRotationX(-Math.PI / 3).setPosition(0, 0.07, 0.02);
    }
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldNeedsUpdate = true;
    hand.anchor.add(mesh);
    this.panel.redraw();
  }

  /** On a palm, it shows while the palm faces `eyes`; on a controller, always. */
  updateShown(eyes: Vector3 | undefined) {
    const mesh = this.panel.mesh;
    if (!this.hand?.isHand || !eyes) {
      mesh.visible = true;
      return;
    }
    mesh.updateMatrixWorld();
    const palm = new Vector3().setFromMatrixPosition(mesh.matrixWorld);
    const facing = new Vector3(0, 0, 1).transformDirection(mesh.matrixWorld);
    mesh.visible = facing.dot(eyes.clone().sub(palm).normalize()) > PALM_FACING;
  }

  /** Show `message` under the buttons for a moment. */
  notify(message: string) {
    this.notice = message;
    this.panel.redraw();
    clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.notice = "";
      this.panel.redraw();
    }, NOTICE_MS);
  }

  dispose() {
    clearTimeout(this.noticeTimer);
    this.panel.mesh.removeFromParent();
    this.panel.dispose();
  }

  private layout(w: number): Control[] {
    const { editor, windows } = this.host;
    const pad = 6;
    const gap = 3;
    const inner = w - pad * 2;
    const row = (y: number, h: number, items: Omit<Control, "x" | "y" | "w" | "h">[]) => {
      const bw = (inner - gap * (items.length - 1)) / items.length;
      return items.map((item, i) => ({ ...item, x: pad + i * (bw + gap), y, w: bw, h }));
    };
    const tool = this.host.tool();
    const drawing = !!tool && tool !== "move";
    const controls: Control[] = row(
      pad,
      16,
      this.host.tools().map((t) => ({ id: t, label: TOOL_LABELS[t], active: tool === t, onPress: () => this.host.setTool(t) })),
    );
    // how the drawing hand reaches: only for the voxel tools
    const reach = this.host.reach();
    controls.push(
      ...row(
        25,
        12,
        (["tip", "ray", "box"] as const).map((r) => ({ id: `reach:${r}`, label: REACH_LABELS[r], active: drawing && reach === r, disabled: !drawing, onPress: () => this.host.setReach(r) })),
      ),
    );

    // the colors, 32 a page
    const swatches = this.host.swatches();
    const pages = Math.max(1, Math.ceil(swatches.length / 32));
    const page = Math.min(this.page, pages - 1);
    const cols = 8;
    const sgap = 2;
    const sw = (inner - (cols - 1) * sgap) / cols;
    const top = 41;
    swatches.slice(page * 32, page * 32 + 32).forEach((s, n) => {
      controls.push({
        id: `color:${n}`,
        x: pad + (n % cols) * (sw + sgap),
        y: top + Math.floor(n / cols) * (sw + sgap),
        w: sw,
        h: sw,
        label: s.label,
        color: s.color,
        active: editor.color === s.value,
        disabled: !drawing && tool !== null,
        onPress: () => editor.setColor(s.value),
      });
    });
    // under them, the color's name, with pages either side
    const flip = (delta: number) => () => {
      this.page = (page + delta + pages) % pages;
      this.panel.redraw();
    };
    const chosen = swatches.find((s) => s.value === editor.color);
    const nameY = top + 4 * (sw + sgap) + 1;
    controls.push({ id: "color-name", x: pad + 14, y: nameY, w: inner - 28, h: 10, label: chosen?.label ?? "", font: 5.5 });
    if (pages > 1) {
      controls.push(
        { id: "colors-prev", x: pad, y: nameY, w: 12, h: 10, label: "‹", onPress: flip(-1) },
        { id: "colors-next", x: pad + inner - 12, y: nameY, w: 12, h: 10, label: "›", onPress: flip(1) },
      );
    }

    const size = editor.spatial.size;
    const life = this.host.life;
    controls.push(
      ...row(113, 15, [
        { id: "smaller", label: "−", disabled: size <= 1 || !drawing, onPress: () => editor.spatial.setSize(size - 1) },
        { id: "size", label: `Size ${size}` },
        { id: "bigger", label: "+", disabled: !drawing, onPress: () => editor.spatial.setSize(size + 1) },
      ]),
      ...row(132, 15, [
        { id: "undo", label: "Undo", disabled: !editor.canUndo, onPress: () => editor.undo() },
        { id: "redo", label: "Redo", disabled: !editor.canRedo, onPress: () => editor.redo() },
        { id: "fit", label: "Fit", onPress: () => this.host.fit() },
        ...(life ? [{ id: "life", label: "Life", active: life.on(), onPress: () => life.toggle() }] : []),
      ]),
      // the windows, shown or not
      ...row(
        151,
        13,
        this.host.windowButtons.map((b) => ({ id: `window:${b.id}`, label: b.label, active: windows.shown(b.id), onPress: () => windows.show(b.id) })),
      ),
    );
    if (this.notice) controls.push({ id: "notice", x: pad, y: 167, w: inner, h: 8, label: this.notice, font: 5 });
    return controls;
  }
}
