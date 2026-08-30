import { FIXED_DT } from '../physics/PhysicsConstants';
import type { PhysicsWorld } from '../physics/PhysicsWorld';

/**
 * The only bridge from wall-clock frames to simulation steps.
 *
 * Frames arrive at whatever rate the display and the machine manage. The
 * simulation must not care. This accumulates real elapsed time and spends it in
 * whole FIXED_DT steps, so a 30 fps laptop and a 144 fps desktop run the *same*
 * number of steps over the same simulated interval and reach the same result.
 * The leftover is exposed as `alpha` purely so the renderer can interpolate;
 * nothing physical ever reads it.
 *
 * `maxFrameSeconds` caps how much time one frame may spend. Without it, a tab
 * returning from the background hands over several seconds at once and the
 * catch-up loop stalls the page — the classic spiral of death.
 */
export class FixedStepDriver {
  private accumulator = 0;
  /** Fraction of a step left over, in [0, 1). Render interpolation only. */
  alpha = 0;
  /** Steps executed on the most recent `advance()`. */
  lastStepCount = 0;

  constructor(
    private readonly world: PhysicsWorld,
    private readonly maxFrameSeconds = 0.25,
  ) {}

  /** Feed one frame's elapsed seconds. Returns the number of steps run. */
  advance(frameSeconds: number): number {
    if (!Number.isFinite(frameSeconds) || frameSeconds <= 0) {
      this.lastStepCount = 0;
      return 0;
    }
    this.accumulator += Math.min(frameSeconds, this.maxFrameSeconds);

    let steps = 0;
    while (this.accumulator >= FIXED_DT) {
      this.world.step();
      this.accumulator -= FIXED_DT;
      steps++;
    }
    this.alpha = this.accumulator / FIXED_DT;
    this.lastStepCount = steps;
    return steps;
  }

  reset(): void {
    this.accumulator = 0;
    this.alpha = 0;
    this.lastStepCount = 0;
  }
}
