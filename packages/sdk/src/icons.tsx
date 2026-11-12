// Outline icons on a 24px grid (mostly from Tabler Icons, MIT).
const ICONS = {
  menu: `<path d="M4 6h16M4 12h16M4 18h16"/>`,
  undo: `<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>`,
  redo: `<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>`,
  orbit: `<path d="M12 16h4v4"/><path d="M19.46 11.04c.86-2.37.72-4.58-.6-5.9-2.27-2.27-7.19-1.04-10.97 2.75-3.79 3.78-5.02 8.7-2.75 10.97 2.23 2.23 6.99 1.09 10.74-2.52"/>`,
  add: `<path d="m10 3.5 6.5 3.6v4.4M10 18l-6.5-3.6V7.1L10 3.5"/><path d="M3.5 7.1 10 10.7l6.5-3.6M10 10.7V18"/><path d="M18.5 14.5v6M15.5 17.5h6"/>`,
  erase: `<path d="M19 20h-10.5l-4.21-4.3a1 1 0 0 1 0-1.41l10-10a1 1 0 0 1 1.41 0l5 5a1 1 0 0 1 0 1.41l-9.2 9.3"/><path d="m18 13.3-6.3-6.3"/>`,
  paint: `<path d="M3 21v-4a4 4 0 1 1 4 4H3"/><path d="M21 3a16 16 0 0 0-12.8 10.2"/><path d="M21 3a16 16 0 0 1-10.2 12.8"/><path d="M10.6 9a9 9 0 0 1 4.4 4.4"/>`,
  fill: `<path d="m5 16 1.47 1.64a2 2 0 1 1-3.02.1L5 16z"/><path d="M13.74 9.74c2.3-2.3 3.23-5.1 2.08-6.25-1.15-1.15-3.95-.22-6.25 2.08-2.3 2.3-3.23 5.1-2.08 6.25 1.15 1.15 3.95.22 6.25-2.08z"/><path d="M7.49 11.82c.36.36.77.68 1.21.93l6.9 4.05c1.07.56 2.25-.08 3.69-1.51 1.43-1.44 2.07-2.62 1.51-3.7-.37-.71-1.72-3.01-4.05-6.89a6 6 0 0 0-.93-1.21"/>`,
  pick: `<path d="m11 7 6 6"/><path d="m4 16 11.7-11.7a1 1 0 0 1 1.4 0l2.6 2.6a1 1 0 0 1 0 1.4L8 20H4v-4z"/>`,
  layers: `<path d="m12 4-8 4 8 4 8-4-8-4"/><path d="m4 12 8 4 8-4"/><path d="m4 16 8 4 8-4"/>`,
  eye: `<path d="M10 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0"/><path d="M21 12c-2.4 4-5.4 6-9 6s-6.6-2-9-6c2.4-4 5.4-6 9-6s6.6 2 9 6"/>`,
  eyeOff: `<path d="M10.59 10.59a2 2 0 0 0 2.83 2.83"/><path d="M16.68 16.67A8.7 8.7 0 0 1 12 18c-3.6 0-6.6-2-9-6 1.27-2.12 2.71-3.68 4.32-4.67m2.86-1.15A9 9 0 0 1 12 6c3.6 0 6.6 2 9 6-.67 1.11-1.38 2.07-2.14 2.87"/><path d="m3 3 18 18"/>`,
  lock: `<path d="M5 13a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6z"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/>`,
  unlock: `<path d="M5 13a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6z"/><path d="M8 11V6a4 4 0 0 1 8 0"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  minus: `<path d="M5 12h14"/>`,
  dots: `<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>`,
  chevronDown: `<path d="m6 9 6 6 6-6"/>`,
  chevronUp: `<path d="m6 15 6-6 6 6"/>`,
  chevronLeft: `<path d="m15 18-6-6 6-6"/>`,
  chevronRight: `<path d="m9 18 6-6-6-6"/>`,
  fit: `<path d="M4 8V6a2 2 0 0 1 2-2h2M4 16v2a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v2M16 20h2a2 2 0 0 0 2-2v-2"/><path d="M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0"/>`,
  flat: `<path d="M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 12h16M12 4v16"/>`,
  target: `<path d="M5 12a7 7 0 1 0 14 0 7 7 0 1 0-14 0"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>`,
  slice: `<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="M3 13v3l9 5 9-5v-3"/>`,
  mirror: `<path d="M12 3v18"/><path d="M16 7v10h5L16 7"/><path d="M8 7v10H3L8 7"/>`,
  pencil: `<path d="M4 20h4L18.5 9.5a2.83 2.83 0 1 0-4-4L4 16v4"/><path d="m13.5 6.5 4 4"/>`,
  trash: `<path d="M4 7h16M10 11v6M14 11v6"/><path d="m5 7 1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/>`,
  cube: `<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3"/><path d="m12 12 8-4.5M12 12v9M12 12 4 7.5"/>`,
  close: `<path d="M18 6 6 18M6 6l12 12"/>`,
  cut: `<path d="M3 7a3 3 0 1 0 6 0 3 3 0 1 0-6 0M3 17a3 3 0 1 0 6 0 3 3 0 1 0-6 0"/><path d="M8.6 8.6 19 19M8.6 15.4 19 5"/>`,
  check: `<path d="m5 12 5 5L20 7"/>`,
  rotate: `<path d="M19.95 11a8 8 0 1 0-.5 4m.5 5v-5h-5"/>`,
  sphere: `<path d="M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0"/><path d="M3 12a9 3.5 0 0 0 18 0"/>`,
  cylinder: `<path d="M5 6a7 3 0 1 0 14 0 7 3 0 1 0-14 0"/><path d="M5 6v12a7 3 0 0 0 14 0V6"/>`,
  cone: `<path d="M12 3 4.5 18a7.5 3 0 0 0 15 0L12 3z"/>`,
  capsule: `<path d="M7 8a5 5 0 0 1 10 0v8a5 5 0 0 1-10 0V8z"/><path d="M7 9a5 2 0 0 0 10 0"/>`,
  pyramid: `<path d="M12 3 3 17.5l9 3.5 9-3.5L12 3z"/><path d="M12 3v18"/>`,
  diamond: `<path d="M12 3 4 12l8 9 8-9-8-9z"/><path d="m4 12 6 2.5 10-2.5M10 14.5 12 3m-2 11.5L12 21"/>`,
  wedge: `<path d="M3 19h12L3 9v10z"/><path d="m3 9 6-4 12 10-6 4"/>`,
  torus: `<path d="M3 12a9 5.5 0 1 0 18 0 9 5.5 0 1 0-18 0"/><path d="M8 11.5a4 2 0 0 0 8 0"/><path d="M9.2 12.4a3 1.4 0 0 1 5.6 0"/>`,
  hexagon: `<path d="M7.5 3.5h9L20.5 6l-4 2.5h-9L3.5 6l4-2.5z"/><path d="M3.5 6v12l4 2.5h9l4-2.5V6M7.5 8.5v12M16.5 8.5v12"/>`,
  arch: `<path d="M3 20v-8a9 9 0 0 1 18 0v8h-5v-8a4 4 0 0 0-8 0v8H3z"/>`,
  tube: `<path d="M4.5 18.5c2.5-8 5-11 8-6.5s5 2.5 7-6.5"/><path d="M2.5 18.5a2 2 0 1 0 4 0 2 2 0 1 0-4 0M17.5 5.5a2 2 0 1 0 4 0 2 2 0 1 0-4 0"/>`,
  wall: `<path d="M3 6h18v12H3zM3 12h18M9 6v6M15 12v6"/>`,
  slab: `<path d="M3 10.5 9 6l12 3-4.5 5H5z"/><path d="M3 10.5v3.5l2 4h11.5l4.5-5V9"/>`,
  pen: `<path d="M4.5 18.5c2.5-8 5-11 8-6.5s5 2.5 7-6.5"/><path d="M2.5 18.5a2 2 0 1 0 4 0 2 2 0 1 0-4 0M17.5 5.5a2 2 0 1 0 4 0 2 2 0 1 0-4 0"/>`,
  voxels: `<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>`,
  folder: `<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`,
  limb: `<path d="M4.5 19.5a2.5 2.5 0 0 1 0-3.5L15 5.5a1.6 1.6 0 0 1 3.5 3.5L8 19.5a2.5 2.5 0 0 1-3.5 0z"/><path d="M4 15.5 8.5 20"/>`,
  select: `<path d="M4 6V5a1 1 0 0 1 1-1h1m5 0h2m5 0h1a1 1 0 0 1 1 1v1m0 5v2m0 5v1a1 1 0 0 1-1 1h-1m-5 0h-2m-5 0H5a1 1 0 0 1-1-1v-1m0-5v-2"/>`,
  extrude: `<path d="m12 11.5 9 4.5-9 4.5-9-4.5 9-4.5z"/><path d="M12 16V3M8.5 6.5 12 3l3.5 3.5"/>`,
  move: `<path d="m18 9 3 3-3 3M15 12h6M6 9l-3 3 3 3M3 12h6M9 18l3 3 3-3M12 15v6M15 6l-3-3-3 3M12 3v6"/>`,
  parent: `<path d="M10 5a2 2 0 1 0 4 0 2 2 0 1 0-4 0M3 19a2 2 0 1 0 4 0 2 2 0 1 0-4 0M17 19a2 2 0 1 0 4 0 2 2 0 1 0-4 0"/><path d="m6.5 17.5 5.5-4.5 5.5 4.5M12 7v6"/>`,
  copy: `<path d="M7 9.67A2.67 2.67 0 0 1 9.67 7h8.66A2.67 2.67 0 0 1 21 9.67v8.66A2.67 2.67 0 0 1 18.33 21H9.67A2.67 2.67 0 0 1 7 18.33z"/><path d="M4.01 16.74A2 2 0 0 1 3 15V5c0-1.1.9-2 2-2h10c.75 0 1.16.38 1.5 1"/>`,
  share: `<path d="M3 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0M15 6a3 3 0 1 0 6 0 3 3 0 1 0-6 0M15 18a3 3 0 1 0 6 0 3 3 0 1 0-6 0"/><path d="m8.7 10.7 6.6-3.4M8.7 13.3l6.6 3.4"/>`,
  link: `<path d="m9 15 6-6"/><path d="m11 6 .46-.54a5 5 0 0 1 7.08 7.08L18 13"/><path d="m13 18-.4.53a5.07 5.07 0 0 1-7.12 0 4.97 4.97 0 0 1 0-7.07L6 11"/>`,
  headset: `<path d="M3 8a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3.6a2 2 0 0 1-1.75-1.03l-.9-1.62a2 2 0 0 0-3.5 0l-.9 1.62A2 2 0 0 1 7.6 17H4a1 1 0 0 1-1-1z"/><path d="M5.5 12a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0M15.5 12a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0"/>`,
  film: `<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M8 4v16M16 4v16M4 8h4M4 16h4M4 12h16M16 8h4M16 16h4"/>`,
  play: `<path d="M7 4v16l13-8z"/>`,
  pause: `<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>`,
  previous: `<path d="m15 6-6 6 6 6"/>`,
  next: `<path d="m9 6 6 6-6 6"/>`,
  duplicateFrame: `<path d="M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/><path d="M13.5 11.5v6M10.5 14.5h6"/>`,
  onion: `<path d="M9 12a5 5 0 1 0 10 0 5 5 0 1 0-10 0" stroke-dasharray="2 2.5"/><path d="M5 12a5 5 0 1 0 10 0 5 5 0 1 0-10 0"/>`,
  download: `<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><path d="m7 11 5 5 5-5M12 4v12"/>`,
  // selection modes: two overlapping squares, with the result drawn solid
  selectReplace: `<path d="M5 5h14v14H5z"/>`,
  selectAdd: `<path d="M3 3h12v6h6v12H9v-6H3z"/>`,
  selectSubtract: `<path d="M3 3h12v6H9v6H3z"/><path d="M15 9h6v12H9v-6" stroke-dasharray="2 3"/>`,
  selectIntersect: `<path d="M3 3h12v12H3zM9 9h12v12H9z" stroke-dasharray="2 3"/><path d="M9 9h6v6H9z" fill="currentColor"/>`,
} as const;

export type IconName = keyof typeof ICONS;
/** A built-in icon, or the inner markup of a 24×24 outline SVG (stroke = currentColor). */
export type IconSource = IconName | { svg: string };

export function Icon(props: { name: IconSource; size?: number }) {
  return (
    <svg
      class="icon"
      width={props.size ?? 20}
      height={props.size ?? 20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      innerHTML={typeof props.name === "string" ? ICONS[props.name] : props.name.svg}
    />
  );
}
