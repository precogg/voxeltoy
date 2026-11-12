// The editor's menus as data: what the page's menus show (the main menu, a layer's or group's
// options, the timeline's), and what the headset view's windows show of them. Commands come from
// the actions (`command`), carrying the action's id and what it needs of the view (`needs`), so a
// view that can't do something (the headset can't open a file picker) leaves it out on its own.

import { type AnimationTag, tagLanes } from "@voxeltoy/core/animation";
import { layerKind } from "@voxeltoy/core/editor";
import type { Effect } from "@voxeltoy/core/effects";
import { sameBlend, type Blend } from "@voxeltoy/core/evaluate";
import type { Axis } from "@voxeltoy/core/types";
import type { XRMenus } from "@voxeltoy/xr/menu";
import type { Action } from "./actions";
import type { App } from "./context";
import type { MenuItem } from "./primitives";

/** A menu item for `action`: its id, label, shortcut and needs, and running it. */
export function command(
  action: Action,
  more: { label?: string; detail?: string; disabled?: boolean; checked?: boolean; danger?: boolean; onSelect?: () => void } = {},
): MenuItem {
  const { onSelect, ...rest } = more;
  return { id: action.id, label: action.label, kbd: action.kbd, needs: action.needs, ...rest, onSelect: onSelect ?? action.run };
}

// #region Layers

/** What the new-layer button or menu offers: a layer, and with vector layers on, a vector layer. */
export function newLayerItems(app: App): MenuItem[] {
  const { actions, shapes } = app;
  return [command(actions.newLayer, { label: "Layer" }), ...(shapes() ? [command(actions.newShapeLayer)] : [])];
}

/** Blends by name, as the menus offer them; null is a layer's kind's. */
const BLEND_CHOICES: { label: string; blend: Blend | null }[] = [
  { label: "Normal", blend: null },
  { label: "Behind", blend: { occupancy: "union", keep: true } },
  { label: "Cut", blend: { occupancy: "subtract", keep: false } },
  { label: "Paint", blend: { occupancy: "none", keep: false } },
  { label: "Intersect", blend: { occupancy: "intersect", keep: false } },
  { label: "Intersect, keep colors", blend: { occupancy: "intersect", keep: true } },
  { label: "Replace", blend: { occupancy: "replace", keep: false } },
];

/** A blend's short name for a row's tag, or null for one that needs none. */
export function blendTag(blend: Blend | undefined): string | null {
  if (!blend) return null;
  const found = BLEND_CHOICES.find((c) => c.blend && sameBlend(c.blend, blend));
  return found ? found.label.split(",")[0].toLowerCase() : null;
}

const EFFECT_LABELS: Record<Effect["kind"], string> = { mirror: "Mirror", outline: "Outline", hollow: "Hollow", noise: "Noise" };

export function effectLabel(e: Effect): string {
  return e.kind === "mirror" ? `Mirror ${"XYZ"[e.axis]}` : EFFECT_LABELS[e.kind];
}

/** The Blend submenu for a layer or group. */
function blendItems(current: Blend | undefined, set: (blend: Blend | null) => void): MenuItem[] {
  return BLEND_CHOICES.map((c) => ({
    label: c.label,
    checked: c.blend ? !!current && sameBlend(current, c.blend) : !current,
    onSelect: () => set(c.blend),
  }));
}

/** The Effects submenu: what is there (tap to remove), then what can be added, in the current color. */
function effectItems(app: App, current: readonly Effect[], set: (effects: Effect[]) => void): MenuItem[] {
  const { editor } = app;
  const color = editor.color;
  const swatch = `#${(editor.palette[color] ?? 0).toString(16).padStart(6, "0")}`;
  return [
    ...(current.length ? ([{ heading: "Tap to remove" }] as MenuItem[]) : []),
    ...current.map((e, k) => ({ label: effectLabel(e), detail: "remove", onSelect: () => set(current.filter((_, j) => j !== k)) })),
    { heading: "Add" },
    ...([0, 1, 2] as Axis[]).map((axis) => ({ label: `Mirror ${"XYZ"[axis]}`, onSelect: () => set([...current, { kind: "mirror", axis }]) })),
    { label: "Outline", swatch, onSelect: () => set([...current, { kind: "outline", color }]) },
    { label: "Hollow", onSelect: () => set([...current, { kind: "hollow" }]) },
    { label: "Noise", swatch, onSelect: () => set([...current, { kind: "noise", color, amount: 4, seed: Math.floor(Math.random() * 0xffff) }]) },
    ...(current.length ? (["separator", { label: "Remove all", danger: true, onSelect: () => set([]) }] as MenuItem[]) : []),
  ];
}

