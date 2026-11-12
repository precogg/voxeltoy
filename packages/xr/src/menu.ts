import type { Control } from "./panel";

/**
 * What a command needs of the view that offers it, beyond the editor: a view shows only the
 * commands whose needs it meets (`MenuView`'s `supports`). The page meets them all; the headset
 * view, none of these yet. A host can name its own.
 */
export type MenuNeed =
  /** A file picker or a download. */
  | "files"
  /** A dialog on the page. */
  | "dialog"
  /** Typing: a name, a shortcut. */
  | "keyboard"
  /** Leaving the open model for another, a scene or the library. */
  | "navigation"
  /** Markers drawn on the model. */
  | "markers"
  /** Onion skins drawn about the frame. */
  | "onion-skin"
  /** The page itself: its theme, installing it, opening the headset view. */
  | "page"
  | (string & {});

/**
 * A menu as the page's menus describe one (`MenuItem` in the SDK, which fits this), so a view
 * draws the host's own menus and the commands stay in one list.
 */
export type XRMenuItem =
  | {
      /** Stands for the command (an action's id). */
      id?: string;
      label: string;
      onSelect: () => void;
      detail?: string;
      /** A color dot before the label (a CSS color). */
      swatch?: string;
      checked?: boolean;
      danger?: boolean;
      disabled?: boolean;
      needs?: readonly MenuNeed[];
    }
  | { id?: string; label: string; items: () => XRMenuItem[]; detail?: string; disabled?: boolean; needs?: readonly MenuNeed[] }
  | { heading: string }
  | "separator";

/** The host's menus a headset's windows show. Without one, a window offers what it can on its own. */
export interface XRMenus {
  /** The main menu. */
  main?: () => XRMenuItem[];
  /** What the Layers window's + makes. */
  newLayer?: () => XRMenuItem[];
  /** A layer's options. */
  layer?: (id: string) => XRMenuItem[];
  /** A group's options. */
  group?: (id: string) => XRMenuItem[];
  /** The timeline's frame options. */
  frame?: () => XRMenuItem[];
  /** The timeline's playback range: all frames, or a tag's. */
  playbackRange?: () => XRMenuItem[];
}

/** Menu rows, in millimetres: 32 mm rows are easy to push or point at, at arm's length. */
export const ROW = 32;
const HEADING = 22;
const SEPARATOR = 8;
const GAP = 2;

const isHeading = (item: XRMenuItem): item is { heading: string } => typeof item !== "string" && "heading" in item;

/** Whether a view that meets `supports` can offer `item`. */
export const offered = (item: XRMenuItem, supports: ReadonlySet<string>) =>
  typeof item === "string" || isHeading(item) || (item.needs ?? []).every((n) => supports.has(n));

/**
 * The items a view that meets `supports` offers: the rest go, as do submenus left empty, and the
 * headings and separators that would start or end the list, or sit together.
 */
export function tidy(items: XRMenuItem[], supports: ReadonlySet<string>): XRMenuItem[] {
  const out: XRMenuItem[] = [];
  for (const item of items) {
    if (!offered(item, supports)) continue;
    if (typeof item !== "string" && "items" in item && !tidy(item.items(), supports).length) continue;
    const divider = item === "separator";
    const prev = out[out.length - 1];
    if (divider && (!prev || prev === "separator")) continue;
    if (prev && isHeading(prev) && (divider || isHeading(item))) out.pop();
    out.push(item);
  }
  while (out.length) {
    const last = out[out.length - 1];
    if (last === "separator" || isHeading(last)) out.pop();
    else break;
  }
  return out;
}

const heightOf = (item: XRMenuItem) => (item === "separator" ? SEPARATOR : isHeading(item) ? HEADING : ROW);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/**
 * A menu in a window: its items as rows, a submenu in its place with a row back at the top (as the
 * page's menus open in place), and pages when it is longer than the window.
 */
export class MenuView {
  private trail: { label: string; items: () => XRMenuItem[] }[] = [];
  private page = 0;

