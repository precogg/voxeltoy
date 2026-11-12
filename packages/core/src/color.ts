// Colors are 0xRRGGBB numbers. Kept apart from palette.ts (which reads image files with the DOM)
// so the room server can use them.

/** Colors a palette holds, not counting the reserved index 0. */
export const MAX_COLORS = 255;

export function toHex(color: number): string {
  return "#" + color.toString(16).padStart(6, "0");
}

export function fromHex(hex: string): number {
  return parseInt(hex.replace("#", "").slice(0, 6), 16);
}