/** A group's options, in its row's menu and the headset's Layers window. Without `rename`, no Rename. */
export function groupMenuItems(app: App, id: string, rename?: () => void): MenuItem[] {
  const { editor } = app;
  const group = editor.groups.find((g) => g.id === id);
  if (!group) return [];
  /** Groups this one can go in: not itself, nor one it holds. */
  const parents = editor.groups.filter((g) => {
    for (let at: string | undefined = g.id, n = 0; at && n <= editor.groups.length; at = editor.groups.find((x) => x.id === at)?.group, n++) {
      if (at === id) return false;
    }
    return true;
  });
  return [
    { label: group.visible ? "Hide" : "Show", onSelect: () => editor.setGroupVisible(id, !group.visible) },
    ...(rename ? ([{ label: "Rename", needs: ["keyboard"], onSelect: rename }] as MenuItem[]) : []),
    { label: "Blend", detail: blendTag(group.blend) ?? undefined, items: () => blendItems(group.blend, (b) => editor.setGroupBlend(id, b)) },
    { label: "Effects", detail: group.effects?.length ? String(group.effects.length) : undefined, items: () => effectItems(app, group.effects ?? [], (fx) => editor.setGroupEffects(id, fx)) },
    {
      label: "Put in a group",
      items: () => [
        { label: "None (top level)", checked: !group.group, onSelect: () => editor.setGroupParent(id, null) },
        ...parents.map((g) => ({ label: g.name, checked: group.group === g.id, onSelect: () => editor.setGroupParent(id, g.id) })),
      ],
    },
    "separator",
    { label: "Ungroup", onSelect: () => editor.ungroup(id) },
    { label: "Delete group and its layers", danger: true, onSelect: () => editor.deleteGroup(id) },
  ];
}

/** A layer's options, in its row's menu and the headset's Layers window. Without `rename`, no Rename. */
export function layerMenuItems(app: App, id: string, rename?: () => void): MenuItem[] {
  const { editor, actions, shapes } = app;
  const layer = editor.layer(id);
  if (!layer) return [];
  const index = editor.layers.findIndex((l) => l.id === id);
  const kind = layerKind(layer);
  const count = editor.layers.length;
  const below = editor.layers[index - 1];
  const run = (fn: () => void) => () => {
    editor.selectLayer(id);
    fn();
  };
  const shape = kind === "shape";
  return [
    { label: layer.visible ? "Hide" : "Show", onSelect: () => editor.setLayerVisible(id, !layer.visible) },
    { label: layer.locked ? "Unlock" : "Lock", onSelect: () => editor.setLayerLocked(id, !layer.locked) },
    "separator",
    ...(rename ? ([{ label: "Rename", needs: ["keyboard"], onSelect: rename }] as MenuItem[]) : []),
    { label: "Duplicate", onSelect: () => editor.duplicateLayer(id) },
    { label: "Move up", disabled: index >= count - 1, onSelect: () => editor.moveLayer(id, index + 1) },
    { label: "Move down", disabled: index <= 0, onSelect: () => editor.moveLayer(id, index - 1) },
    { label: "Merge down", disabled: index <= 0 || shape || !!below?.shape, onSelect: () => editor.mergeDown(id) },
    ...(kind === "raster" && shapes()
      ? [command(actions.convertToOverride, { onSelect: () => editor.convertToOverride(id) })]
      : []),
    ...(shape ? [command(actions.bakeShapeLayer, { onSelect: () => editor.bakeShapeLayer(id) })] : []),
    "separator",
    { label: "Blend", detail: blendTag(layer.blend) ?? undefined, items: () => blendItems(layer.blend, (b) => editor.setLayerBlend(id, b)) },
    {
      label: "Effects",
      detail: layer.effects?.length ? String(layer.effects.length) : undefined,
      items: () => effectItems(app, layer.effects ?? [], (fx) => editor.setLayerEffects(id, fx)),
    },
    {
      label: "Mask",
      detail: layer.mask ? "on" : undefined,
      items: () => [
        { label: "Mask to selection", disabled: !editor.hasSelection, onSelect: () => editor.maskLayerToSelection(id) },
        { label: "Select mask", disabled: !layer.mask, onSelect: () => editor.selectLayerMask(id) },
        { label: "Clear mask", disabled: !layer.mask, onSelect: () => editor.clearLayerMask(id) },
      ],
    },
    {
      label: "Group",
      detail: editor.groups.find((g) => g.id === layer.group)?.name,
      items: () => [
        { label: "New group", onSelect: () => editor.createGroup([id]) },
        ...(editor.groups.length ? ([{ heading: "Move to" }] as MenuItem[]) : []),
        ...editor.groups.map((g) => ({ label: g.name, checked: layer.group === g.id, onSelect: () => editor.setLayerGroup(id, g.id) })),
        ...(layer.group ? ([{ label: "Take out of group", onSelect: () => editor.setLayerGroup(id, null) }] as MenuItem[]) : []),
      ],
    },
    ...(shape
      ? []
      : ([
          {
            label: "Flip or rotate",
            items: () => [
              ...([0, 1, 2] as Axis[]).map((a) => ({ label: `Flip ${"XYZ"[a]}`, onSelect: run(() => editor.flipLayer(a)) })),
              ...([0, 1, 2] as Axis[]).map((a) => ({ label: `Rotate 90° around ${"XYZ"[a]}`, onSelect: run(() => editor.rotateLayer(a)) })),
            ],
          },
        ] as MenuItem[])),
    "separator",
    ...(shape ? [] : [{ label: kind === "override" ? "Clear override" : "Clear", onSelect: () => editor.clearLayer(id), danger: true }]),
    { label: "Delete", onSelect: () => editor.deleteLayer(id), danger: true, disabled: count <= 1 },
  ];
}

