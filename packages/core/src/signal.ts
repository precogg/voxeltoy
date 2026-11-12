// A Solid signal as one object, set by value (so a function value isn't called as an updater).

import { createSignal } from "solid-js";

export function signal<T>(value: T, equals?: false) {
  const [get, set] = createSignal<T>(value, equals === false ? { equals: false } : undefined);
  return { get, set: (v: T) => set(() => v) };
}
