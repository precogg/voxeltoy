import { CanvasTexture, DoubleSide, Mesh, MeshBasicMaterial, NoColorSpace, PlaneGeometry, Vector2, type ColorSpace } from "three";
import { drawIcon, type IconName } from "./icons";

/**
 * A control on a panel: what it is (its id and name), where (millimetres from the content's top
 * left), how it looks, and what pressing it does. Layouts make them afresh on every redraw; the id
 * is what stands for one across redraws, so hover, a press under way and `Panel.activate` follow it.
 */
export interface Control {
  /** Stands for it across redraws: unique on its panel. */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Its name, and the text it shows (unless `iconOnly`). */
  label?: string;
  icon?: IconName;
  /** Show the icon alone: the label is its name, shown as a tip while a hand is at it (as a swatch's is). */
  iconOnly?: boolean;
  /** A swatch's color (0xrrggbb): the whole control is the color. */
  color?: number;
  /** A small color dot before the label (a CSS color). */
  swatch?: string;
  /** Muted text at the end of the row. */
  detail?: string;
  /** On, or the one chosen: the accent fill. */
  active?: boolean;
  /** A check before the label: a menu's choice. */
  checked?: boolean;
  danger?: boolean;
  /** A dim label: a hidden layer. */
  muted?: boolean;
  disabled?: boolean;
  align?: "center" | "left";
  /** No fill at rest: a row of a list. */
  flat?: boolean;
  /** Label size in millimetres; by default it follows the height. */
  font?: number;
  /** A time ruler drawn in it: a segment per pose, as long as it shows, `at` lit. */
  track?: { durations: readonly number[]; at: number };
  /** Pressed. A control with neither this nor `onDrag` is only shown (a title, a readout). */
  onPress?(): void;
  /** As it is pressed and while held and moved, with where along it (0 to 1, left to right and top to bottom; beyond, off it). It holds the hand until let go. */
  onDrag?(fx: number, fy: number): void;
  /** A held control let go. */
  onRelease?(): void;
  /** A held control taken back (tracking lost, the session hidden): undo what the hold did, if it can. */
  onCancel?(): void;
}

/** Whether pressing it does anything. */
export const pressable = (c: Control) => !c.disabled && !!(c.onPress || c.onDrag);

/** What is at a point on a panel: a control, the frame around it, or the rest of its face. */
export type PanelRegion =
  | { kind: "control"; control: Control; /** Where on it, 0 to 1 across and down. */ fx: number; fy: number }
  | { kind: "frame" }
  | { kind: "content" };

export interface PanelOptions {
  /** The whole panel, frame included, in millimetres. */
  width: number;
  height: number;
  /** The controls for the content's size (millimetres), from the current state. */
  layout(width: number, height: number): Control[];
  /**
   * Canvas pixels per millimetre. About 2.5 reads well at arm's length on a Quest 3; nearer (a
   * palette on the palm), 4.
   */
  density?: number;
  /** A frame to take hold of the panel by: a margin around the content and a bar under it (millimetres). */
  frame?: { margin: number; bar: number };
  /** Corner radius of the content's card (millimetres). */
  radius?: number;
  /** Drawn over everything (a palette on the hand). Otherwise what is in front of it hides it. */
  overlay?: boolean;
  /** How the canvas's pixels are read: as drawn (`NoColorSpace`, for a session that renders linear) or sRGB. */
  colorSpace?: ColorSpace;
}

export type FrameState = "rest" | "hot" | "held";

/**
 * A flat panel of controls floating in the scene, drawn to a canvas: sized in millimetres, so a
 * control is as big in the room as its numbers say. `region` finds what is at a point on it (by
 * uv); `activate` presses a control by its id, for scripts and other ways in than a hand.
 */
