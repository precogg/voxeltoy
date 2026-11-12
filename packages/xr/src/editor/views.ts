// What Voxeltoy's headset windows show: the main menu, the layers, the timeline and a scene's objects, drawn as
// controls from the editor's state (millimetres). Menus come from the host (`XRMenus`), so the
// headset offers the page's commands; without them, each window offers a few of its own.

import { untrack } from "solid-js";
import { frameAt, totalTicks } from "@voxeltoy/core/animation";
import { layerKind } from "@voxeltoy/core/document";
import type { Editor } from "@voxeltoy/core/editor";
import { stageTree, type StageNode } from "@voxeltoy/core/evaluate";
import type { Layer, LayerGroup } from "@voxeltoy/core/types";
import type { IconName } from "../icons";
import { MenuView, ROW, type XRMenuItem, type XRMenus } from "../menu";
import type { Control } from "../panel";
import { kindMenu, type SceneView } from "./scene";

export interface ViewContext {
  editor: Editor;
  menus: XRMenus;
  /** What the headset can do: menu items that need more stay out. */
  supports: ReadonlySet<string>;
  /** Draw the window again: its own state changed (a submenu, a page). */
  redraw: () => void;
  /** Hide the window. */
  close: () => void;
}

/** A window's view: its controls for a size, and a reset each time it is shown. */
export interface WindowView {
  layout(w: number, h: number): Control[];
  reset(): void;
}

const TITLE = 36;
const GAP = 2;
const BUTTON = TITLE - 4;

/** A window's title row: its name, a few buttons at the end, and × to close it. */
function titleRow(w: number, title: string, close: () => void, extra: Control[] = []): Control[] {
  const closeButton: Control = { id: "close", x: w - BUTTON, y: 2, w: BUTTON, h: BUTTON, label: "Close", icon: "close", iconOnly: true, flat: true, onPress: close };
  let x = w - BUTTON - 4;
  const placed = extra.map((b) => {
    x -= b.w;
    const out = { ...b, x, y: 2, h: BUTTON };
    x -= 4;
    return out;
  });
  return [{ id: "title", x: 4, y: 0, w: x - 4, h: TITLE, label: title, align: "left", font: 15 }, ...placed, closeButton];
}

/** A menu over a window's own content (a layer's options, the frame commands), with a row back to it. */
function overlayMenu(ctx: ViewContext) {
  const view = new MenuView(ctx.redraw, ctx.supports);
  let menu: { label: string; items: () => XRMenuItem[] } | null = null;
  return {
    get open() {
      return !!menu;
    },
    show(label: string, items: () => XRMenuItem[]) {
      menu = { label, items };
      view.reset();
      ctx.redraw();
    },
    close() {
      menu = null;
      ctx.redraw();
    },
    rows(box: { x: number; y: number; w: number; h: number }): Control[] {
      const current = menu!;
      const close = () => this.close();
      return view.rows(current.items, box, { close: { label: current.label, run: close }, done: close });
    },
    reset() {
      menu = null;
    },
  };
}

// #region Menu

/** The main menu, with the headset's own commands (`extra`) after it. */
export function menuView(ctx: ViewContext, extra: () => XRMenuItem[]): WindowView {
  const view = new MenuView(ctx.redraw, ctx.supports);
  const items = (): XRMenuItem[] => {
    const main = ctx.menus.main?.() ?? [
      { id: "undo", label: "Undo", disabled: !ctx.editor.canUndo, onSelect: () => ctx.editor.undo() },
      { id: "redo", label: "Redo", disabled: !ctx.editor.canRedo, onSelect: () => ctx.editor.redo() },
      { id: "selectAll", label: "Select all", onSelect: () => ctx.editor.selectAll() },
    ];
    return [...main, "separator", { heading: "Headset" }, ...extra()];
  };
  return {
    reset: () => view.reset(),
    layout: (w, h) => [...titleRow(w, "Menu", ctx.close), ...view.rows(items, { x: 0, y: TITLE + 6, w, h: h - TITLE - 6 })],
  };
}

// #endregion

