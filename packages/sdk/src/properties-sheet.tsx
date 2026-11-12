import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { Vec3 } from "@voxeltoy/core/types";
import { useApp } from "./context";
import { LayerRows, NewLayerButton } from "./layers-panel";
import { IconButton, Menu, NumberField } from "./primitives";
import { StepInspector } from "./properties";


/** How tall the sheet stands: just its header, half the screen, or most of it. */
type Stop = "peek" | "half" | "full";
const STOPS: Stop[] = ["peek", "half", "full"];
const PEEK_PX = 124;
const stopPx = (stop: Stop) => (stop === "peek" ? PEEK_PX : stop === "half" ? window.innerHeight * 0.42 : window.innerHeight * 0.8);

/**
 * On a phone, one sheet over the toolbar holds Layers and Properties, with Layers | Properties in its
 * header (just "Layers" while no shape is selected), so the canvas keeps the top of the screen. The
 * layers button opens it on Layers; a shape selected with Layers closed opens it on Properties: the
 * Edit and ⋯ (Duplicate, Delete) beside the switch, then its sections, each folding shut (the
 * kind's ▾ heads its own section). A grabber pulls it up or
 * down; it opens half way.
 */
export function PropertiesSheet() {
  const { editor, actions, host, layersOpen, setLayersOpen, viewport } = useApp();
  const [stop, setStop] = createSignal<Stop>("half");
  /** While the grabber is dragged: the sheet's height in pixels. */
  const [dragHeight, setDragHeight] = createSignal<number | null>(null);
  const selected = () => {
    if (host.viewOnly?.() || editor.activeLayerKind !== "shape" || editor.editingShape) return null;
    if (editor.tool === "shape" || editor.tool === "pen" || editor.drawingPath || editor.pendingShape?.drawing) return null;
    const s = editor.selectedStep;
    return s && s.layerId === editor.activeLayerId ? s : null;
  };
  const onLayers = () => layersOpen() && !editor.editingShape;
  const shown = () => (onLayers() ? "layers" : selected() ? "properties" : null);
  // each newly selected shape, or the sheet opening, starts it half way
  createEffect(on(() => selected()?.step.id, (id, was) => id && id !== was && !onLayers() && setStop("half")));
  createEffect(on(shown, (now, was) => now && !was && setStop("half")));

  let start: { y: number; h: number; id: number } | null = null;
  const grab = {
    onPointerDown: (e: PointerEvent) => {
      start = { y: e.clientY, h: dragHeight() ?? stopPx(stop()), id: e.pointerId };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      setDragHeight(Math.max(PEEK_PX, Math.min(stopPx("full"), start.h + start.y - e.clientY)));
    },
    onPointerUp: (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      const h = dragHeight();
      start = null;
      setDragHeight(null);
      // a tap on the grabber steps it up (from full, back down); a drag lands on the nearest stop
      if (h === null) {
        setStop(stop() === "full" ? "half" : STOPS[STOPS.indexOf(stop()) + 1]);
        return;
      }
      setStop(STOPS.reduce((a, b) => (Math.abs(stopPx(b) - h) < Math.abs(stopPx(a) - h) ? b : a)));
    },
    onPointerCancel: () => {
      start = null;
      setDragHeight(null);
    },
  };

  /** While the sheet is up, the model is framed in the space above it, below the top bar. */
  const track = (sheet: HTMLElement) => {
    const measure = () => {
      const vp = viewport();
      const canvas = document.querySelector<HTMLElement>(".app > .canvas")?.getBoundingClientRect();
      if (!vp || !canvas || !sheet.isConnected) return;
      const top = document.querySelector(".ui .area.top-left")?.getBoundingClientRect().bottom ?? canvas.top;
      vp.setInsets(Math.max(0, top - canvas.top), Math.max(0, canvas.bottom - sheet.getBoundingClientRect().top));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(sheet);
    window.addEventListener("resize", measure);
    requestAnimationFrame(measure);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      viewport()?.setInsets(0, 0);
    });
  };

  return (
    <Show when={shown()}>
      <section ref={track} class="panel properties-sheet" aria-label={shown() === "layers" ? "Layers" : "Properties"} style={{ height: `${dragHeight() ?? stopPx(stop())}px` }}>
        <div class="sheet-grabber" role="button" aria-label="Pull up or down" title="Pull up or down" {...grab}>
          <span />
        </div>
        <div class="sheet-head">
          <Show when={selected()} fallback={<span class="sheet-title">Layers</span>}>
            <div class="segmented sheet-switch" role="tablist" aria-label="Sheet">
              <button type="button" role="tab" aria-selected={onLayers()} data-active={onLayers() ? "" : undefined} onClick={() => setLayersOpen(true)}>
                Layers
              </button>
              <button type="button" role="tab" aria-selected={!onLayers()} data-active={!onLayers() ? "" : undefined} onClick={() => setLayersOpen(false)}>
                Properties
              </button>
            </div>
          </Show>
          <span class="sheet-spacer" />
          <Show when={onLayers()}>
            <NewLayerButton />
          </Show>
          <Show when={!onLayers() && selected()}>
            <IconButton icon="pencil" label={actions.editShape.label} class="small" onClick={actions.editShape.run} />
            <Menu
              icon="dots"
              label="Shape options"
              placement="top-end"
              buttonClass="small"
              items={() => [
                { label: actions.duplicateShape.label, onSelect: actions.duplicateShape.run },
                "separator",
                { label: actions.deleteShape.label, danger: true, onSelect: actions.deleteShape.run },
              ]}
            />
          </Show>
        </div>
        <Show
          when={!onLayers() && selected()}
          fallback={
            <ul class="layer-list sheet-body">
              <LayerRows />
            </ul>
          }
        >
          {(s) => (
            <>
              <div class="sheet-body">
                <StepInspector step={s().step} head={false} />
              </div>
            </>
          )}
        </Show>
      </section>
    </Show>
  );
}

/** On a phone, editing a path in place: the picked point as a small card over the bar, its X Y Z. */
export function PointCard() {
  const { editor } = useApp();
  const point = () => {
    const s = editor.editingShape && editor.selectedStep;
    const i = editor.selectedPathPoint;
    const p = s && i !== null ? s.step.shape.points?.[i] : undefined;
    return s && p && i !== null ? { layerId: s.layerId, stepId: s.step.id, index: i, count: s.step.shape.points!.length, ...p } : null;
  };
  const scrub = { onScrubStart: () => editor.beginStroke("Move point"), onScrubEnd: () => editor.endStroke() };
  return (
    <Show when={point()}>
      {(p) => (
        <section class="panel point-card" aria-label={`Point ${p().index + 1}`}>
          <div class="point-card-title">
            Point {p().index + 1} of {p().count}
          </div>
          <div class="xyz">
            <For each={[0, 1, 2] as const}>
              {(a) => (
                <NumberField
                  label={"XYZ"[a]}
                  title={`Point ${"XYZ"[a]}`}
                  value={Math.floor(p().at[a] * editor.resolution)}
                  onChange={(v) => {
                    const at = [...p().at] as Vec3;
                    at[a] = (v + 0.5) / editor.resolution;
                    editor.movePathPoint(p().layerId, p().stepId, p().index, at);
                  }}
                  {...scrub}
                />
              )}
            </For>
          </div>
        </section>
      )}
    </Show>
  );
}