export class Panel {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly texture: CanvasTexture;
  readonly width: number;
  readonly height: number;
  /** The content's size (millimetres): the panel less its frame. */
  readonly contentWidth: number;
  readonly contentHeight: number;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private density: number;
  private radius: number;
  private layoutFn: PanelOptions["layout"];
  private list: Control[] = [];
  private hovered = "";
  private footer = "";
  /** A control just pressed, lit for a moment. */
  private flashed = "";
  private frameState: FrameState = "rest";
  private look = "";
  private margin: number;
  private bar: number;

  constructor(options: PanelOptions) {
    this.width = options.width;
    this.height = options.height;
    this.layoutFn = options.layout;
    this.density = options.density ?? 2.5;
    this.radius = options.radius ?? 14;
    this.margin = options.frame?.margin ?? 0;
    this.bar = options.frame?.bar ?? 0;
    this.contentWidth = this.width - this.margin * 2;
    this.contentHeight = this.height - this.margin - Math.max(this.margin, this.bar);
    this.canvas = document.createElement("canvas");
    this.canvas.width = Math.round(this.width * this.density);
    this.canvas.height = Math.round(this.height * this.density);
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = options.colorSpace ?? NoColorSpace;
    const overlay = options.overlay ?? false;
    this.mesh = new Mesh(
      new PlaneGeometry(this.width / 1000, this.height / 1000),
      new MeshBasicMaterial({ map: this.texture, transparent: true, side: DoubleSide, depthTest: !overlay, depthWrite: false }),
    );
    this.mesh.renderOrder = overlay ? 10 : 5;
    this.redraw();
  }

  get framed() {
    return this.margin > 0;
  }

  /** The controls as last laid out. */
  get controls(): readonly Control[] {
    return this.list;
  }

  control(id: string): Control | undefined {
    return this.list.find((c) => c.id === id);
  }

  /** Where `uv` (on the panel's plane) is in the content, in millimetres. */
  private at(uv: Vector2) {
    return { x: uv.x * this.width - this.margin, y: (1 - uv.y) * this.height - this.margin };
  }

  /** What is at `uv` on the panel's plane, if anything. */
  region(uv: Vector2 | undefined): PanelRegion | null {
    if (!uv) return null;
    const { x, y } = this.at(uv);
    if (x < 0 || y < 0 || x > this.contentWidth || y > this.contentHeight) {
      return this.framed && uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1 ? { kind: "frame" } : null;
    }
    const control = this.list.find((c) => pressable(c) && x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h);
    return control ? { kind: "control", control, fx: (x - control.x) / control.w, fy: (y - control.y) / control.h } : { kind: "content" };
  }

  /** Where `uv` is along `control` (0 to 1 across and down, beyond them off it): a drag that strays off it keeps going. */
  along(control: Control, uv: Vector2) {
    const { x, y } = this.at(uv);
    return { fx: (x - control.x) / control.w, fy: (y - control.y) / control.h };
  }

  /** Press control `id` as a tap would: false if there is none, or it can't be pressed. */
  activate(id: string): boolean {
    this.redraw();
    const c = this.control(id);
    if (!c || !pressable(c)) return false;
    this.flash(c.id);
    c.onPress?.();
    if (c.onDrag) {
      c.onDrag(0.5, 0.5);
      c.onRelease?.();
    }
    return true;
  }

  /** Light control `id` (a hand is at it, or holds it); null for none. */
  hover(id: string | null) {
    const key = id ?? "";
    if (key === this.hovered) return;
    this.hovered = key;
    this.paint();
  }

  /** Light control `id` for a moment: it was pressed. */
  flash(id: string) {
    this.flashed = id;
    this.paint();
    setTimeout(() => {
      if (this.flashed !== id) return;
      this.flashed = "";
      this.paint();
    }, 160);
  }

  /** How the frame shows: faint at rest, lit with a hand at it, bright while held. */
  setFrame(state: FrameState) {
    if (state === this.frameState) return;
    this.frameState = state;
    this.paint();
  }

