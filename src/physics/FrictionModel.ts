import { contactVelocity, type BallBody } from './BallBody';
import {
  BALL_RADIUS,
  GRAVITY,
  MU_ROLL,
  MU_SLIDE,
  MU_SPIN,
} from './PhysicsConstants';

/**
 * Ball-cloth interaction: the sliding phase, the transition to rolling, rolling
 * resistance, and the independent decay of English.
 *
 * The model is the standard one for pocket billiards (Alciatore TP A.14 / A.19,
 * Marlow ch. 2). Two regimes, chosen by whether the contact patch is slipping:
 *
 *   SLIDING (|u| > 0)
 *     a = -μ_s g û
 *     α = (5 / 2R) · (-μ_s g) · (û_y, -û_x, 0)
 *     — the same friction force that decelerates the centre of mass also
 *       torques the ball, which is why draw turns into follow on its own.
 *
 *   ROLLING (u ≈ 0)
 *     a = -μ_r g v̂, and ω is held on the rolling constraint ω = (−v_y, v_x, 0)/R.
 *
 * ωz (English) is never part of either constraint. It decays on its own through
 * drilling friction, which is why side spin outlives the shot's roll.
 */

/** Below this contact-patch speed the ball is treated as rolling, not sliding. */
const SLIDE_EPSILON = 1e-4;

export type ClothPhase = 'sliding' | 'rolling' | 'stationary';

export function clothPhase(b: BallBody): ClothPhase {
  if (b.velocity.x === 0 && b.velocity.y === 0 && b.spin.x === 0 && b.spin.y === 0 && b.spin.z === 0) {
    return 'stationary';
  }
  const u = contactVelocity(b);
  return Math.hypot(u.x, u.y) > SLIDE_EPSILON ? 'sliding' : 'rolling';
}

/**
 * Advance one ball's velocity and spin under cloth friction for `dt`.
 *
 * Position integration is the caller's job — the world needs to interleave it
 * with collision resolution.
 */
export function applyClothFriction(b: BallBody, dt: number): void {
  if (dt <= 0) return;

  const u = contactVelocity(b);
  const uMag = Math.hypot(u.x, u.y);

  if (uMag > SLIDE_EPSILON) {
    applySliding(b, u, uMag, dt);
  } else {
    applyRolling(b, dt);
  }

  decaySpin(b, dt);
}

/**
 * Sliding phase.
 *
 * The friction impulse is capped at exactly what it takes to kill the slip, so
 * a long step can never overshoot into slipping the other way — overshoot is
 * how a naive integrator manufactures energy.
 */
function applySliding(b: BallBody, u: { x: number; y: number }, uMag: number, dt: number): void {
  const ux = u.x / uMag;
  const uy = u.y / uMag;

  // Rate at which friction closes the slip: linear (μg) plus the rotational
  // contribution (5/2 μg), because the same force does both jobs.
  const closeRate = MU_SLIDE * GRAVITY * (1 + 2.5);
  const dtSlip = Math.min(dt, uMag / closeRate);

  const dv = MU_SLIDE * GRAVITY * dtSlip;
  b.velocity.x -= dv * ux;
  b.velocity.y -= dv * uy;

  // α = (5 / 2R) · a_tangential, with the cross product for r = (0,0,-R) folded in.
  const dw = (2.5 * MU_SLIDE * GRAVITY * dtSlip) / BALL_RADIUS;
  b.spin.x -= dw * uy;
  b.spin.y += dw * ux;

  // Any remaining time in this step is spent rolling.
  const rest = dt - dtSlip;
  if (rest > 0) {
    snapToRolling(b);
    applyRolling(b, rest);
  }
}

/** Force the exact rolling constraint, removing the last of the numerical slip. */
export function snapToRolling(b: BallBody): void {
  b.spin.x = -b.velocity.y / BALL_RADIUS;
  b.spin.y = b.velocity.x / BALL_RADIUS;
}

/**
 * Rolling phase: rolling resistance decelerates the ball, and ω is dragged
 * along by the constraint rather than integrated independently.
 */
function applyRolling(b: BallBody, dt: number): void {
  const speed = Math.hypot(b.velocity.x, b.velocity.y);
  if (speed <= 0) {
    b.spin.x = 0;
    b.spin.y = 0;
    return;
  }
  const dv = Math.min(speed, MU_ROLL * GRAVITY * dt);
  const s = (speed - dv) / speed;
  b.velocity.x *= s;
  b.velocity.y *= s;
  snapToRolling(b);
}

/**
 * English decays independently of the roll. Clamped at zero so a long step can
 * never flip the spin direction.
 */
function decaySpin(b: BallBody, dt: number): void {
  const wz = b.spin.z;
  if (wz === 0) return;
  const rate = (2.5 * MU_SPIN * GRAVITY) / BALL_RADIUS;
  const drop = rate * dt;
  const mag = Math.abs(wz);
  b.spin.z = mag <= drop ? 0 : wz - Math.sign(wz) * drop;
}
