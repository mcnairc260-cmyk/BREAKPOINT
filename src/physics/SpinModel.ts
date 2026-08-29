import type { BallBody } from './BallBody';
import { BALL_RADIUS, MAX_CUE_SPEED, MAX_TIP_OFFSET } from './PhysicsConstants';
import { clamp, type Vec2, type Vec3 } from './Vec';

/**
 * Turns a cue strike into linear and angular velocity.
 *
 * The tip contacts the ball at
 *     r = R · ( -c·â + a·ŝ + b·ẑ )
 * where â is the aim direction, ŝ = â × ẑ is "right of aim", a and b are the
 * tip offsets in ball radii, and c = sqrt(1 - a² - b²) puts the point on the
 * sphere. A central impulse J = m v₀ â then produces
 *     Δω = (r × J) / I = (5 v₀ / 2R) · ( a·ẑ − b·ŝ )
 *
 * Two sanity checks fall straight out of that expression, and both are asserted
 * in the test suite:
 *   • b = 0.4 gives ω = −v₀/R about ŝ, which is exactly the natural-roll
 *     condition — the classic "strike 2/5 of a radius high and the ball rolls
 *     immediately".
 *   • a > 0 (right English) gives ωz > 0, i.e. the right-hand side of the ball
 *     moving forward. That is the correct sense.
 *
 * Nothing here is decorative. The ω this returns is the ω the trajectory uses.
 */

export interface CueStrike {
  /** Aim direction, does not need to be normalised. */
  direction: Vec2;
  /** Cue ball speed immediately after contact, m/s. */
  speed: number;
  /** Tip offset right of centre, in ball radii. Positive = right English. */
  tipX: number;
  /** Tip offset above centre, in ball radii. Positive = follow/topspin. */
  tipY: number;
}

export interface StrikeImpulse {
  velocity: Vec2;
  spin: Vec3;
  /** The tip offsets actually used, after clamping to the miscue limit. */
  tipX: number;
  tipY: number;
  speed: number;
}

/**
 * Clamp a requested tip offset onto the miscue disc, preserving its direction
 * so the player's intent survives rather than snapping to an axis.
 */
export function clampTipOffset(tipX: number, tipY: number): { tipX: number; tipY: number } {
  const r = Math.hypot(tipX, tipY);
  if (r <= MAX_TIP_OFFSET || r === 0) return { tipX, tipY };
  const s = MAX_TIP_OFFSET / r;
  return { tipX: tipX * s, tipY: tipY * s };
}

export function computeStrike(strike: CueStrike): StrikeImpulse {
  const dirLen = Math.hypot(strike.direction.x, strike.direction.y);
  const ax = dirLen > 1e-12 ? strike.direction.x / dirLen : 1;
  const ay = dirLen > 1e-12 ? strike.direction.y / dirLen : 0;

  const speed = clamp(strike.speed, 0, MAX_CUE_SPEED);
  const { tipX, tipY } = clampTipOffset(strike.tipX, strike.tipY);

  // ŝ = â × ẑ — "right of aim" when looking down the shot.
  const sx = ay;
  const sy = -ax;

  const k = (2.5 * speed) / BALL_RADIUS;

  return {
    velocity: { x: ax * speed, y: ay * speed },
    // Δω = k · (a·ẑ − b·ŝ)
    spin: { x: -k * tipY * sx, y: -k * tipY * sy, z: k * tipX },
    tipX,
    tipY,
    speed,
  };
}

/** Apply a strike to the cue ball in place. */
export function applyStrike(cueBall: BallBody, strike: CueStrike): StrikeImpulse {
  const impulse = computeStrike(strike);
  cueBall.velocity.x = impulse.velocity.x;
  cueBall.velocity.y = impulse.velocity.y;
  cueBall.spin.x = impulse.spin.x;
  cueBall.spin.y = impulse.spin.y;
  cueBall.spin.z = impulse.spin.z;
  cueBall.resting = false;
  return impulse;
}