  /** A line of small text along the bottom (timings). */
  setFooter(text: string) {
    if (text === this.footer) return;
    this.footer = text;
    this.paint();
  }

  /**
   * Lay the controls out again from the current state, and draw them if they look different
   * (drawing uploads the canvas, so a redraw that changes nothing costs little).
   */
  redraw() {
    this.list = this.layoutFn(this.contentWidth, this.contentHeight);
    // functions drop out: what is drawn, not what pressing does
    const look = JSON.stringify(this.list.map((c) => [c, pressable(c)]));
    if (look === this.look) return;
    this.look = look;
    this.paint();
  }

  private paint() {
    const { ctx, margin: m, contentWidth: w, contentHeight: h } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // everything below is in millimetres
    ctx.setTransform(this.density, 0, 0, this.density, 0, 0);
    if (this.framed) this.paintFrame();
    ctx.save();
    ctx.translate(m, m);
    roundRect(ctx, 0, 0, w, h, this.radius);
    ctx.fillStyle = "rgba(24, 25, 28, 0.9)";
    ctx.fill();
    ctx.textBaseline = "middle";
    for (const c of this.list) this.paintControl(c);
    if (this.footer) {
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.font = "5px ui-monospace, monospace";
      ctx.fillText(this.footer, w / 2, h - 5.5);
    }
    const tip = this.list.find((c) => c.id === this.hovered && (c.iconOnly || c.color !== undefined) && c.label && pressable(c));
    if (tip) this.paintTip(tip);
    ctx.restore();
    this.texture.needsUpdate = true;
  }

  /** The bar under the content, always; a rim around it with a hand at it or holding it. */
  private paintFrame() {
    const { ctx, margin: m, contentWidth: w, contentHeight: h, frameState: state } = this;
    const lit = state === "held" ? 0.95 : state === "hot" ? 0.7 : 0;
    if (lit) {
      const inset = m * 0.4;
      roundRect(ctx, inset, inset, w + (m - inset) * 2, h + (m - inset) * 2, this.radius + m - inset);
      ctx.lineWidth = state === "held" ? 3.5 : 2.5;
      ctx.strokeStyle = `rgba(255,255,255,${lit * 0.8})`;
      ctx.stroke();
    }
    const barW = Math.min(w * 0.36, 120);
    const barH = 8;
    const space = Math.max(m, this.bar);
    roundRect(ctx, m + (w - barW) / 2, m + h + (space - barH) / 2, barW, barH, barH / 2);
    ctx.fillStyle = `rgba(255,255,255,${state === "rest" ? 0.5 : 0.95})`;
    ctx.fill();
  }