// #region Layers

interface LayerLine {
  node: StageNode;
  depth: number;
  /** A group it is in is hidden. */
  inHidden: boolean;
}

/** The layers and groups, topmost first, groups holding theirs unless folded. */
function layerLines(nodes: readonly StageNode[], folded: ReadonlySet<string>, depth = 0, inHidden = false): LayerLine[] {
  const out: LayerLine[] = [];
  for (const node of [...nodes].reverse()) {
    out.push({ node, depth, inHidden });
    if (node.kind === "group") {
      const group = node.group as LayerGroup;
      if (!folded.has(group.id)) out.push(...layerLines(node.children, folded, depth + 1, inHidden || !group.visible));
    }
  }
  return out;
}

const KIND_ICON: Record<string, IconName> = { raster: "voxels", shape: "pen", override: "erase" };

/** The Layers window: tap a layer to draw on it, its eye to hide it, ⋯ for its options; + makes one. */
export function layersView(ctx: ViewContext): WindowView {
  const { editor } = ctx;
  const menu = overlayMenu(ctx);
  const folded = new Set<string>();
  let page = 0;

  const layerItems = (layer: Layer): XRMenuItem[] =>
    ctx.menus.layer?.(layer.id) ?? [
      { label: layer.locked ? "Unlock" : "Lock", onSelect: () => editor.setLayerLocked(layer.id, !layer.locked) },
      { label: "Duplicate", onSelect: () => editor.duplicateLayer(layer.id) },
      "separator",
      { label: "Delete", danger: true, disabled: editor.layers.length <= 1, onSelect: () => editor.deleteLayer(layer.id) },
    ];
  const groupItems = (group: LayerGroup): XRMenuItem[] =>
    ctx.menus.group?.(group.id) ?? [{ label: group.visible ? "Hide" : "Show", onSelect: () => editor.setGroupVisible(group.id, !group.visible) }];
  const add = () => {
    if (ctx.menus.newLayer) menu.show("New", ctx.menus.newLayer);
    else editor.createLayer();
  };

  const layout = (w: number, h: number): Control[] => {
    const out = titleRow(w, "Layers", ctx.close, [{ id: "new", x: 0, y: 0, w: BUTTON, h: 0, label: "New layer", icon: "plus", iconOnly: true, onPress: add }]);
    const top = TITLE + 6;
    const box = { x: 0, y: top, w, h: h - top };
    // the layer a menu was for may be gone (deleted from its own menu)
    if (menu.open) return [...out, ...menu.rows(box)];

    const lines = layerLines(stageTree(editor.layers, editor.groups), folded);
    const step = ROW + GAP;
    let perPage = Math.floor((box.h + GAP) / step);
    if (lines.length > perPage) perPage = Math.floor((box.h - ROW) / step);
    const pages = Math.max(1, Math.ceil(lines.length / perPage));
    page = Math.min(page, pages - 1);
    const end = 32;
    lines.slice(page * perPage, (page + 1) * perPage).forEach((line, i) => {
      const y = top + i * step;
      const indent = line.depth * 16;
      if (line.node.kind === "group") {
        const group = line.node.group as LayerGroup;
        const hidden = !group.visible || line.inHidden;
        out.push(
          {
            id: `group:${group.id}`, x: indent, y, w: w - indent - 2 * (end + 3), h: ROW, label: group.name, icon: "folder", align: "left", flat: true, font: 14, muted: hidden,
            detail: line.node.children.length ? (folded.has(group.id) ? "›" : "⌄") : undefined,
            onPress: () => {
              if (folded.has(group.id)) folded.delete(group.id);
              else folded.add(group.id);
              ctx.redraw();
            },
          },
          {
            id: `group-eye:${group.id}`, x: w - 2 * end - 3, y, w: end, h: ROW, label: group.visible ? "Hide" : "Show", icon: group.visible ? "eye" : "eyeOff", iconOnly: true, flat: true, muted: !group.visible,
            onPress: () => editor.setGroupVisible(group.id, !group.visible),
          },
          { id: `group-menu:${group.id}`, x: w - end, y, w: end, h: ROW, label: "Group options", icon: "dots", iconOnly: true, flat: true, onPress: () => menu.show(group.name, () => groupItems(group)) },
        );
        return;
      }
      const layer = line.node.layer as Layer;
      const hidden = !layer.visible || line.inHidden;
      out.push(
        {
          id: `layer:${layer.id}`, x: indent, y, w: w - indent - 2 * (end + 3), h: ROW, label: layer.name, icon: KIND_ICON[layerKind(layer)], align: "left", flat: true, font: 14,
          active: layer.id === editor.activeLayerId, muted: hidden, detail: layer.locked ? "locked" : undefined,
          onPress: () => editor.selectLayer(layer.id),
        },
        {
          id: `layer-eye:${layer.id}`, x: w - 2 * end - 3, y, w: end, h: ROW, label: layer.visible ? "Hide" : "Show", icon: layer.visible ? "eye" : "eyeOff", iconOnly: true, flat: true, muted: !layer.visible,
          onPress: () => editor.setLayerVisible(layer.id, !layer.visible),
        },
        { id: `layer-menu:${layer.id}`, x: w - end, y, w: end, h: ROW, label: "Layer options", icon: "dots", iconOnly: true, flat: true, onPress: () => menu.show(layer.name, () => layerItems(layer)) },
      );
    });
    if (pages > 1) out.push(...pager(0, h - ROW, w, page, pages, (p) => ((page = p), ctx.redraw())));
    return out;
  };
  return { layout, reset: () => menu.reset() };
}

