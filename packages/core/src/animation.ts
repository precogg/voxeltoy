// Frame animation timing: the flipbook's clock, without the DOM. A frame is one pose that lasts a
// whole number of ticks; the document's fps says how long a tick is. Playback asks which frame
// shows at an elapsed time, so late callbacks skip poses rather than slow the animation down.
// See docs/animation.md.

export const DEFAULT_FPS = 12;
export const MIN_FPS = 1;
export const MAX_FPS = 60;
export const MAX_DURATION = 999;
export const MAX_FRAMES = 512;
/** The id of the one frame of a document saved without frames, so every copy of it agrees. */
export const FIRST_FRAME_ID = "frame:0";

export const isFps = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= MIN_FPS && (n as number) <= MAX_FPS;
export const isDuration = (n: unknown): n is number =>
  Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_DURATION;

/** The whole loop's length in ticks. */
export function totalTicks(durations: readonly number[]): number {
  let total = 0;
  for (const d of durations) total += d;
  return total;
}

/** When frame `index` starts, in ticks from the first frame. */
export function frameStart(durations: readonly number[], index: number): number {
  let t = 0;
  for (let i = 0; i < index && i < durations.length; i++) t += durations[i];
  return t;
}

/**
 * The frame showing `ms` milliseconds after the first frame starts. A frame shows from its start
 * up to, not including, the next frame's start. With `loop`, time wraps around; without, it stops
 * on the last frame.
 */
export function frameAt(durations: readonly number[], fps: number, ms: number, loop = true): number {
  const total = totalTicks(durations);
  if (!durations.length || total <= 0) return 0;
  // whole ticks, so frame boundaries are exact however the milliseconds round
  let tick = Math.floor((Math.max(0, ms) * fps) / 1000 + 1e-6);
  if (loop) tick %= total;
  else if (tick >= total) return durations.length - 1;
  for (let i = 0; i < durations.length; i++) {
    tick -= durations[i];
    if (tick < 0) return i;
  }
  return durations.length - 1;
}

/** Ticks to milliseconds at `fps`. */
export const ticksToMs = (ticks: number, fps: number) => (ticks * 1000) / fps;

/** A contiguous, inclusive range anchored to frame IDs. repeat 0 loops forever. */
export interface AnimationTag {
  readonly id: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly direction: "forward" | "reverse" | "pingpong";
  readonly repeat: number;
}

export function tagFrames<T extends { id: string }>(frames: readonly T[], tag: AnimationTag): T[] {
  const a = frames.findIndex(f => f.id === tag.from);
  const b = frames.findIndex(f => f.id === tag.to);
  return a < 0 || b < 0 ? [] : frames.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export function checkTags(value: unknown, frames: readonly { id?: string }[]): AnimationTag[] {
  if (!Array.isArray(value) || value.length > 512) throw new Error("An animation can have at most 512 tags");
  const ids = new Set<string>();
  const names = new Set<string>();
  return value.map(t => {
    if (!t || typeof t.id !== "string" || !/^[\w:-]{1,128}$/.test(t.id) || ids.has(t.id) ||
      typeof t.name !== "string" || !t.name.trim() || t.name.length > 100 || names.has(t.name.trim()) ||
      !frames.some(f => f.id === t.from) || !frames.some(f => f.id === t.to) ||
      !["forward", "reverse", "pingpong"].includes(t.direction) ||
      !Number.isInteger(t.repeat) || t.repeat < 0 || t.repeat > 999) throw new Error("Invalid animation tag: use unique names and IDs, existing endpoints, a direction and 0–999 repeats");
    ids.add(t.id); names.add(t.name.trim());
    return { id: t.id, name: t.name.trim(), from: t.from, to: t.to, direction: t.direction, repeat: t.repeat };
  });
}

/** Where a tag sits on the timeline: its first and last frame index, and its row. */
export interface TagLane {
  readonly tag: AnimationTag;
  readonly start: number;
  readonly end: number;
  readonly lane: number;
}

/**
 * Stack tags into rows for the timeline. Longer ranges claim rows first, so a nested tag sits
 * below the one around it; tags that share no frames share a row. Tags with a missing endpoint
 * are left out.
 */
export function tagLanes(frames: readonly { id: string }[], tags: readonly AnimationTag[]): TagLane[] {
  const index = new Map(frames.map((f, i) => [f.id, i]));
  const spans = tags.flatMap(tag => {
    const a = index.get(tag.from), b = index.get(tag.to);
    return a === undefined || b === undefined ? [] : [{ tag, start: Math.min(a, b), end: Math.max(a, b) }];
  });
  const order = [...spans].sort((p, q) => (q.end - q.start) - (p.end - p.start) || p.start - q.start);
  const rows: { start: number; end: number }[][] = [];
  const lanes = new Map<AnimationTag, number>();
  for (const span of order) {
    let lane = rows.findIndex(row => row.every(o => o.end < span.start || o.start > span.end));
    if (lane < 0) lane = rows.push([]) - 1;
    rows[lane].push(span);
    lanes.set(span.tag, lane);
  }
  return spans.map(span => ({ ...span, lane: lanes.get(span.tag)! }));
}
