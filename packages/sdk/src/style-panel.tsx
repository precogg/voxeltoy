import { For, Index, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { BUILTIN_PALETTES, fromHex, toHex } from "@voxeltoy/core/palette";
import type { Axis } from "@voxeltoy/core/types";
import { SELECT_MODES } from "./actions";
import { useApp } from "./context";
import { Icon } from "./icons";
import { IconButton, Menu, Segmented, type MenuItem } from "./primitives";
import { ShapeKindMenu } from "./shape-bar";

export function StylePanel() {
  const app = useApp();
  const { editor, actions } = app;
  const current = () => toHex(editor.palette[editor.color] ?? 0);

  return (
    <section class="panel style-panel" aria-label="Style">
      <header class="panel-header" hidden={app.compact()}>
        <button
          type="button"
          class="style-toggle"
          aria-expanded={app.styleOpen()}
          title={app.styleOpen() ? "Collapse" : "Colors & brush"}
          onClick={() => app.setStyleOpen(!app.styleOpen())}
        >
          <span class="swatch current" style={{ background: current() }} />
          <span class="hex">{app.host.colorLabel?.(editor.color) ?? current()}</span>
          <Icon name={app.styleOpen() ? "chevronUp" : "chevronDown"} size={16} />
        </button>
      </header>

      <Show when={app.styleOpen() || app.compact()}>
        <Show when={app.host.components?.Palette !== null}>
          <Dynamic component={app.host.components?.Palette ?? Palette} />
        </Show>

        <Show when={editor.activeLayerKind !== "shape"}>
        <Show when={editor.tool === "add" || editor.tool === "erase" || editor.tool === "brush"}>
          <div class="style-row">
            <span class="style-label">Brush</span>
            <Segmented
              label="Brush"
              value={editor.brush}
              onChange={(b) => editor.setBrush(b)}
              options={[
                { value: "voxel", label: "Voxel", title: `Single voxels (1)` },
                { value: "box", label: "Box", title: `Drag a rectangle (2)` },
                { value: "face", label: "Face", title: `Whole connected face (3)` },
                { value: "shape", label: "Shape", title: `Spheres, cylinders and more (4)` },
              ]}
            />
          </div>
          <Show when={editor.brush === "shape"}>
            <ShapeOptions />
          </Show>
          <Show when={editor.mode2D && editor.tool !== "erase" && (editor.brush === "voxel" || editor.brush === "box")}>
            <div class="style-row">
              <span class="style-label">Depth</span>
              <div class="depth-stepper" role="group" aria-label="Pencil depth">
                <IconButton
                  icon="minus"
                  label="Thinner"
                  disabled={editor.thickness <= 1}
                  onClick={() => editor.setThickness(editor.thickness - 1)}
                />
                <span class="depth-value" title="Cells the pencil fills from the workplane">
                  {editor.thickness}
                </span>
                <IconButton
                  icon="plus"
                  label="Thicker"
                  onClick={() => editor.setThickness(editor.thickness + 1)}
                />
              </div>
              <button
                type="button"
                class="toggle-chip"
                aria-pressed={editor.bothSides}
                data-active={editor.bothSides ? "" : undefined}
                aria-label="Both sides of the workplane"
                title="Fill the depth on both sides of the workplane"
                onClick={() => editor.setBothSides(!editor.bothSides)}
              >
                Both
              </button>
            </div>
          </Show>
        </Show>
        <Show when={editor.tool === "select"}>
          <div class="style-row">
            <span class="style-label">Mode</span>
            <div class="segmented icon-segments" role="radiogroup" aria-label="Selection mode">
              <For each={SELECT_MODES}>
                {(mode) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={editor.selectMode === mode.id}
                    aria-label={mode.label}
                    title={mode.hint ? `${mode.label} (${mode.hint})` : mode.label}
                    data-active={editor.selectMode === mode.id ? "" : undefined}
                    onClick={() => editor.setSelectMode(mode.id)}
                  >
                    <Icon name={mode.icon} size={18} />
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="style-row">
            <span class="style-label">Brush</span>
            <Segmented
              label="Select brush"
              value={editor.selectBrush}
              onChange={(b) => editor.setSelectBrush(b)}
              class="dense"
              options={[
                { value: "voxel", label: "Voxel", title: "Voxels you drag over" },
                { value: "box", label: "Box", title: "Drag a rectangle" },
                { value: "face", label: "Face", title: "Whole connected face" },
                { value: "shape", label: "Shape", title: "Spheres, cylinders and more" },
                { value: "color", label: "Color", title: "Voxels of one color" },
              ]}
            />
          </div>
          <Show when={editor.selectBrush === "shape"}>
            <ShapeOptions />
          </Show>
          <Show when={editor.selectBrush === "color"}>
            <div class="style-row">
              <span class="style-label" />
              <FillModes />
            </div>
          </Show>
        </Show>
        <Show when={editor.tool === "fill"}>
          <div class="style-row">
            <span class="style-label">Fill</span>
            <FillModes shiftHint />
          </div>
        </Show>

        <div class="style-row">
          <span class="style-label">Mirror</span>
          <div class="segmented" role="group" aria-label="Mirror">
            <For each={[0, 1, 2] as Axis[]}>
              {(axis) => (
                <button
                  type="button"
                  aria-pressed={editor.mirror[axis]}
                  data-active={editor.mirror[axis] ? "" : undefined}
                  title={`Mirror across ${"XYZ"[axis]} (${"XYZ"[axis]})`}
                  onClick={() => editor.toggleMirror(axis)}
                >
                  {"XYZ"[axis]}
                </button>
              )}
            </For>
          </div>
        </div>
        </Show>
      </Show>
    </section>
  );

  /** The shape brush's fill; which shape it draws, and how, is in the bar over the toolbar. */
  function ShapeOptions() {
    return (
      <div class="style-row">
        <span class="style-label">Shape</span>
        <ShapeKindMenu
          kind={editor.shapeKind}
          params={editor.shapeParams}
          label="Shape to draw"
          placement="bottom-start"
          onPick={(k) => editor.setShapeKind(k)}
        />
        <Segmented
          label="Shape fill"
          class="dense"
          value={editor.shapeHollow ? "hollow" : "solid"}
          onChange={(v) => editor.setShapeHollow(v === "hollow")}
          options={[
            { value: "solid", label: "Solid" },
            { value: "hollow", label: "Hollow", title: "Just a one-voxel shell" },
          ]}
        />
      </div>
    );
  }

  /** Connected / all of color, shared by the fill tool and the select tool's color brush. */
  function FillModes(props: { shiftHint?: boolean }) {
    return (
      <Segmented
        label="Color region"
        value={editor.fillMode}
        onChange={(m) => editor.setFillMode(m)}
        options={[
          { value: "connected", label: "Connected" },
          {
            value: "all",
            label: "All of color",
            title: props.shiftHint ? "Every voxel of this color (Shift)" : "Every voxel of this color",
          },
        ]}
      />
    );
  }

  function Palette() {
    let original = 0;

    const paletteItems = (): MenuItem[] => [
      { label: actions.loadPalette.label, onSelect: actions.loadPalette.run },
      {
        label: "Built-in palettes",
        items: () =>
          BUILTIN_PALETTES.map((p) => ({
            label: p.name,
            detail: `${p.colors.length}`,
            onSelect: () => {
              editor.loadPalette(p.colors);
              editor.notify(`Loaded ${p.name}`);
            },
          })),
      },
      {
        label: "Export palette",
        items: () => [
          { label: actions.exportPaletteHex.label, onSelect: actions.exportPaletteHex.run },
          { label: actions.exportPaletteGpl.label, onSelect: actions.exportPaletteGpl.run },
          { label: actions.exportPalettePal.label, onSelect: actions.exportPalettePal.run },
          { label: actions.exportPalettePng.label, onSelect: actions.exportPalettePng.run },
        ],
      },
    ];

    return (
      <>
        <div class="palette" role="listbox" aria-label="Palette">
          <Index each={editor.palette.slice(1)}>
            {(color, i) => (
              <button
                type="button"
                role="option"
                class="swatch"
                aria-selected={editor.color === i + 1}
                data-active={editor.color === i + 1 ? "" : undefined}
                style={{ background: toHex(color()) }}
                title={`${toHex(color())} (${i + 1})`}
                onClick={() => {
                  editor.setColor(i + 1);
                  // on a shape layer, a color also recolors the selected step
                  const selected = editor.selectedStep;
                  if (selected && selected.step.mode !== "cut") editor.setStepMaterial(selected.layerId, selected.step.id, i + 1);
                }}
              />
            )}
          </Index>
        </div>
        <div class="style-row palette-actions">
          <IconButton
            icon="plus"
            label="Add color"
            class="small"
            onClick={() => editor.addPaletteColor(editor.palette[editor.color] ?? 0x808080)}
          />
          {/* the native picker opens on a direct tap of the input, which is the most reliable on mobile */}
          <label class="icon-button small color-edit" title="Edit color">
            <Icon name="pencil" />
            <input
              type="color"
              aria-label="Edit color"
              value={current()}
              onFocus={() => (original = editor.palette[editor.color])}
              onClick={() => (original = editor.palette[editor.color])}
              onInput={(e) => editor.previewPaletteColor(editor.color, fromHex(e.currentTarget.value))}
              onChange={(e) => editor.setPaletteColor(editor.color, fromHex(e.currentTarget.value), original)}
            />
          </label>
          <span class="spacer" />
          <Menu icon="dots" label="Palette options" items={paletteItems} placement="bottom-end" buttonClass="small" />
        </div>
      </>
    );
  }
}

/** Compact-mode toggle for the style sheet: just the current color. */
export function StyleButton() {
  const app = useApp();
  const { editor } = app;
  return (
    <button
      type="button"
      class="panel style-button"
      aria-expanded={app.styleOpen()}
      aria-label="Colors & brush"
      data-active={app.styleOpen() ? "" : undefined}
      onClick={() => app.setStyleOpen(!app.styleOpen())}
    >
      <span class="swatch current" style={{ background: toHex(editor.palette[editor.color] ?? 0) }} />
    </button>
  );
}