// #endregion

// #region Timeline

const TILE = 59;
const TILE_GAP = 5;

/** Seconds, short: "0.25 s", "2 s". */
const seconds = (ms: number) => `${Math.round(ms / 10) / 100} s`;

/**
 * The Timeline window: play, step and scrub through the poses, pick a frame, and the frame
 * commands from ⋯. Its strip shows a page of frames, following the one showing.
 */
export function timelineView(ctx: ViewContext): WindowView {
  const { editor } = ctx;
  const menu = overlayMenu(ctx);
  let page = 0;
  let followed = "";
  /** The frame showing when a scrub began: a scrub taken back returns to it. */
  let scrubFrom: string | null = null;

  const frameItems = (): XRMenuItem[] =>
    ctx.menus.frame?.() ?? [
      { label: "Duplicate frame", onSelect: () => editor.insertFrame({ content: "duplicate" }) },
      { label: "New blank frame", onSelect: () => editor.insertFrame({ content: "blank" }) },
      "separator",
      { label: "Delete frame", danger: true, disabled: editor.frames.length < 2, onSelect: () => editor.removeFrames([editor.activeFrameId]) },
    ];
  const rangeItems = (): XRMenuItem[] =>
    ctx.menus.playbackRange?.() ?? [
      { label: "All frames", checked: !editor.activeTagId, onSelect: () => editor.setActiveTag(null) },
      ...editor.tags.map((t) => ({ label: t.name, checked: t.id === editor.activeTagId, onSelect: () => editor.setActiveTag(t.id) })),
    ];

  const layout = (w: number, h: number): Control[] => {
    const frames = editor.frames;
    const count = frames.length;
    const playing = editor.playing;
    const showing = editor.displayFrameId;
    const index = editor.activeFrameIndex;
    const locked = !!editor.readOnly;
    const tag = editor.tags.find((t) => t.id === editor.activeTagId);
    const b = BUTTON;
    const out = titleRow(w, "Timeline", ctx.close, [
      { id: "frame-menu", x: 0, y: 0, w: b, h: 0, label: "Frame options", icon: "dots", iconOnly: true, onPress: () => menu.show("Frame", frameItems) },
      { id: "duplicate", x: 0, y: 0, w: b, h: 0, label: "Duplicate frame", icon: "duplicateFrame", iconOnly: true, disabled: locked, onPress: () => editor.insertFrame({ content: "duplicate" }) },
    ]);
    // the title's room goes to the transport
    out.shift();
    const top = TITLE + 6;
    if (menu.open) return [...out, ...menu.rows({ x: 0, y: top, w: Math.min(w, 320), h: h - top })];

    out.push(
      { id: "previous", x: 0, y: 2, w: b, h: b, label: "Previous frame", icon: "previous", iconOnly: true, disabled: count < 2, onPress: () => editor.previousFrame() },
      { id: "play", x: b + 4, y: 2, w: b, h: b, label: playing ? "Pause" : "Play", icon: playing ? "pause" : "play", iconOnly: true, active: playing, disabled: count < 2, onPress: () => editor.togglePlay() },
      { id: "next", x: 2 * (b + 4), y: 2, w: b, h: b, label: "Next frame", icon: "next", iconOnly: true, disabled: count < 2, onPress: () => editor.nextFrame() },
      {
        id: "range", x: 3 * (b + 4) + 4, y: 2, w: 130, h: b, label: tag?.name ?? "All frames", detail: "⌄", align: "left", font: 13,
        onPress: () => menu.show("Play", rangeItems),
      },
      { id: "readout", x: 3 * (b + 4) + 140, y: 0, w: 120, h: TITLE, label: `${index + 1} / ${count} · ${seconds(editor.animationLength)}`, align: "left", font: 12 },
    );

    // a page of tiles, following the frame showing; ‹ › turn pages
    const perPage = Math.max(1, Math.floor((w - 2 * 28 + TILE_GAP) / (TILE + TILE_GAP)));
    const pages = Math.max(1, Math.ceil(count / perPage));
    const shownIndex = Math.max(0, frames.findIndex((f) => f.id === showing));
    if (showing !== followed) {
      followed = showing;
      page = Math.floor(shownIndex / perPage);
    }
    page = Math.min(page, pages - 1);
    const stripY = top + 4;
    const tileH = 75;
    const turn = (d: number) => () => {
      page = (page + d + pages) % pages;
      ctx.redraw();
    };
    out.push(
      { id: "page-prev", x: 0, y: stripY, w: 24, h: tileH, label: "Earlier frames", icon: "chevronLeft", iconOnly: true, flat: true, disabled: pages < 2, onPress: turn(-1) },
      { id: "page-next", x: w - 24, y: stripY, w: 24, h: tileH, label: "Later frames", icon: "chevronRight", iconOnly: true, flat: true, disabled: pages < 2, onPress: turn(1) },
    );
    const x0 = 28;
    frames.slice(page * perPage, (page + 1) * perPage).forEach((frame, k) => {
      const i = page * perPage + k;
      const isShowing = playing ? frame.id === showing : frame.id === editor.activeFrameId;
      out.push({
        id: `frame:${frame.id}`, x: x0 + k * (TILE + TILE_GAP), y: stripY, w: TILE, h: tileH, label: `${i + 1}`, font: 20, active: isShowing,
        detail: frame.duration > 1 ? `×${frame.duration}` : undefined,
        onPress: () => editor.setFrame(frame.id),
      });
    });

    // the scrub lane: a time ruler, each pose as long as it shows; held and moved along, it scrubs
    const laneY = stripY + tileH + 10;
    const laneH = Math.max(24, h - laneY);
    const durations = frames.map((f) => f.duration);
    const scrubTo = (fx: number) => {
      const ms = (Math.max(0, Math.min(1, fx)) * totalTicks(durations) * 1000) / untrack(() => editor.fps);
      const id = frames[frameAt(durations, untrack(() => editor.fps), ms, false)]?.id;
      if (id && id !== untrack(() => editor.activeFrameId)) editor.setFrame(id);
    };
    if (count < 2) {
      out.push({ id: "lane", x: x0, y: laneY, w: w - 2 * x0, h: laneH, label: "Duplicate the frame to start an animation", font: 12 });
    } else {
      out.push({
        id: "lane", x: x0, y: laneY, w: w - 2 * x0, h: laneH, label: "Scrub", flat: true,
        track: { durations, at: playing ? shownIndex : index },
        onDrag: (fx) => {
          scrubFrom ??= untrack(() => editor.activeFrameId);
          scrubTo(fx);
        },
        onRelease: () => (scrubFrom = null),
        onCancel: () => {
          if (scrubFrom && editor.frames.some((f) => f.id === scrubFrom)) editor.setFrame(scrubFrom);
          scrubFrom = null;
        },
      });
    }
    return out;
  };
  return { layout, reset: () => menu.reset() };
}

