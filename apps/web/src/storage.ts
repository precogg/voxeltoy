import { readMigratedKey } from "@voxeltoy/core/migrate-key";

/** Read a localStorage value, copying it from the legacy key when the new one is empty. */
export function readLocal(key: string, legacy: string): string | null {
  try {
    return readMigratedKey(
      (k) => localStorage.getItem(k),
      (k, value) => localStorage.setItem(k, value),
      (k) => localStorage.removeItem(k),
      key,
      legacy,
    );
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
