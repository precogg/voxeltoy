import { createMemo, For, Index } from "solid-js";
import type { Vec3 } from "@voxeltoy/core/types";

/** An anchor as one of three points per world axis: 0 low side, 1 middle, 2 high side. */
export type Anchor = Vec3;

const AXIS_COLORS = ["#e5484d", "#30a46c", "#3e7cf7"];
const AXIS_NAMES = ["X", "Y", "Z"];

// Cabinet projection: the front face is a flat square, depth recedes up and to the right at half
// scale. With these numbers no two of the 27 points land closer than half a step (40px at full
// size), so the nearest point to a tap is always the one that was meant.
const STEP = 80;
const DEPTH = 0.5;
const SLANT = Math.PI / 6;
const PAD = 36; // room for the axis arrows outside the cube
const W = PAD * 2 + STEP * (2 + 2 * DEPTH * Math.cos(SLANT));
const H = PAD * 2 + STEP * (2 + 2 * DEPTH * Math.sin(SLANT));

/** Screen position of a view-space point: right, up, back (each 0 to 2). */
function project(r: number, u: number, d: number): [number, number] {
  return [PAD + STEP * (r + DEPTH * d * Math.cos(SLANT)), H - PAD - STEP * (u + DEPTH * d * Math.sin(SLANT))];
}

/**
 * How the widget's view axes map to the world, from the camera's yaw: the face the camera looks
 * at most squarely (on its left) is drawn as the front, so the cube reads like the viewport.
 */