// #endregion

// #region Timeline

export const FPS_CHOICES = [6, 8, 10, 12, 15, 24, 30];

const TAG_COLORS = ["#f59e0b", "#34d399", "#a78bfa", "#38bdf8", "#f472b6", "#a3e635", "#fb923c", "#2dd4bf"];

/** A tag's color, steady across sessions: picked from its id. */
export const tagColor = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return TAG_COLORS[Math.abs(h) % TAG_COLORS.length];
};

/** How a tag plays, when it isn't the usual forward loop: "⇄ ×3". */
export const tagGlyph = (tag: AnimationTag) =>
  [tag.direction === "reverse" ? "←" : tag.direction === "pingpong" ? "⇄" : "", tag.repeat ? `×${tag.repeat}` : ""].filter(Boolean).join(" ");

/**
 * The playback range: all frames, or a tag's. `edit` (the timeline's tag editor) adds an item to
 * edit the tag playing; `newTag` makes one there, by default the action alone.
 */
export function playbackRangeItems(app: App, options: { newTag?: () => void; edit?: (id: string) => void } = {}): MenuItem[] {
  const { editor, actions } = app;
  const locked = !!editor.readOnly;
  const tag = editor.tags.find((t) => t.id === editor.activeTagId);
  return [
    {
      label: "All frames",
      detail: `1–${editor.frames.length}`,
      checked: !editor.activeTagId,
      onSelect: () => editor.setActiveTag(null),
    },
    ...[...tagLanes(editor.frames, editor.tags)]
      .sort((a, b) => a.start - b.start || a.lane - b.lane)
      .map((l): MenuItem => ({
        label: l.tag.name,
        swatch: tagColor(l.tag.id),
        detail: `${tagGlyph(l.tag)} ${l.start + 1}–${l.end + 1}`.trim(),
        checked: l.tag.id === editor.activeTagId,
        onSelect: () => editor.setActiveTag(l.tag.id),
      })),
    "separator",
    command(actions.newAnimationTag, { disabled: locked, onSelect: options.newTag }),
    // the tag editor is the page's
    ...(tag && !locked && options.edit ? ([{ label: `Edit “${tag.name}”…`, needs: ["dialog", "keyboard"], onSelect: () => options.edit!(tag.id) }] as MenuItem[]) : []),
  ];
}

/**
 * The frame commands: the timeline's ⋯ menu and the headset's. `reorder` (dragging tiles) adds
 * Reorder frames…; without it, moving the frame a place left or right.
 */
export function frameMenuItems(app: App, options: { reorder?: () => void } = {}): MenuItem[] {
  const { editor, actions } = app;
  const locked = !!editor.readOnly;
  const index = editor.activeFrameIndex;
  const count = editor.frames.length;
  const duration = editor.frames[index]?.duration ?? 1;
  return [
    command(actions.blankFrame, { disabled: locked }),
    command(actions.duplicateFrame, { disabled: locked }),
    command(actions.copyLayerToNext, { disabled: locked || index >= count - 1 }),
    "separator",
    { heading: `Hold · ${duration} ${duration === 1 ? "tick" : "ticks"}` },
    command(actions.holdLonger, { disabled: locked || duration >= 999 }),
    command(actions.holdShorter, { disabled: locked || duration <= 1 }),
    "separator",
    ...(options.reorder
      ? ([{ label: "Reorder frames…", onSelect: options.reorder, disabled: locked || count < 2 }] as MenuItem[])
      : [command(actions.moveFrameLeft, { disabled: locked || index <= 0 }), command(actions.moveFrameRight, { disabled: locked || index >= count - 1 })]),
    "separator",
    {
      label: "Onion skin",
      detail: editor.onionSkin.enabled ? "On" : "Off",
      needs: actions.toggleOnion.needs,
      items: () => [
        command(actions.toggleOnion, { label: "Show neighbors", checked: editor.onionSkin.enabled }),
        {
          label: "All visible layers",
          checked: editor.onionSkin.scope === "visible",
          onSelect: () => editor.setOnionSkin({ enabled: true, scope: editor.onionSkin.scope === "visible" ? "active-layer" : "visible" }),
        },
        {
          label: "Compare first and last",
          checked: editor.onionSkin.loop,
          onSelect: () => editor.setOnionSkin({ enabled: true, loop: !editor.onionSkin.loop }),
        },
      ],
    },
    {
      label: "Frames per second",
      detail: `${editor.fps}`,
      disabled: locked,
      items: () => FPS_CHOICES.map((fps) => ({ label: `${fps}`, checked: editor.fps === fps, onSelect: () => editor.setFps(fps) })),
    },
    "separator",
    command(actions.deleteFrame, { danger: true, disabled: locked || count < 2 }),
  ];
}

