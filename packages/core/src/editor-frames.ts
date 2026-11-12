// The session's frames: which one is edited, playback, tags and onion skins. Frames themselves
// (their voxels and timing) are the document's; this is how a session moves through them.
// See docs/animation.md.

import { untrack } from "solid-js";
import { frameAt, frameStart, isDuration, isFps, tagFrames, ticksToMs, totalTicks, type AnimationTag } from "./animation";
import type { PendingPolicy } from "./editor";
import type { EditorInternals } from "./editor-internals";
import type { Item } from "./history";
import { markerAt, type MarkerKey } from "./markers";
import { newFrameId, randomId } from "./ops";
import { signal } from "./signal";
import type { AnimationFrame, OnionSkin } from "./types";

/**
 * Playback in progress: the frame on screen, and when it started, on the caller's clock. Playing
 * only shows frames; the document's open frame stays the one being edited until playback stops.
 */
interface Playback {
  showing: string;
  start: number;
  /** Milliseconds into the loop at `start`. */
  offset: number;
}

const DEFAULT_ONION: OnionSkin = { enabled: false, scope: "active-layer", opacity: 0.3, loop: false };

/** Milliseconds from a monotonic clock. */
export const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class EditorFrames {
  private _activeTag = signal<string | null>(null);
  private _playback = signal<Playback | null>(null);
  private _onion = signal<OnionSkin>(DEFAULT_ONION);

  constructor(private readonly s: EditorInternals) {}

  private get frames(): readonly AnimationFrame[] {
    return this.s.doc.frames;
  }

  private get tags(): readonly AnimationTag[] {
    return this.s.doc.tags;
  }

  /** A new document: no tag, not playing. */
  reset() {
    this._activeTag.set(null);
    this._playback.set(null);
  }

  get displayFrameId(): string {
    return this._playback.get()?.showing ?? this.s.doc.openFrameId;
  }

  get activeFrameIndex(): number {
    const id = this.s.doc.openFrameId;
    return this.frames.findIndex((f) => f.id === id);
  }

  get playing(): boolean {
    return !!this._playback.get();
  }

  // #region Tags

  get activeTagId(): string | null {
    const id = this._activeTag.get();
    return this.tags.some((t) => t.id === id) ? id : null;
  }

  setActiveTag(id: string | null) {
    if (id !== null && !this.tags.some((t) => t.id === id)) throw new Error("That tag does not exist");
    this.pause();
    this._activeTag.set(id);
  }

  createTag(name: string, from: string, to: string, options: Pick<AnimationTag, "direction" | "repeat">): string | null {
    this.pause();
    const id = `tag:${randomId()}`;
    return this.s.apply("Create tag", { t: "tags", after: [...this.tags, { id, name, from, to, ...options }] }) ? id : null;
  }

  updateTag(id: string, changes: Partial<Omit<AnimationTag, "id">>) {
    if (!this.tags.some((t) => t.id === id)) throw new Error("That tag does not exist");
    this.pause();
    return this.s.apply("Edit tag", { t: "tags", after: this.tags.map((t) => (t.id === id ? { ...t, ...changes, id } : t)) });
  }

  removeTag(id: string) {
    this.pause();
    return this.s.apply("Delete tag", { t: "tags", after: this.tags.filter((t) => t.id !== id) });
  }

  /** The frames playback steps through: the active tag's, in its direction, or all of them. */
  private playbackFrames() {
    const tag = this.tags.find((t) => t.id === this.activeTagId);
    const frames = tag ? tagFrames(this.frames, tag) : [...this.frames];
    if (tag?.direction === "reverse") frames.reverse();
    if (tag?.direction === "pingpong" && frames.length > 2) frames.push(...frames.slice(1, -1).reverse());
    return frames;
  }

  // #endregion

  // #region Onion skins

  get onionSkin(): OnionSkin {
    return this._onion.get();
  }

  setOnionSkin(change: Partial<OnionSkin>) {
    const next = { ...untrack(() => this.onionSkin), ...change };
    next.opacity = Math.max(0, Math.min(1, Number(next.opacity) || 0));
    this._onion.set(next);
  }

  get onionFrames(): { before: string | null; after: string | null } {
    const onion = this.onionSkin;
    const frames = this.frames;
    const i = this.activeFrameIndex;
    if (!onion.enabled || this.playing || frames.length < 2 || i < 0) return { before: null, after: null };
    const n = frames.length;
    const at = (j: number) => (onion.loop ? frames[(j + n) % n] : frames[j])?.id ?? null;
    const before = at(i - 1);
    const after = at(i + 1);
    return { before, after: after === before && n === 2 && onion.loop ? null : after };
  }

  // #endregion

  // #region Editing frames

  setFrame(id: string, pending: PendingPolicy): boolean {
    if (!untrack(() => this.frames).some((f) => f.id === id)) return false;
    this.pause();
    if (id === untrack(() => this.s.doc.openFrameId)) return true;
    this.leaveFrame(pending);
    this.s.doc.openFrame(id);
    return true;
  }

  stepFrame(delta: number) {
    const frames = untrack(() => this.frames);
    if (frames.length < 2) return;
    // during playback, step from the pose showing
    const shown = frames.findIndex((f) => f.id === untrack(() => this.displayFrameId));
    this.setFrame(frames[(shown + delta + frames.length) % frames.length].id, "commit");
  }

  insertFrame(after: string, content: "duplicate" | "blank"): string | null {
    if (this.s.blocked()) return null;
    this.pause();
    const frames = untrack(() => this.frames);
    const index = frames.findIndex((f) => f.id === after);
    if (index < 0) return null;
    this.leaveFrame("commit");
    const id = newFrameId();
    let cels: Record<string, Uint8Array> | undefined;
    // keyed markers keep where they are on the frame duplicated, so the copy is the same pose
    let markers: Record<string, Omit<MarkerKey, "frame">> | undefined;
    if (content === "duplicate") {
      cels = {};
      for (const l of untrack(() => this.s.doc.layers)) if (!l.shape) cels[l.id] = untrack(() => this.s.doc.frameCel(after, l.id));
      for (const m of untrack(() => this.s.doc.markers)) {
        if (!m.keys?.length) continue;
        const { shape, hidden } = markerAt(m, frames, after);
        (markers ??= {})[m.id] = hidden ? { hidden: true } : { shape };
      }
    }
    const duration = content === "duplicate" ? frames[index].duration : 1;
    const label = content === "duplicate" ? "Duplicate frame" : "New frame";
    const frame = { id, duration, ...(cels ? { cels } : {}), ...(markers ? { markers } : {}) };
    if (!this.s.apply(label, { t: "frame.add", index: index + 1, frame })) return null;
    this.s.doc.openFrame(id);
    return id;
  }

  moveFrame(id: string, index: number) {
    const frames = untrack(() => this.frames);
    const from = frames.findIndex((f) => f.id === id);
    if (from < 0) return;
    index = Math.max(0, Math.min(frames.length - 1, Math.round(index)));
    if (index === from) return;
    this.pause();
    this.s.apply("Reorder frames", { t: "frame.move", id, to: index });
  }

  removeFrames(ids: Iterable<string>): number {
    const frames = untrack(() => this.frames);
    const remove = new Set([...ids].filter((id) => frames.some((f) => f.id === id)));
    if (!remove.size || this.s.blocked()) return 0;
    if (remove.size >= frames.length) {
      this.s.editor.notify("An animation needs at least one frame");
      return 0;
    }
    this.pause();
    // what is pending in a frame being deleted goes with it
    if (remove.has(untrack(() => this.s.doc.openFrameId))) this.leaveFrame("cancel");
    const label = remove.size > 1 ? "Delete frames" : "Delete frame";
    let removed = 0;
    this.s.editor.transact(label, () => {
      const tags = this.tags.flatMap((tag) => {
        const remaining = tagFrames(frames, tag).filter((f) => !remove.has(f.id));
        return remaining.length ? [{ ...tag, from: remaining[0].id, to: remaining[remaining.length - 1].id }] : [];
      });
      if (JSON.stringify(tags) !== JSON.stringify(this.tags)) this.s.apply(label, { t: "tags", after: tags });
      for (const id of remove) if (this.s.apply(label, { t: "frame.remove", id })) removed++;
    });
    return removed;
  }

  setFrameDuration(ids: string | Iterable<string>, ticks: number) {
    const set = new Set(typeof ids === "string" ? [ids] : ids);
    const duration = Math.round(ticks);
    if (this.s.refuse(isDuration(duration) ? null : "A frame lasts from 1 to 999 ticks")) return;
    const changing = untrack(() => this.frames).filter((f) => set.has(f.id) && f.duration !== duration);
    if (!changing.length) return;
    this.pause();
    this.s.editor.transact("Frame timing", () => {
      for (const f of changing) this.s.apply("Frame timing", { t: "frame.duration", id: f.id, after: duration });
    });
  }

  setFps(fps: number) {
    fps = Math.round(fps);
    if (this.s.refuse(isFps(fps) ? null : "Frames per second is from 1 to 60")) return;
    if (fps === untrack(() => this.s.doc.fps)) return;
    this.pause();
    this.s.apply("Frame rate", { t: "fps", after: fps });
  }

  copyCel(to: string, from: string, layerId: string): boolean {
    const frames = untrack(() => this.frames);
    const layer = untrack(() => this.s.doc.layer(layerId));
    if (!layer || !frames.some((f) => f.id === from) || !frames.some((f) => f.id === to) || from === to) return false;
    if (this.s.refuse(layer.shape ? "Shape layers are the same in every frame" : null)) return false;
    if (this.s.blocked()) return false;
    this.pause();
    this.leaveFrame("commit");
    const src = untrack(() => this.s.doc.frameCel(from, layerId)).slice();
    const dst = untrack(() => this.s.doc.frameCel(to, layerId));
    let changed = 0;
    this.s.editor.transact("Copy cel", () => {
      for (let i = 0; i < dst.length; i++) {
        if (dst[i] === src[i]) continue;
        this.s.write(dst, i, src[i]);
        changed++;
      }
    });
    return changed > 0;
  }

  // #endregion

  // #region Playback

  play(time: number) {
    if (untrack(() => this.playing)) return;
    const frames = untrack(() => this.playbackFrames());
    if (!frames.length || (frames.length < 2 && !untrack(() => this.activeTagId))) return;
    this.leaveFrame("commit");
    const index = Math.max(0, frames.findIndex((f) => f.id === untrack(() => this.s.doc.openFrameId)));
    const offset = ticksToMs(
      frameStart(
        frames.map((f) => f.duration),
        index,
      ),
      untrack(() => this.s.doc.fps),
    );
    this._playback.set({ showing: frames[index].id, start: time, offset });
    this.s.rebuildComposite();
  }

  advance(time: number) {
    const playback = untrack(() => this._playback.get());
    if (!playback) return;
    const frames = untrack(() => this.playbackFrames());
    const fps = untrack(() => this.s.doc.fps);
    const tag = untrack(() => this.tags.find((t) => t.id === this.activeTagId));
    const elapsed = playback.offset + time - playback.start;
    const finished = !!tag?.repeat && elapsed >= ticksToMs(totalTicks(frames.map((f) => f.duration)), fps) * tag.repeat;
    const index = frameAt(
      frames.map((f) => f.duration),
      fps,
      finished ? Infinity : elapsed,
      !finished,
    );
    const id = frames[index].id;
    if (id !== playback.showing) {
      // only the view changes: the document keeps the frame being edited
      this._playback.set({ ...playback, showing: id });
      this.s.rebuildComposite();
    }
    if (finished) this.pause();
  }

  pause() {
    const playback = untrack(() => this._playback.get());
    if (!playback) return;
    this._playback.set(null);
    if (playback.showing !== untrack(() => this.s.doc.openFrameId)) this.s.doc.openFrame(playback.showing);
    else this.s.rebuildComposite();
  }

  // #endregion

  /**
   * Before another frame opens: nothing in progress may carry over into it. A stroke stays in the
   * frame it began in, so changing frames takes it back; a shape being placed is dropped.
   */
  private leaveFrame(pending: PendingPolicy) {
    this.s.settlePending(pending, { shape: "cancel" });
  }

  /** After undo or redo, show the frame the change was in, if it isn't showing. */
  revealFrame(items: readonly Item[]) {
    const open = untrack(() => this.s.doc.openFrameId);
    let first: string | undefined;
    for (const item of items) {
      if (!("op" in item)) continue;
      const op = item.op;
      const id =
        op.t === "voxels" ? op.frame : op.t === "frame.add" ? op.frame.id : op.t === "frame.duration" || op.t === "frame.move" ? op.id : undefined;
      if (id === undefined) continue;
      if (id === open) return;
      first ??= id;
    }
    if (first && untrack(() => this.frames).some((f) => f.id === first)) this.s.doc.openFrame(first);
  }
}
