import { describe, expect, test } from "bun:test";
import { readMigratedKey } from "./migrate-key";

function memory() {
  const values = new Map<string, string>();
  return {
    values,
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => values.set(key, value),
    remove: (key: string) => values.delete(key),
  };
}

describe("readMigratedKey", () => {
  test("copies the legacy key and drops it only after the new key reads back", () => {
    const store = memory();
    store.set("moxel:theme", "dark");
    const value = readMigratedKey(store.get, store.set, store.remove, "voxeltoy:theme", "moxel:theme");
    expect(value).toBe("dark");
    expect(store.get("voxeltoy:theme")).toBe("dark");
    expect(store.get("moxel:theme")).toBeNull();
  });

  test("leaves the legacy key when the new key does not read back", () => {
    const store = memory();
    store.set("moxel:document", "old");
    const value = readMigratedKey(
      store.get,
      () => {},
      store.remove,
      "voxeltoy:document",
      "moxel:document",
    );
    expect(value).toBe("old");
    expect(store.get("moxel:document")).toBe("old");
    expect(store.get("voxeltoy:document")).toBeNull();
  });

  test("reads the new key and then drops the legacy copy", () => {
    const store = memory();
    store.set("voxeltoy:theme", "light");
    store.set("moxel:theme", "dark");
    expect(readMigratedKey(store.get, store.set, store.remove, "voxeltoy:theme", "moxel:theme")).toBe("light");
    expect(store.get("moxel:theme")).toBeNull();
  });
});
