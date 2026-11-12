/**
 * Read `key`, copying it from `legacy` when `key` is empty.
 * `legacy` is removed only after `key` has been read back, so a failed write
 * leaves the previous value in place.
 */
export function readMigratedKey(
  get: (key: string) => string | null,
  set: (key: string, value: string) => void,
  remove: (key: string) => void,
  key: string,
  legacy: string,
): string | null {
  const current = get(key);
  if (current !== null) {
    try {
      if (get(legacy) !== null) remove(legacy);
    } catch {
      // The new key is already stored. The old one can wait.
    }
    return current;
  }
  const old = get(legacy);
  if (old === null) return null;
  set(key, old);
  const readBack = get(key);
  if (readBack === null) return old;
  try {
    remove(legacy);
  } catch {
    // The new key read back. Leave the old one if it cannot be removed.
  }
  return readBack;
}
