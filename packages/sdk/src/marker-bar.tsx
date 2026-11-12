import { createSignal, For, Show } from "solid-js";
import { ORIGIN } from "@voxeltoy/core/editor";
import { markerAt, type MarkerShape } from "@voxeltoy/core/markers";
import { boxShape } from "@voxeltoy/core/source";
import type { Axis, Vec3 } from "@voxeltoy/core/types";
import { useApp } from "./context";
import { IconButton, Menu, type MenuItem } from "./primitives";

/** What the add menu makes: a point or a volume, with a role. */
const KINDS: { label: string; role?: string; volume: boolean }[] = [
  { label: "Mount point", role: "mount", volume: false },
  { label: "Point", volume: false },
  { label: "Collision box", role: "collision", volume: true },
  { label: "Hitbox", role: "hitbox", volume: true },
  { label: "Hurtbox", role: "hurtbox", volume: true },
];

const ROLES = ["mount", "collision", "hitbox", "hurtbox"] as const;

/**
 * Shown while placing markers and the origin (docs/pipeline.md): which one is being placed, and its
 * position along one axis at a time (half voxels for points, whole voxels for volumes, which can
 * also be sized). Taps and drags on the model place it directly.
 */
export function MarkerBar() {
  const { editor, actions } = useApp();
  const [axis, setAxis] = createSignal<Axis>(1);
  const [sizing, setSizing] = createSignal(false);
  const [renaming, setRenaming] = createSignal(false);

  const target = () => editor.markerTarget;
  const marker = () => {
    const t = target();
    return t && t !== ORIGIN ? editor.marker(t) : undefined;
  };
  const shape = (): MarkerShape | null => {
    const t = target();
    if (t === ORIGIN) return { kind: "point", at: editor.shownOrigin };
    const m = marker();
    return m ? markerAt(m, editor.frames, editor.activeFrameId).shape : null;
  };
  const isVolume = () => shape()?.kind === "volume";
  const label = () => (target() === ORIGIN ? "Origin" : (marker()?.name ?? "Markers"));
  /** The value along the axis, in voxels: a point's position, a volume's corner or size. */
  const value = () => {
    const s = shape();
    if (!s) return null;
    const r = editor.resolution;
    const a = axis();
    if (s.kind === "point") return s.at[a] * r;
    return (sizing() ? s.shape.max[a] - s.shape.min[a] : s.shape.min[a]) * r;
  };
  const step = (sign: 1 | -1) => {
    if (isVolume() && sizing()) editor.resizeMarker(axis(), sign);
    else editor.nudgeMarker(axis(), isVolume() ? sign : sign * 0.5);
  };

  /** A new marker over the model: points on top of it, volumes around it (collision) or in its middle. */
  const add = (kind: (typeof KINDS)[number]) => {
    const r = editor.resolution;
    const bounds = editor.contentBounds() ?? { min: [0, 0, 0] as Vec3, max: editor.size.map((n) => n - 1) as Vec3 };
    const lo = bounds.min.map((n) => n / r) as Vec3;
    const hi = bounds.max.map((n) => (n + 1) / r) as Vec3;
    const mid = lo.map((n, a) => (n + hi[a]) / 2) as Vec3;
    let markerShape: MarkerShape;
    if (!kind.volume) markerShape = { kind: "point", at: [mid[0], hi[1], mid[2]] };
    else if (kind.role === "collision") markerShape = { kind: "volume", shape: boxShape(lo, hi) };
    else {
      const half = 1 / r;
      const c = mid.map((n) => Math.floor(n * r) / r) as Vec3;
      markerShape = { kind: "volume", shape: boxShape(c.map((n) => n - half) as Vec3, c.map((n) => n + half) as Vec3) };
    }
    const id = editor.addMarker({ shape: markerShape, ...(kind.role ? { role: kind.role } : {}) });
    if (id) {
      editor.selectMarker(id);
      setSizing(false);
      editor.notify(kind.volume ? "Tap the model to place it, or size it with the bar" : "Tap the model to place it");
    }
  };

  const targetItems = (): MenuItem[] => [
    { label: "Origin", detail: "placed by", checked: target() === ORIGIN, onSelect: () => editor.selectMarker(ORIGIN) },
    ...(editor.markers.length ? (["separator"] as MenuItem[]) : []),
    ...editor.markers.map((m) => ({
      label: m.name,
      detail: m.role,
      checked: target() === m.id,
      onSelect: () => {
        editor.selectMarker(m.id);
        setSizing(false);
      },
    })),
    "separator",
    { label: "Add", items: () => KINDS.map((k) => ({ label: k.label, onSelect: () => add(k) })) },
  ];

  const optionItems = (): MenuItem[] => {
    if (target() === ORIGIN) {
      return [{ label: "Center of the floor", disabled: !editor.hasOrigin, onSelect: () => editor.setOrigin(null) }];
    }
    const m = marker();
    if (!m) return [];
    const keyed = !!m.keys?.length;
    const hidden = editor.markerAt(m.id, editor.activeFrameId)?.hidden ?? false;
    return [
      { label: "Rename", onSelect: () => setRenaming(true) },
      {
        label: "Role",
        detail: m.role,
        items: () => [
          ...ROLES.map((role) => ({ label: role[0].toUpperCase() + role.slice(1), checked: m.role === role, onSelect: () => editor.updateMarker(m.id, { role }) })),
          { label: "None", checked: !m.role, onSelect: () => editor.updateMarker(m.id, { role: null }) },
        ],
      },
      ...(editor.isAnimated
        ? ([
            "separator",
            keyed
              ? { label: "Same in every frame", onSelect: () => editor.setMarkerKeyed(m.id, false) }
              : { label: "Key per frame", onSelect: () => editor.setMarkerKeyed(m.id, true) },
            ...(keyed ? [{ label: hidden ? "Show from this frame" : "Hide from this frame", onSelect: () => editor.setMarkerHidden(m.id, !hidden) }] : []),
          ] as MenuItem[])
        : []),
      "separator",
      { label: "Delete marker", danger: true, onSelect: () => editor.removeMarker(m.id) },
    ];
  };

  return (
    <Show when={editor.markerEditing}>
      <div class="panel bar part-bar" role="toolbar" aria-label="Markers">
        <Show
          when={renaming() && marker()}
          fallback={
            <Menu
              icon="target"
              label="Choose a marker"
              items={targetItems}
              placement="top-start"
              trigger={() => <span class="part-name">{label()}</span>}
            />
          }
        >
          {(m) => (
            <input
              class="layer-name-input part-name-input"
              value={m().name}
              aria-label="Marker name"
              ref={(el) => queueMicrotask(() => el.select())}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  e.currentTarget.value = m().name;
                  e.currentTarget.blur();
                }
              }}
              onBlur={(e) => {
                const name = e.currentTarget.value.trim();
                if (name && name !== m().name) editor.updateMarker(m().id, { name });
                setRenaming(false);
              }}
            />
          )}
        </Show>
        <Show when={target()}>
          <div class="bar-divider" />
          <Show when={isVolume()}>
            <div class="segmented" role="radiogroup" aria-label="Move or size">
              <button type="button" role="radio" aria-checked={!sizing()} data-active={!sizing() ? "" : undefined} onClick={() => setSizing(false)}>
                Move
              </button>
              <button type="button" role="radio" aria-checked={sizing()} data-active={sizing() ? "" : undefined} onClick={() => setSizing(true)}>
                Size
              </button>
            </div>
          </Show>
          <div class="segmented" role="radiogroup" aria-label="Axis">
            <For each={[0, 1, 2] as Axis[]}>
              {(a) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={axis() === a}
                  data-active={axis() === a ? "" : undefined}
                  onClick={() => setAxis(a)}
                >
                  {"XYZ"[a]}
                </button>
              )}
            </For>
          </div>
          <IconButton icon="minus" label={sizing() && isVolume() ? "Shrink by a voxel" : "Move back"} onClick={() => step(-1)} />
          <span class="part-pivot" data-unset={target() === ORIGIN && !editor.hasOrigin ? "" : undefined}>
            {value()}
          </span>
          <IconButton icon="plus" label={sizing() && isVolume() ? "Grow by a voxel" : "Move forward"} onClick={() => step(1)} />
          <Menu icon="dots" label="Marker options" items={optionItems} placement="top-end" />
        </Show>
        <div class="bar-divider" />
        <IconButton
          icon="check"
          label={actions.doneMarkers.label}
          kbd={actions.doneMarkers.kbd}
          class="primary"
          onClick={actions.doneMarkers.run}
        />
      </div>
    </Show>
  );
}
