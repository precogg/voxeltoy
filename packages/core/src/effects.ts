// Effects: functions from a stage's content to new content, applied before it blends (see
// docs/pipeline.md, "Groups"). They run in output cells, after a layer's or group's content is
// evaluated on the grid, in the order listed. Pure and DOM-free.

import type { Axis, Vec3 } from "./types";

/** One effect on a layer or a group. Colors are palette indices. */
export type Effect =
  /** Reflect the content across the middle of the model, keeping both sides. */
  | { readonly kind: "mirror"; readonly axis: Axis }
  /** A one-voxel skin around the content (cells that touch it across a face), in `color`. */
  | { readonly kind: "outline"; readonly color: number }
  /** Keep only the content's surface: cells with an empty face neighbor. */
  | { readonly kind: "hollow" }
  /** Recolor `amount` sixteenths of the solid cells to `color`, the same cells every time for a `seed`. */
  | { readonly kind: "noise"; readonly color: number; readonly amount: number; readonly seed: number };

export type EffectKind = Effect["kind"];
export const EFFECT_KINDS: readonly EffectKind[] = ["mirror", "outline", "hollow", "noise"];
export const MAX_EFFECTS = 8;

export class EffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EffectError";
  }
}

const fail = (message: string): never => {
  throw new EffectError(message);
};

/** Check effects from anywhere (a file, a script, an op) and return a clean copy. Colors must be in a palette of `paletteLength`. */
export function checkEffects(raw: unknown, paletteLength: number): Effect[] {
  if (!Array.isArray(raw)) fail("Effects are a list");
  const list = raw as unknown[];
  if (list.length > MAX_EFFECTS) fail(`A layer can have at most ${MAX_EFFECTS} effects`);
  const color = (c: unknown, what: string) =>
    Number.isInteger(c) && (c as number) >= 1 && (c as number) < paletteLength ? (c as number) : fail(`${what}'s color must be in the palette`);
  return list.map((r): Effect => {
    const e = r as Record<string, unknown>;
    if (!e || typeof e !== "object") fail("An effect must be an object");
    switch (e.kind) {
      case "mirror":
        if (![0, 1, 2].includes(e.axis as number)) fail("A mirror's axis is 0, 1 or 2");
        return { kind: "mirror", axis: e.axis as Axis };
      case "outline":
        return { kind: "outline", color: color(e.color, "An outline") };
      case "hollow":
        return { kind: "hollow" };
      case "noise": {
        const amount = e.amount ?? 4;
        if (!Number.isInteger(amount) || (amount as number) < 1 || (amount as number) > 15) fail("Noise's amount is 1 to 15 sixteenths");
        const seed = e.seed ?? 0;
        if (!Number.isInteger(seed) || (seed as number) < 0 || (seed as number) > 0xffff) fail("Noise's seed is a whole number from 0 to 65535");
        return { kind: "noise", color: color(e.color, "Noise"), amount: amount as number, seed: seed as number };
      }
      default:
        return fail(`Unknown effect ${String(e.kind)}`);
    }
  });
}

/** The palette indices effects paint with. */
export const effectColors = (effects: readonly Effect[]): number[] =>
  effects.flatMap((e) => (e.kind === "outline" || e.kind === "noise" ? [e.color] : []));

/** Effects with their colors passed through `map` (palette remapping). */
export function mapEffectColors(effects: readonly Effect[], map: (color: number) => number): Effect[] {
  return effects.map((e) => (e.kind === "outline" || e.kind === "noise" ? { ...e, color: map(e.color) } : e));
}

/** A small integer hash of a cell and a seed: the same everywhere, so noise is too. */
function hash(i: number, seed: number): number {
  let h = (i ^ (seed * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Content after effects. `values` are the content's values; `alpha` its coverage, or null where a
 * solid value is its own alpha. Returns new arrays (never the ones given), with `alpha` null again
 * when it came in null. Cells an effect fills or empties take alpha with them: an outline covers
 * what it adds, and hollowing uncovers what it removes, so it never erases what is below.
 */
export function applyEffects(
  values: Uint8Array,
  alpha: Uint8Array | null,
  effects: readonly Effect[],
  size: Vec3,
): { values: Uint8Array; alpha: Uint8Array | null } {
  let v = values.slice();
  let a = alpha ? alpha.slice() : null;
  const [sx, sy, sz] = size;
  const solid = (arr: Uint8Array, i: number) => arr[i] !== 0;
  for (const effect of effects) {
    switch (effect.kind) {
      case "mirror": {
        const out = v.slice();
        const outA = a ? a.slice() : null;
        for (let z = 0, i = 0; z < sz; z++)
          for (let y = 0; y < sy; y++)
            for (let x = 0; x < sx; x++, i++) {
              const c = [x, y, z];
              c[effect.axis] = size[effect.axis] - 1 - c[effect.axis];
              const j = c[0] + sx * (c[1] + sy * c[2]);
              // the reflection fills what is empty on this side; the side's own content stays
              if (!out[i] && v[j]) out[i] = v[j];
              if (outA && a![j]) outA[i] = 1;
            }
        v = out;
        a = outA;
        break;
      }
      case "outline": {
        const out = v.slice();
        for (let z = 0, i = 0; z < sz; z++)
          for (let y = 0; y < sy; y++)
            for (let x = 0; x < sx; x++, i++) {
              if (v[i]) continue;
              const touches =
                (x > 0 && solid(v, i - 1)) ||
                (x < sx - 1 && solid(v, i + 1)) ||
                (y > 0 && solid(v, i - sx)) ||
                (y < sy - 1 && solid(v, i + sx)) ||
                (z > 0 && solid(v, i - sx * sy)) ||
                (z < sz - 1 && solid(v, i + sx * sy));
              if (!touches) continue;
              out[i] = effect.color;
              if (a) a[i] = 1;
            }
        v = out;
        break;
      }
      case "hollow": {
        const out = v.slice();
        for (let z = 1; z < sz - 1; z++)
          for (let y = 1; y < sy - 1; y++)
            for (let x = 1; x < sx - 1; x++) {
              const i = x + sx * (y + sy * z);
              if (!v[i]) continue;
              const inside = v[i - 1] && v[i + 1] && v[i - sx] && v[i + sx] && v[i - sx * sy] && v[i + sx * sy];
              if (!inside) continue;
              out[i] = 0;
              if (a) a[i] = 0;
            }
        v = out;
        break;
      }
      case "noise": {
        const threshold = effect.amount * 0x10000000;
        for (let i = 0; i < v.length; i++) if (v[i] && hash(i, effect.seed) < threshold) v[i] = effect.color;
        break;
      }
    }
  }
  return { values: v, alpha: a };
}