// #endregion

// #region Objects

/**
 * The Objects window, for a scene's stage: the selected object's commands (and its path's stops),
 * then the kinds to add. Choosing a kind places it where the drawing hand points next, until Stop.
 */
export function objectsView(ctx: ViewContext, scene: SceneView, place: (kind: string | null) => void): WindowView {
  const menu = new MenuView(ctx.redraw, ctx.supports);
  const { library } = scene;
  const layout = (w: number, h: number): Control[] => {
    const out = titleRow(w, "Objects", ctx.close);
    let y = TITLE + 6;
    const third = (w - 2 * 4) / 3;
    const placing = scene.placing;
    if (placing) {
      out.push(
        { id: "placing", x: 0, y, w: w - third - 4, h: ROW, label: `Placing ${library.kindInfo(placing)?.label ?? placing}`, align: "left", font: 13 },
        { id: "stop-placing", x: w - third, y, w: third, h: ROW, label: "Stop", active: true, onPress: () => place(null) },
      );
      y += ROW + GAP + 6;
    }
    const selection = library.selection;
    if (selection.length) {
      const one = selection.length === 1 ? library.instance(selection[0]) : undefined;
      const kind = one?.kind ? library.kindInfo(one.kind)?.label : undefined;
      out.push({ id: "selected", x: 0, y, w, h: ROW, label: one ? one.name : `${selection.length} objects`, detail: kind !== one?.name ? kind : undefined, align: "left", font: 14 });
      y += ROW + GAP;
      out.push(
        { id: "duplicate", x: 0, y, w: third, h: ROW, label: "Duplicate", font: 12, onPress: () => library.duplicateInstances(selection, [library.snapStep ?? 1, 0, 0]) },
        { id: "delete", x: third + 4, y, w: third, h: ROW, label: "Delete", danger: true, font: 12, onPress: () => library.deleteInstances(selection) },
        { id: "deselect", x: 2 * (third + 4), y, w: third, h: ROW, label: "Deselect", font: 12, onPress: () => library.select([]) },
      );
      y += ROW + GAP;
      if (scene.pathFields().length) {
        const half = (w - 4) / 2;
        out.push(
          { id: "add-stop", x: 0, y, w: half, h: ROW, label: "Add stop", font: 12, onPress: () => scene.addStop() },
          { id: "delete-stop", x: half + 4, y, w: half, h: ROW, label: "Delete stop", font: 12, onPress: () => scene.deleteStop() },
        );
        y += ROW + GAP;
      }
      y += 6;
    }
    out.push({ id: "add-heading", x: 4, y, w: w - 8, h: 22, label: "Add", align: "left", font: 12 });
    y += 24;
    out.push(...menu.rows(() => kindMenu(library.kinds, (k) => place(k.id)), { x: 0, y, w, h: h - y }));
    return out;
  };
  return { layout, reset: () => menu.reset() };
}

// #endregion

/** ‹ page › along the bottom of a list. */
function pager(x: number, y: number, w: number, page: number, pages: number, go: (page: number) => void): Control[] {
  const bw = (w - 12) / 3;
  return [
    { id: "page-prev", x, y, w: bw, h: ROW, label: "Previous page", icon: "chevronLeft", iconOnly: true, onPress: () => go((page - 1 + pages) % pages) },
    { id: "page", x: x + bw + 6, y, w: bw, h: ROW, label: `${page + 1} / ${pages}`, font: 13 },
    { id: "page-next", x: x + 2 * (bw + 6), y, w: bw, h: ROW, label: "Next page", icon: "chevronRight", iconOnly: true, onPress: () => go((page + 1) % pages) },
  ];
}
