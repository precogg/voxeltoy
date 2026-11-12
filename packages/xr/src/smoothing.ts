import { Vector3 } from "three";

/**
 * Smooths a tracked point (a fingertip) with the One Euro filter: heavily while it is nearly
 * still, so tracking jitter doesn't flicker between cells, and hardly at all while it moves fast,
 * so a quick stroke doesn't lag. Positions in metres, times in seconds.
 */
export class PointFilter {
  private value: Vector3 | null = null;
  private speed = new Vector3();
  private time = 0;

  constructor(
    /** Cutoff (Hz) at rest: lower is steadier. */
    private minCutoff = 1,
    /** How fast the cutoff rises with speed (per m/s): higher lags less. */
    private beta = 20,
    private speedCutoff = 1,
  ) {}

  filter(point: Vector3, time: number): Vector3 {
    if (!this.value || time <= this.time) {
      this.value = point.clone();
      this.speed.set(0, 0, 0);
      this.time = time;
      return this.value.clone();
    }
    const dt = time - this.time;
    this.time = time;
    const raw = point.clone().sub(this.value).divideScalar(dt);
    this.speed.lerp(raw, alpha(this.speedCutoff, dt));
    const cutoff = this.minCutoff + this.beta * this.speed.length();
    this.value.lerp(point, alpha(cutoff, dt));
    return this.value.clone();
  }

  /** Forget the past: the next point is taken as it is (tracking came back). */
  reset() {
    this.value = null;
  }
}

function alpha(cutoff: number, dt: number) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
