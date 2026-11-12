import { describe, expect, test } from "bun:test";
import { Vector3 } from "three";
import { PointFilter } from "./smoothing";

describe("point filter", () => {
  test("damps millimetre jitter while still", () => {
    const f = new PointFilter();
    let worst = 0;
    for (let i = 0; i < 90; i++) {
      const jitter = (i % 2 ? 1 : -1) * 0.002;
      const out = f.filter(new Vector3(jitter, 0, 0), i / 90);
      if (i > 10) worst = Math.max(worst, Math.abs(out.x));
    }
    expect(worst).toBeLessThan(0.0005);
  });

  test("keeps up with a fast stroke", () => {
    const f = new PointFilter();
    let out = new Vector3();
    // 1 m/s for a third of a second
    for (let i = 0; i <= 30; i++) out = f.filter(new Vector3(i / 90, 0, 0), i / 90);
    expect(30 / 90 - out.x).toBeLessThan(0.01);
  });

  test("a reset takes the next point as it is", () => {
    const f = new PointFilter();
    f.filter(new Vector3(0, 0, 0), 0);
    f.reset();
    expect(f.filter(new Vector3(1, 2, 3), 0.01).toArray()).toEqual([1, 2, 3]);
  });
});
