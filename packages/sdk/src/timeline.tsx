import { createEffect, createSignal, Index, Show } from "solid-js";
import { type AnimationTag, frameAt, tagLanes, ticksToMs, totalTicks } from "@voxeltoy/core/animation";
import { useApp } from "./context";
import { Icon } from "./icons";
import { IconButton, Menu, Segmented } from "./primitives";
import { frameMenuItems, playbackRangeItems, tagColor, tagGlyph } from "./menus";
import { createThumbnails } from "./thumbnails";

/** Seconds, short: "0.25 s", "2 s". */
const seconds = (ms: number) => `${Math.round(ms / 10) / 100} s`;

const DIRECTIONS = [
  { value: "forward", label: "→", title: "Forward" },
  { value: "reverse", label: "←", title: "Reverse" },
  { value: "pingpong", label: "⇄", title: "Ping-pong" },
] as const;

/**
 * The animation's poses in order, with playback and the frame commands. Tiles are equal width:
 * it is a pose sequence, not a time ruler, so a long hold shows as a badge rather than a wide
 * tile. Tags are bands above the tiles, stacked when they share frames; tapping one plays only its
 * frames, and tapping it again edits it. See docs/animation.md.
 */
export function Timeline() {
  const app = useApp();
  const { editor, actions, viewport } = app;
  const thumbnail = createThumbnails(editor, viewport, () => true);

  const locked = () => !!editor.readOnly;
  const index = () => editor.activeFrameIndex;
  const count = () => editor.frames.length;
  const tag = () => editor.tags.find(t => t.id === editor.activeTagId);

  /** Reorder mode: dragging a tile moves the frame. Outside it, a drag on the strip only scrolls. */
  const [reorder, setReorder] = createSignal(false);
  /** The tag being edited: its properties replace the transport, and handles trim its range. */
  const [editing, setEditing] = createSignal<string | null>(null);
  const editTag = () => (locked() ? undefined : editor.tags.find(t => t.id === editing()));
  /** A trim handle being dragged, and the range it would give. */
  const [trim, setTrim] = createSignal<{ id: string; side: "start" | "end"; start: number; end: number; pointer: number } | null>(null);

  /** Tags in rows, with a range being trimmed shown where it would land. */
  const lanes = () => {
    const t = trim();
    const frames = editor.frames;
    const tags = t
      ? editor.tags.map(x => (x.id === t.id ? { ...x, from: frames[t.start].id, to: frames[t.end].id } : x))
      : editor.tags;
    return tagLanes(frames, tags);
  };
  const laneCount = () => lanes().reduce((n, l) => Math.max(n, l.lane + 1), 0);
  const range = () => lanes().find(l => l.tag.id === editor.activeTagId);
  const outside = (i: number) => {
    const r = range();
    return r && (i < r.start || i > r.end) ? "" : undefined;
  };
  const rangeLength = () => {
    const r = range();
    const durations = editor.frames.map(f => f.duration);
    return r ? ticksToMs(totalTicks(durations.slice(r.start, r.end + 1)), editor.fps) : editor.animationLength;
  };

  const edit = (id: string | null) => {
    setReorder(false);
    if (id) editor.setActiveTag(id);
    setEditing(id);
  };
  const newTag = () => {
    actions.newAnimationTag.run();
    if (editor.activeTagId) edit(editor.activeTagId);
  };
  /** First tap plays only the tag's frames; tapping the playing tag edits it. */
  const bandTap = (id: string) => {
    if (editor.activeTagId !== id) {
      editor.setActiveTag(id);
      if (editing()) setEditing(id);
    } else if (!locked()) setEditing(editing() === id ? null : id);
  };

  const rangeItems = () => playbackRangeItems(app, { newTag, edit: (id) => edit(id) });
  /** A tile being dragged in reorder mode, and where it would land. */
  const [drag, setDrag] = createSignal<{ id: string; from: number; to: number; pointer: number } | null>(null);

  const menuItems = () => frameMenuItems(app, { reorder: () => (setEditing(null), setReorder(true)) });

  let strip!: HTMLDivElement;
  let lane!: HTMLDivElement;

  /** The position a dragged tile would take with the pointer at `x`: from the middle of a tile on goes after it. */
  const dropIndex = (x: number) => {
    const tiles = Array.from(strip.querySelectorAll<HTMLElement>(".frame-tile"));
    let to = 0;
    tiles.forEach((tile, i) => {
      const rect = tile.getBoundingClientRect();
      if (x >= rect.left + rect.width / 2) to = i + 1;
    });
    const from = drag()?.from ?? 0;
    // the tile leaves its own place first
    return Math.max(0, Math.min(tiles.length - 1, to > from ? to - 1 : to));
  };

  const tileDown = (e: PointerEvent, id: string, i: number) => {
    if (!reorder() || locked()) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id, from: i, to: i, pointer: e.pointerId });
  };
  const tileMove = (e: PointerEvent) => {
    const d = drag();
    if (!d || d.pointer !== e.pointerId) return;
    const to = dropIndex(e.clientX);
    if (to !== d.to) setDrag({ ...d, to });
    // drag near an edge to scroll the strip
    const rect = strip.getBoundingClientRect();
    if (e.clientX < rect.left + 24) strip.scrollLeft -= 8;
    else if (e.clientX > rect.right - 24) strip.scrollLeft += 8;
  };
  const tileUp = (e: PointerEvent) => {
    const d = drag();
    if (!d || d.pointer !== e.pointerId) return;
    setDrag(null);
    if (e.type === "pointerup" && d.to !== d.from) editor.moveFrame(d.id, d.to);
  };

  /** The tile edge nearest `x`: 0 before the first tile, `count` after the last. */
  const edgeAt = (x: number) =>
    Array.from(strip.querySelectorAll<HTMLElement>(".frame-tile")).filter(tile => {
      const rect = tile.getBoundingClientRect();
      return x >= rect.left + rect.width / 2;
    }).length;

  const handleDown = (e: PointerEvent, side: "start" | "end") => {
    const r = range();
    const t = editTag();
    if (!r || !t) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setTrim({ id: t.id, side, start: r.start, end: r.end, pointer: e.pointerId });
  };
  const handleMove = (e: PointerEvent) => {
    const t = trim();
    if (!t || t.pointer !== e.pointerId) return;
    const edge = edgeAt(e.clientX);
    const next =
      t.side === "start"
        ? { ...t, start: Math.max(0, Math.min(t.end, edge)) }
        : { ...t, end: Math.max(t.start, Math.min(count() - 1, edge - 1)) };
    if (next.start !== t.start || next.end !== t.end) setTrim(next);
    const rect = strip.getBoundingClientRect();
    if (e.clientX < rect.left + 24) strip.scrollLeft -= 8;
    else if (e.clientX > rect.right - 24) strip.scrollLeft += 8;
  };
  const handleUp = (e: PointerEvent) => {
    const t = trim();
    if (!t || t.pointer !== e.pointerId) return;
    setTrim(null);
    if (e.type === "pointerup") setRange(t.id, t.start, t.end);
  };
  const setRange = (id: string, start: number, end: number) => {
    const frames = editor.frames;
    const from = frames[start]?.id;
    const to = frames[end]?.id;
    const t = editor.tags.find(x => x.id === id);
    if (t && from && to && (t.from !== from || t.to !== to)) editor.updateTag(id, { from, to });
  };
  /** Arrow keys move a handle by one frame. */
  const handleKey = (e: KeyboardEvent, side: "start" | "end") => {
    const r = range();
    const t = editTag();
    const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!r || !t || !step) return;
    e.preventDefault();
    e.stopPropagation();
    if (side === "start") setRange(t.id, Math.max(0, Math.min(r.end, r.start + step)), r.end);
    else setRange(t.id, r.start, Math.max(r.start, Math.min(count() - 1, r.end + step)));
  };

  /**
   * The scrub lane: a time ruler where each pose's segment is as long as it shows. Dragging along
   * it moves through the poses; it never scrolls or reorders.
   */
  const scrubTo = (x: number) => {
    const rect = lane.getBoundingClientRect();
    const frames = editor.frames;
    const durations = frames.map((f) => f.duration);
    const fraction = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    const ms = (fraction * totalTicks(durations) * 1000) / editor.fps;
    const id = frames[frameAt(durations, editor.fps, ms, false)]?.id;
    if (id && id !== editor.activeFrameId) editor.setFrame(id);
  };
  let scrubbing: number | null = null;
  const laneKey = (e: KeyboardEvent) => {
    const frames = editor.frames;
    const go = (i: number) => frames[i] && editor.setFrame(frames[i].id);
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") go(Math.max(0, index() - 1));
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") go(Math.min(count() - 1, index() + 1));
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(count() - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  // keep the frame showing in view, during playback too
  createEffect(() => {
    const id = editor.displayFrameId;
    const tile = strip?.querySelector<HTMLElement>(`[data-frame="${CSS.escape(id)}"]`);
    tile?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  const transport = () => (
    <div class="timeline-controls timeline-transport">
      <IconButton
        icon="previous"
        label={actions.previousFrame.label}
        kbd={actions.previousFrame.kbd}
        disabled={count() < 2}
        onClick={actions.previousFrame.run}
      />
      <IconButton
        icon={editor.playing ? "pause" : "play"}
        label={editor.playing ? "Pause" : "Play"}
        kbd={actions.playPause.kbd}
        active={editor.playing}
        disabled={count() < 2}
        onClick={actions.playPause.run}
      />
      <IconButton
        icon="next"
        label={actions.nextFrame.label}
        kbd={actions.nextFrame.kbd}
        disabled={count() < 2}
        onClick={actions.nextFrame.run}
      />
      <div class="timeline-scope">
        <Menu
          icon="film"
          label="Playback range"
          items={rangeItems}
          placement="top-start"
          buttonClass="range-chip"
          trigger={() => (
            <>
              <span class="tag-swatch" style={{ background: tag() ? tagColor(tag()!.id) : undefined }} />
              <span class="range-name">{tag()?.name ?? "All frames"}</span>
              <Show when={tag() && tagGlyph(tag()!)}>
                {(glyph) => <span class="range-glyph">{glyph()}</span>}
              </Show>
              <Icon name="chevronUp" size={14} />
            </>
          )}
        />
        <span class="timeline-readout" aria-live="polite">
          {index() + 1} / {count()}
          <span class="timeline-length"> · {seconds(rangeLength())}</span>
        </span>
      </div>
      <div class="timeline-spacer" />
      <IconButton
        icon="onion"
        label={actions.toggleOnion.label}
        kbd={actions.toggleOnion.kbd}
        active={editor.onionSkin.enabled}
        onClick={actions.toggleOnion.run}
      />
      <IconButton
        icon="duplicateFrame"
        label={actions.duplicateFrame.label}
        kbd={actions.duplicateFrame.kbd}
        disabled={locked()}
        onClick={actions.duplicateFrame.run}
      />
      <Menu icon="dots" label="Frame options" items={menuItems} placement="top-end" />
    </div>
  );

  /** The tag's properties, in place of the transport while it is edited. */
  const tagEditor = (t: () => AnimationTag) => (
    <>
      <div class="timeline-controls tag-edit" role="toolbar" aria-label="Edit tag">
        <label class="tag-name">
          <span class="tag-swatch" style={{ background: tagColor(t().id) }} />
          <input
            aria-label="Tag name"
            maxlength={100}
            value={t().name}
            onChange={(e) => {
              const name = e.currentTarget.value.trim();
              if (name && name !== t().name && !editor.tags.some(x => x.name === name)) editor.updateTag(t().id, { name });
              e.currentTarget.value = t().name;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              e.stopPropagation();
            }}
          />
        </label>
        <Segmented
          label="Direction"
          class="tag-direction"
          value={t().direction}
          options={[...DIRECTIONS]}
          onChange={(direction) => editor.updateTag(t().id, { direction })}
        />
        <Menu
          icon="dots"
          label="Tag options"
          placement="top-end"
          items={() => [
            { label: "Start here", disabled: (range()?.end ?? 0) < index(), onSelect: () => setRange(t().id, index(), range()!.end) },
            { label: "End here", disabled: (range()?.start ?? 0) > index(), onSelect: () => setRange(t().id, range()!.start, index()) },
            "separator",
            { label: actions.deleteAnimationTag.label, danger: true, onSelect: () => (setEditing(null), actions.deleteAnimationTag.run()) },
          ]}
        />
        <IconButton icon="check" label="Done" class="primary" onClick={() => setEditing(null)} />
      </div>
      <div class="timeline-controls tag-edit">
        <span class="timeline-readout">Repeat</span>
        <div class="stepper">
          <IconButton
            icon="minus"
            label="Fewer repeats"
            class="small"
            disabled={t().repeat <= 0}
            onClick={() => editor.updateTag(t().id, { repeat: t().repeat - 1 })}
          />
          <span class="stepper-value" aria-live="polite" aria-label={t().repeat ? `Plays ${t().repeat} times` : "Loops forever"}>
            {t().repeat ? `×${t().repeat}` : "∞"}
          </span>
          <IconButton
            icon="plus"
            label="More repeats"
            class="small"
            disabled={t().repeat >= 999}
            onClick={() => editor.updateTag(t().id, { repeat: t().repeat + 1 })}
          />
        </div>
        <div class="timeline-spacer" />
        <span class="timeline-readout timeline-length">
          {range() ? `${range()!.start + 1}–${range()!.end + 1}` : ""} · {seconds(rangeLength())}
        </span>
      </div>
    </>
  );

  return (
    <div class="panel timeline" role="region" aria-label="Timeline">
      <Show
        when={!reorder()}
        fallback={
          <div class="timeline-controls" role="toolbar" aria-label="Reorder frames">
            <span class="timeline-readout">Drag a frame, or move it</span>
            <div class="timeline-spacer" />
            <IconButton icon="previous" label={actions.moveFrameLeft.label} disabled={index() <= 0} onClick={actions.moveFrameLeft.run} />
            <IconButton icon="next" label={actions.moveFrameRight.label} disabled={index() >= count() - 1} onClick={actions.moveFrameRight.run} />
            <div class="bar-divider" />
            <IconButton icon="check" label="Done" class="primary" onClick={() => setReorder(false)} />
          </div>
        }
      >
        <Show when={editTag()} fallback={transport()}>
          {(t) => tagEditor(t)}
        </Show>
      </Show>
      <div
        class="timeline-strip"
        ref={strip}
        role="listbox"
        aria-label="Poses"
        aria-orientation="horizontal"
        data-reorder={reorder() ? "" : undefined}
        data-trimming={editTag() ? "" : undefined}
        style={{
          "grid-template-columns": `repeat(${count()}, var(--tile))`,
          "grid-template-rows": laneCount() ? `repeat(${laneCount()}, var(--band)) var(--tile)` : "var(--tile)",
        }}
      >
        <Index each={lanes()}>
          {(l) => (
            <button
              type="button"
              class="tag-band"
              style={{
                "grid-column": `${l().start + 1} / ${l().end + 2}`,
                "grid-row": l().lane + 1,
                "--tag": tagColor(l().tag.id),
              }}
              data-active={l().tag.id === editor.activeTagId ? "" : undefined}
              aria-pressed={l().tag.id === editor.activeTagId}
              aria-label={`${l().tag.name}, frames ${l().start + 1} to ${l().end + 1}`}
              title={
                l().tag.id !== editor.activeTagId ? `Play only ${l().tag.name}` : locked() ? l().tag.name : `Edit ${l().tag.name}`
              }
              onClick={() => bandTap(l().tag.id)}
            >
              <span class="tag-band-name">{l().tag.name}</span>
              <Show when={tagGlyph(l().tag)}>{(glyph) => <span class="tag-band-glyph">{glyph()}</span>}</Show>
            </button>
          )}
        </Index>
        <Index each={editor.frames}>
          {(frame, i) => (
            <button
              type="button"
              role="option"
              class="frame-tile"
              style={{ "grid-column": i + 1 }}
              data-frame={frame().id}
              aria-selected={frame().id === editor.activeFrameId}
              data-active={frame().id === editor.activeFrameId ? "" : undefined}
              data-showing={editor.playing && frame().id === editor.displayFrameId ? "" : undefined}
              data-outside={outside(i)}
              data-onion={
                frame().id === editor.onionFrames.before ? "before" : frame().id === editor.onionFrames.after ? "after" : undefined
              }
              aria-label={`Frame ${i + 1}${frame().duration > 1 ? `, held ${frame().duration} ticks` : ""}`}
              title={`Frame ${i + 1} · ${frame().duration} ${frame().duration === 1 ? "tick" : "ticks"}`}
              data-dragging={drag()?.id === frame().id ? "" : undefined}
              data-drop={(() => {
                const d = drag();
                if (!d || d.to === d.from || i !== d.to) return undefined;
                return d.to > d.from ? "after" : "before";
              })()}
              onClick={() => editor.setFrame(frame().id)}
              onPointerDown={(e) => tileDown(e, frame().id, i)}
              onPointerMove={tileMove}
              onPointerUp={tileUp}
              onPointerCancel={tileUp}
            >
              <Show when={thumbnail(frame().id)}>{(url) => <img class="frame-thumb" src={url()} alt="" draggable={false} />}</Show>
              <span class="frame-number">{i + 1}</span>
              <Show when={frame().duration > 1}>
                <span class="frame-hold" aria-hidden="true">
                  ×{frame().duration}
                </span>
              </Show>
            </button>
          )}
        </Index>
        <Show when={editTag() && range()}>
          {(r) => (
            <>
              <div class="tag-trim" style={{ "grid-column": `${r().start + 1} / ${r().end + 2}`, "--tag": tagColor(r().tag.id) }} />
              <Index each={["start", "end"] as const}>
                {(side) => (
                  <button
                    type="button"
                    class="tag-handle"
                    data-side={side()}
                    style={{ "grid-column": (side() === "start" ? r().start : r().end) + 1, "--tag": tagColor(r().tag.id) }}
                    aria-label={side() === "start" ? "Move tag start" : "Move tag end"}
                    title={side() === "start" ? "Drag to move the start" : "Drag to move the end"}
                    onPointerDown={(e) => handleDown(e, side())}
                    onPointerMove={handleMove}
                    onPointerUp={handleUp}
                    onPointerCancel={handleUp}
                    onKeyDown={(e) => handleKey(e, side())}
                  >
                    <Icon name={side() === "start" ? "previous" : "next"} size={14} />
                  </button>
                )}
              </Index>
            </>
          )}
        </Show>
      </div>
      <div
        class="timeline-lane"
        ref={lane}
        role="slider"
        tabindex="0"
        aria-label="Scrub through poses"
        aria-valuemin={1}
        aria-valuemax={count()}
        aria-valuenow={index() + 1}
        aria-valuetext={`Frame ${index() + 1} of ${count()}`}
        onPointerDown={(e) => {
          scrubbing = e.pointerId;
          lane.setPointerCapture(e.pointerId);
          scrubTo(e.clientX);
        }}
        onPointerMove={(e) => scrubbing === e.pointerId && scrubTo(e.clientX)}
        onPointerUp={() => (scrubbing = null)}
        onPointerCancel={() => (scrubbing = null)}
        onKeyDown={laneKey}
      >
        <div class="lane-track">
          <Index each={editor.frames}>
            {(frame, i) => (
              <div
                class="lane-segment"
                style={{ "flex-grow": frame().duration }}
                data-active={frame().id === editor.activeFrameId ? "" : undefined}
                data-showing={editor.playing && frame().id === editor.displayFrameId ? "" : undefined}
                data-outside={outside(i)}
              />
            )}
          </Index>
        </div>
      </div>
    </div>
  );
}
