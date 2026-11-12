// The few outline icons the headset's panels draw, on the same 24px grid as the page's
// (`packages/sdk/src/icons.tsx`, mostly Tabler Icons, MIT): path data only, drawn with Path2D.

const ICONS = {
  menu: ["M4 6h16M4 12h16M4 18h16"],
  layers: ["m12 4-8 4 8 4 8-4-8-4", "m4 12 8 4 8-4", "m4 16 8 4 8-4"],
  film: ["M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z", "M8 4v16M16 4v16M4 8h4M4 16h4M4 12h16M16 8h4M16 16h4"],
  eye: ["M10 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0", "M21 12c-2.4 4-5.4 6-9 6s-6.6-2-9-6c2.4-4 5.4-6 9-6s6.6 2 9 6"],
  eyeOff: [
    "M10.59 10.59a2 2 0 0 0 2.83 2.83",
    "M16.68 16.67A8.7 8.7 0 0 1 12 18c-3.6 0-6.6-2-9-6 1.27-2.12 2.71-3.68 4.32-4.67m2.86-1.15A9 9 0 0 1 12 6c3.6 0 6.6 2 9 6-.67 1.11-1.38 2.07-2.14 2.87",
    "m3 3 18 18",
  ],
  lock: ["M5 13a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6z", "M8 11V7a4 4 0 1 1 8 0v4"],
  unlock: ["M5 13a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6z", "M8 11V6a4 4 0 0 1 8 0"],
  plus: ["M12 5v14M5 12h14"],
  minus: ["M5 12h14"],
  dots: ["M4 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0M11 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0M18 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0"],
  chevronDown: ["m6 9 6 6 6-6"],
  chevronUp: ["m6 15 6-6 6 6"],
  chevronLeft: ["m15 18-6-6 6-6"],
  chevronRight: ["m9 18 6-6-6-6"],
  close: ["M18 6 6 18M6 6l12 12"],
  check: ["m5 12 5 5L20 7"],
  play: ["M7 4v16l13-8z"],
  pause: ["M6 5h4v14H6zM14 5h4v14h-4z"],
  previous: ["m15 6-6 6 6 6"],
  next: ["m9 6 6 6-6 6"],
  duplicateFrame: ["M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z", "M4 16V5a1 1 0 0 1 1-1h11", "M13.5 11.5v6M10.5 14.5h6"],
  onion: ["M9 12a5 5 0 1 0 10 0 5 5 0 1 0-10 0", "M5 12a5 5 0 1 0 10 0 5 5 0 1 0-10 0"],
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  voxels: ["M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"],
  pen: ["M4.5 18.5c2.5-8 5-11 8-6.5s5 2.5 7-6.5", "M2.5 18.5a2 2 0 1 0 4 0 2 2 0 1 0-4 0M17.5 5.5a2 2 0 1 0 4 0 2 2 0 1 0-4 0"],
  erase: [
    "M19 20h-10.5l-4.21-4.3a1 1 0 0 1 0-1.41l10-10a1 1 0 0 1 1.41 0l5 5a1 1 0 0 1 0 1.41l-9.2 9.3",
    "m18 13.3-6.3-6.3",
  ],
} satisfies Record<string, string[]>;

export type IconName = keyof typeof ICONS;

/** Filled rather than stroked: the play and pause glyphs. */
const FILLED = new Set<IconName>(["play", "pause"]);

const cache = new Map<IconName, Path2D[]>();

/** Draw icon `name` `size` pixels square, centered on (x, y). */
export function drawIcon(ctx: CanvasRenderingContext2D, name: IconName, x: number, y: number, size: number, color: string) {
  let paths = cache.get(name);
  if (!paths) {
    paths = ICONS[name].map((d) => new Path2D(d));
    cache.set(name, paths);
  }
  const k = size / 24;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(k, k);
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  for (const p of paths) {
    if (FILLED.has(name)) ctx.fill(p);
    else ctx.stroke(p);
  }
  ctx.restore();
}