function orientation(yaw: number) {
  const q = (((Math.floor(yaw / (Math.PI / 2)) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  // [world axis, sign] of the view's right and of the direction toward the viewer
  const right: [number, number] = ([[0, 1], [2, -1], [0, -1], [2, 1]] as const)[q] as [number, number];
  const front: [number, number] = ([[2, 1], [0, 1], [2, -1], [0, -1]] as const)[q] as [number, number];
  return { right, front };
}

export function AnchorPicker(props: { value: Anchor; onChange: (anchor: Anchor) => void; yaw: number }) {
  const axes = createMemo(() => orientation(props.yaw));

  /** View cell (right, up, back) -> world anchor. */
  const toWorld = (r: number, u: number, d: number): Anchor => {
    const { right, front } = axes();
    const out: Anchor = [1, u, 1];
    out[right[0]] = right[1] > 0 ? r : 2 - r;
    out[front[0]] = front[1] > 0 ? 2 - d : d;
    return out;
  };
  /** World anchor -> view cell (right, up, back). */
  const toView = (a: Anchor): Vec3 => {
    const { right, front } = axes();
    const r = right[1] > 0 ? a[right[0]] : 2 - a[right[0]];
    const d = front[1] > 0 ? 2 - a[front[0]] : a[front[0]];
    return [r, a[1], d];
  };

  // back to front, so nearer points draw over farther ones
  const points: Vec3[] = [];
  for (let d = 2; d >= 0; d--) for (let u = 0; u < 3; u++) for (let r = 0; r < 3; r++) points.push([r, u, d]);

  const selected = createMemo(() => toView(props.value));
  const isSelected = (p: Vec3) => p.every((n, i) => n === selected()[i]);

  let svg!: SVGSVGElement;
  const pick = (e: PointerEvent) => {
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) * W) / rect.width;
    const y = ((e.clientY - rect.top) * H) / rect.height;
    let best = points[0];
    let bestDistance = Infinity;
    for (const p of points) {
      const [px, py] = project(...p);
      const distance = (px - x) ** 2 + (py - y) ** 2;
      if (distance < bestDistance) [best, bestDistance] = [p, distance];
    }
    const next = toWorld(...best);
    if (next.some((n, i) => n !== props.value[i])) props.onChange(next);
  };

  const onKey = (e: KeyboardEvent) => {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      ArrowDown: [1, -1],
      ArrowUp: [1, 1],
      PageDown: [2, -1], // toward the viewer
      PageUp: [2, 1], // away
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    e.stopPropagation();
    const view = [...selected()] as Vec3;
    view[move[0]] = Math.max(0, Math.min(2, view[move[0]] + move[1]));
    props.onChange(toWorld(...view));
  };

  // The cube's 12 edges; the three meeting at the hidden back-bottom-left corner are dashed.
  const edges = (() => {
    const out: { a: [number, number]; b: [number, number]; hidden: boolean }[] = [];
    for (const [r, u, d] of [[0, 0, 0], [0, 2, 0], [0, 0, 2], [0, 2, 2]]) out.push(edge([r, u, d], [2, u, d]));
    for (const [r, u, d] of [[0, 0, 0], [2, 0, 0], [0, 0, 2], [2, 0, 2]]) out.push(edge([r, u, d], [r, 2, d]));
    for (const [r, u, d] of [[0, 0, 0], [2, 0, 0], [0, 2, 0], [2, 2, 0]]) out.push(edge([r, u, d], [r, u, 2]));
    return out;
    function edge(a: number[], b: number[]) {
      const hidden = (p: number[]) => p[0] === 0 && p[1] === 0 && p[2] === 2;
      return { a: project(...(a as Vec3)), b: project(...(b as Vec3)), hidden: hidden(a) || hidden(b) };
    }
  })();

  /**
   * One visible edge per world axis, colored like the viewport's axes, with an arrow beside it
   * pointing toward + and the axis letter at the arrow's tip.
   */
  const axisEdges = createMemo(() => {
    const { right, front } = axes();
    const c = Math.cos(SLANT);
    const s = Math.sin(SLANT);
    const towardViewer: [number, number] = [-c, s];
    return [
      // bottom front edge, arrow below it
      { axis: right[0], a: project(0, 0, 0), b: project(2, 0, 0), out: [0, 1], dir: [right[1], 0] },
      // front left edge, arrow to its left
      { axis: 1, a: project(0, 0, 0), b: project(0, 2, 0), out: [-1, 0], dir: [0, -1] },
      // bottom right edge, arrow below and right of it
      {
        axis: front[0],
        a: project(2, 0, 0),
        b: project(2, 0, 2),
        out: [s, c],
        dir: [towardViewer[0] * front[1], towardViewer[1] * front[1]],
      },
    ].map(({ axis, a, b, out, dir }) => {
      const mid = [(a[0] + b[0]) / 2 + out[0] * 12, (a[1] + b[1]) / 2 + out[1] * 12];
      const at = (t: number) => [mid[0] + dir[0] * t, mid[1] + dir[1] * t] as [number, number];
      const tip = at(9);
      const head = [-1, 1].map((side) => [
        tip[0] - dir[0] * 5 + -dir[1] * side * 3.5,
        tip[1] - dir[1] * 5 + dir[0] * side * 3.5,
      ]);
      return {
        axis,
        a,
        b,
        tail: at(-9),
        tip,
        head: `${tip[0]},${tip[1]} ${head[0][0]},${head[0][1]} ${head[1][0]},${head[1][1]}`,
        label: at(19),
      };
    });
  });

  return (
    <svg
      ref={svg}
      class="anchor-picker"
      viewBox={`0 0 ${W} ${H}`}
      tabindex="0"
      role="group"
      aria-label="Anchor: the point that stays put. Arrow keys move it; Page Up and Page Down move it back and forward."
      onPointerDown={(e) => {
        svg.setPointerCapture(e.pointerId);
        svg.focus({ preventScroll: true });
        pick(e);
      }}
      onPointerMove={(e) => svg.hasPointerCapture(e.pointerId) && pick(e)}
      onKeyDown={onKey}
    >
      <For each={edges}>
        {(e) => (
          <line
            class="anchor-edge"
            data-hidden={e.hidden ? "" : undefined}
            x1={e.a[0]}
            y1={e.a[1]}
            x2={e.b[0]}
            y2={e.b[1]}
          />
        )}
      </For>
      <For each={axisEdges()}>
        {(e) => (
          <g class="anchor-axis" stroke={AXIS_COLORS[e.axis]} fill={AXIS_COLORS[e.axis]}>
            <line x1={e.a[0]} y1={e.a[1]} x2={e.b[0]} y2={e.b[1]} />
            <line class="anchor-arrow" x1={e.tail[0]} y1={e.tail[1]} x2={e.tip[0]} y2={e.tip[1]} />
            <polygon points={e.head} stroke="none" />
            <text x={e.label[0]} y={e.label[1]} stroke="none">
              {AXIS_NAMES[e.axis]}
            </text>
          </g>
        )}
      </For>
      <Index each={points}>
        {(p) => {
          const [x, y] = project(...p());
          const depth = p()[2];
          return (
            <circle
              class="anchor-dot"
              data-active={isSelected(p()) ? "" : undefined}
              data-depth={depth}
              cx={x}
              cy={y}
              r={isSelected(p()) ? 9 : 6 - depth}
            />
          );
        }}
      </Index>
    </svg>
  );
}

/** "Keeps the floor, the X middle and the +Z side in place." */
export function describeAnchor(a: Anchor) {
  const parts = [0, 1, 2].map((axis) => {
    if (a[axis] === 1) return `the ${AXIS_NAMES[axis]} middle`;
    if (axis === 1) return a[axis] === 0 ? "the floor" : "the top";
    return `the ${a[axis] === 0 ? "−" : "+"}${AXIS_NAMES[axis]} side`;
  });
  // put the floor/top first; it reads most naturally
  const ordered = [parts[1], parts[0], parts[2]];
  return `Keeps ${ordered[0]}, ${ordered[1]} and ${ordered[2]} in place.`;
}

/** The anchor as `editor.resize`'s fractions. */
export function anchorFractions(a: Anchor): Vec3 {
  return a.map((n) => n / 2) as Vec3;
}