// #endregion

// #region Main menu

/**
 * The main menu: the top level holds what is used often, the rest is a level down (submenus open in
 * place). The headset view shows it too, less what it can't do.
 */
export function mainMenuItems(app: App): MenuItem[] {
  const { editor, actions, host } = app;
  const builtIn = (): MenuItem[] => [
    command(actions.newDocument),
    command(actions.open),
    command(actions.save),
    { label: "Export", needs: ["files"], items: exportItems },
    ...(actions.enterHeadset.when() ? [command(actions.enterHeadset)] : []),
    "separator",
    command(actions.paste, { disabled: !editor.canPaste }),
    command(actions.selectAll),
    {
      label: "Model",
      items: () => [
        command(actions.resize, { disabled: !!editor.readOnly }),
        command(actions.editMarkers, { disabled: !!editor.readOnly }),
        command(actions.toggleMarkers, { checked: editor.markersShown }),
        { label: "Clear layer", disabled: !!editor.readOnly, onSelect: () => editor.clearLayer(), danger: true },
      ],
    },
    ...(app.shapes() ? ([{ label: "Resolution", detail: `${editor.resolution}×`, items: shapeItems }] as MenuItem[]) : []),
    "separator",
    {
      label: "Theme",
      detail: app.theme()[0].toUpperCase() + app.theme().slice(1),
      needs: ["page"],
      items: () =>
        (["system", "light", "dark"] as const).map((t) => ({
          label: t[0].toUpperCase() + t.slice(1),
          checked: app.theme() === t,
          onSelect: () => app.setTheme(t),
        })),
    },
    command(actions.shortcuts),
  ];
  /** Static exports hold the frame being edited; with frames, the animation's own exports too. */
  const exportItems = (): MenuItem[] => [
    ...(editor.isAnimated ? ([{ heading: `Frame ${editor.activeFrameIndex + 1}` }] as MenuItem[]) : []),
    command(actions.exportVox),
    command(actions.exportGlb),
    command(actions.exportPng),
    // voxel volumes hold every frame, so they go with the animation exports when there are frames
    ...(editor.isAnimated ? ([{ heading: "Animation" }, command(actions.exportFrames), command(actions.exportSpriteSheet)] as MenuItem[]) : []),
    command(actions.exportVolumes),
  ];
  /** The output resolution: voxels per source unit, with the grid size each gives. Vector layers come from the Layers panel's +. */
  const shapeItems = (): MenuItem[] => {
    const choices = editor.resolutionChoices;
    const blocked = !!editor.resolutionBlocker();
    return [
      { heading: `Resolution · ${editor.size.join(" × ")}` },
      ...[1, 2, 4, 8].map((m) => ({
        id: `resolution${m}`,
        label: `${m}× (${editor.size.map((n) => (n * m) / editor.resolution).join(" × ")})`,
        checked: editor.resolution === m,
        disabled: (blocked || !choices.includes(m)) && editor.resolution !== m,
        onSelect: actions[`resolution${m}` as "resolution1"].run,
      })),
    ];
  };
  return host.menu ? host.menu(builtIn(), app) : builtIn();
}

// #endregion

/**
 * The menus the headset view's windows show: the page's own (the host's main menu included), so a
 * command added to one shows in both, where the headset can do what it needs.
 */
export function headsetMenus(app: App): XRMenus {
  return {
    main: () => mainMenuItems(app),
    newLayer: () => newLayerItems(app),
    layer: (id) => layerMenuItems(app, id),
    group: (id) => groupMenuItems(app, id),
    frame: () => frameMenuItems(app),
    playbackRange: () => playbackRangeItems(app),
  };
}