  constructor(
    private redraw: () => void,
    /** What the view can do: items that need more stay out. */
    private supports: ReadonlySet<string> = new Set(),
  ) {}

  /** Back to the top, first page. */
  reset() {
    this.trail = [];
    this.page = 0;
  }

  /**
   * Rows for `root` in the box (millimetres). `close`, if given, is a row back at the top level (a
   * menu over a list, such as a layer's options); choosing an item calls `done`.
   */
  rows(
    root: () => XRMenuItem[],
    box: { x: number; y: number; w: number; h: number },
    options: { close?: { label: string; run: () => void }; done?: () => void } = {},
  ): Control[] {
    const { x, w } = box;
    let y = box.y;
    const out: Control[] = [];
    const level = this.trail[this.trail.length - 1];
    const back = level
      ? {
          label: level.label,
          run: () => {
            this.trail.pop();
            this.page = 0;
            this.redraw();
          },
        }
      : options.close;
    if (back) {
      out.push({ id: "menu-back", x, y, w, h: ROW, label: back.label, icon: "chevronLeft", align: "left", flat: true, font: 14, onPress: back.run });
      y += ROW + GAP + 2;
    }
    const items = tidy((level?.items ?? root)(), this.supports);

    // pages: as many rows as fit, less a row for paging when they don't all fit
    const room = box.y + box.h - y;
    const total = items.reduce((n, item) => n + heightOf(item) + GAP, 0);
    const avail = total <= room ? room : room - ROW - GAP;
    const pages: XRMenuItem[][] = [[]];
    let used = 0;
    for (const item of items) {
      const h = heightOf(item) + GAP;
      if (used + h > avail && pages[pages.length - 1].length) {
        pages.push([]);
        used = 0;
      }
      if (!used && item === "separator") continue;
      pages[pages.length - 1].push(item);
      used += h;
    }
    const page = Math.min(this.page, pages.length - 1);
    const depth = this.trail.map((t) => slug(t.label)).join("/");

    pages[page].forEach((item, i) => {
      if (item === "separator") {
        y += SEPARATOR + GAP;
        return;
      }
      if (isHeading(item)) {
        out.push({ id: `heading:${i}:${slug(item.heading)}`, x, y, w, h: HEADING, label: item.heading, align: "left", font: 11 });
        y += HEADING + GAP;
        return;
      }
      const id = `item:${depth}/${item.id ?? slug(item.label)}`;
      const row: Control = { id, x, y, w, h: ROW, label: item.label, detail: item.detail, align: "left", flat: true, font: 14, disabled: item.disabled };
      if ("items" in item) {
        const sub = item;
        row.detail = [item.detail, "›"].filter(Boolean).join("  ");
        row.onPress = () => {
          this.trail.push({ label: sub.label, items: sub.items });
          this.page = 0;
          this.redraw();
        };
      } else {
        const leaf = item;
        row.swatch = leaf.swatch;
        row.danger = leaf.danger;
        if (leaf.checked !== undefined) row.checked = leaf.checked;
        row.onPress = () => {
          leaf.onSelect();
          this.reset();
          options.done?.();
          this.redraw();
        };
      }
      out.push(row);
      y += ROW + GAP;
    });

    if (pages.length > 1) {
      const py = box.y + box.h - ROW;
      const bw = (w - 2 * 6) / 3;
      const flip = (d: number) => () => {
        this.page = (page + d + pages.length) % pages.length;
        this.redraw();
      };
      out.push(
        { id: "menu-prev", x, y: py, w: bw, h: ROW, label: "Previous page", icon: "chevronLeft", iconOnly: true, onPress: flip(-1) },
        { id: "menu-page", x: x + bw + 6, y: py, w: bw, h: ROW, label: `${page + 1} / ${pages.length}`, font: 13 },
        { id: "menu-next", x: x + 2 * (bw + 6), y: py, w: bw, h: ROW, label: "Next page", icon: "chevronRight", iconOnly: true, onPress: flip(1) },
      );
    }
    return out;
  }
}