  private paintControl(c: Control) {
    const { ctx } = this;
    const live = pressable(c);
    const hot = live && c.id === this.hovered;
    const lit = c.id === this.flashed;
    if (c.track) {
      this.paintTrack(c, c.track, hot);
      return;
    }
    if (c.color !== undefined) {
      roundRect(ctx, c.x, c.y, c.w, c.h, Math.min(2, c.h / 4));
      ctx.fillStyle = `#${c.color.toString(16).padStart(6, "0")}`;
      ctx.fill();
      if (c.active || hot || lit) {
        ctx.lineWidth = c.active || lit ? 1.4 : 0.7;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
      }
      return;
    }
    const shown = !!(c.onPress || c.onDrag);
    if (shown) {
      const fill = lit
        ? "rgba(255,255,255,0.6)"
        : c.active
          ? "#4f7cff"
          : hot
            ? "rgba(255,255,255,0.22)"
            : c.flat
              ? ""
              : "rgba(255,255,255,0.1)";
      if (fill) {
        roundRect(ctx, c.x, c.y, c.w, c.h, Math.min(7, c.h / 2));
        ctx.fillStyle = fill;
        ctx.fill();
      }
    }
    const color = c.disabled ? "rgba(255,255,255,0.3)" : c.danger ? "#ff8a80" : c.muted ? "rgba(255,255,255,0.45)" : !shown ? "rgba(255,255,255,0.6)" : "#ffffff";
    const font = c.font ?? Math.min(17, c.h * 0.42);
    const pad = Math.max(4, c.h * 0.25);
    let x = c.x + pad;
    const cy = c.y + c.h / 2;
    if (c.checked !== undefined && c.align === "left") {
      if (c.checked) drawIcon(ctx, "check", x + font * 0.45, cy, font, color);
      x += font * 1.2;
    }
    if (c.swatch) {
      ctx.beginPath();
      ctx.arc(x + font * 0.3, cy, font * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = c.swatch;
      ctx.fill();
      x += font * 0.9;
    }
    if (c.icon && (c.iconOnly || !c.label)) {
      drawIcon(ctx, c.icon, c.x + c.w / 2, cy, Math.min(c.h * 0.55, c.w * 0.7), color);
      return;
    }
    ctx.font = `${shown ? 600 : 500} ${font}px system-ui, sans-serif`;
    if (c.icon) {
      drawIcon(ctx, c.icon, x + font * 0.5, cy, font * 1.05, color);
      x += font * 1.4;
    }
    let detailW = 0;
    if (c.detail) {
      ctx.save();
      ctx.font = `500 ${font * 0.85}px system-ui, sans-serif`;
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillText(c.detail, c.x + c.w - pad, cy + 0.5);
      detailW = ctx.measureText(c.detail).width + pad;
      ctx.restore();
    }
    if (!c.label) return;
    ctx.fillStyle = color;
    if (c.align === "left") {
      ctx.textAlign = "left";
      ctx.fillText(fit(ctx, c.label, c.x + c.w - pad - detailW - x), x, cy + 0.5);
    } else {
      ctx.textAlign = "center";
      ctx.fillText(fit(ctx, c.label, c.w - pad), c.x + c.w / 2, cy + 0.5);
    }
  }

  /** An icon's name over it while a hand is at it: above, or below at the top of the panel. */
  private paintTip(c: Control) {
    const { ctx } = this;
    const font = 6;
    ctx.font = `600 ${font}px system-ui, sans-serif`;
    const tw = ctx.measureText(c.label!).width + 6;
    const th = font + 4;
    const x = Math.max(0, Math.min(this.contentWidth - tw, c.x + c.w / 2 - tw / 2));
    const y = c.y - th - 1.5 >= 0 ? c.y - th - 1.5 : c.y + c.h + 1.5;
    roundRect(ctx, x, y, tw, th, th / 2);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fill();
    ctx.fillStyle = "#18191c";
    ctx.textAlign = "center";
    ctx.fillText(c.label!, x + tw / 2, y + th / 2 + 0.3);
  }

  private paintTrack(c: Control, track: NonNullable<Control["track"]>, hot: boolean) {
    const { ctx } = this;
    const total = track.durations.reduce((n, d) => n + d, 0) || 1;
    const h = 10;
    const y = c.y + (c.h - h) / 2;
    let x = c.x;
    track.durations.forEach((d, i) => {
      const w = (d / total) * c.w;
      roundRect(ctx, x + 0.5, y, Math.max(0.5, w - 1), h, 2.5);
      ctx.fillStyle = i === track.at ? "#4f7cff" : hot ? "rgba(255,255,255,0.32)" : "rgba(255,255,255,0.18)";
      ctx.fill();
      x += w;
    });
  }

  dispose() {
    this.texture.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/** `text` cut with an ellipsis to fit `width` in the current font. */
function fit(ctx: CanvasRenderingContext2D, text: string, width: number) {
  if (ctx.measureText(text).width <= width) return text;
  let n = text.length;
  while (n > 1 && ctx.measureText(text.slice(0, n) + "…").width > width) n--;
  return text.slice(0, n) + "…";
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
