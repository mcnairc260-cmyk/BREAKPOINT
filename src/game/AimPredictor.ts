import type { BallBody } from '../physics/BallBody';
import { BALL_RADIUS } from '../physics/PhysicsConstants';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { railTimeOfImpact } from '../physics/RailCollision';
import type { Vec2 } from '../physics/Vec';

/**
 * The aiming line.
 *
 * A purely geometric ray cast — the same maths the simulation uses for
 * time-of-impact, but along a straight line and ignoring friction and spin. It
 * shows where the cue ball would arrive and, if it meets a ball, the ghost-ball
 * position and the line of centres the object ball will leave on.
 *
 * It deliberately does *not* run the simulation. An aiming line that predicted
 * curve, throw and spin would tell the player the answer; a straight line is
 * the same information a real player reads off the table, and it keeps the
 * preview free of the cost of a full solve every frame.
 */

export interface AimPrediction {
  /** Where the cue ball's path ends: a ball, a cushion, or the ray limit. */
  end: Vec2;
  /** Ghost-ball centre at contact, if the ray hits a ball. */
  ghost: Vec2 | null;
  /** The struck ball, if any. */
  target: BallBody | null;
  /** Unit direction the target would set off in (the line of centres). */
  targetDirection: Vec2 | null;
  /** Cue ball's tangent direction at contact — the 90-degree line. */
  cueTangent: Vec2 | null;
}

const MAX_RAY = 4.0;

export function predictAim(world: PhysicsWorld, angle: number): AimPrediction | null {
  const cue = world.cueBall;
  if (!cue || cue.pocketed) return null;

  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const origin = cue.position;

  let best = MAX_RAY;
  let target: BallBody | null = null;

  for (const ball of world.balls) {
    if (ball === cue || ball.pocketed) continue;
    const t = rayBall(origin, dx, dy, ball.position, best);
    if (t !== null && t < best) {
      best = t;
      target = ball;
    }
  }

  // Cushions, using the same solver the simulation uses so the preview cannot
  // disagree with what actually happens.
  const probe = {
    ...cue,
    position: { x: origin.x, y: origin.y },
    velocity: { x: dx, y: dy },
  } as BallBody;
  for (const rail of world.table.rails) {
    const t = railTimeOfImpact(probe, rail, best);
    if (t !== null && t < best) {
      best = t;
      target = null;
    }
  }

  const end = { x: origin.x + dx * best, y: origin.y + dy * best };

  if (!target) {
    return { end, ghost: null, target: null, targetDirection: null, cueTangent: null };
  }

  const nx = target.position.x - end.x;
  const ny = target.position.y - end.y;
  const nLen = Math.hypot(nx, ny) || 1;
  const targetDirection = { x: nx / nLen, y: ny / nLen };
  // The cue ball departs along the tangent, perpendicular to the line of
  // centres — the 90-degree rule, which is what a player actually aims with.
  const side = Math.sign(dx * targetDirection.y - dy * targetDirection.x) || 1;
  const cueTangent = { x: -targetDirection.y * side, y: targetDirection.x * side };

  return { end, ghost: end, target, targetDirection, cueTangent };
}

/**
 * Distance along the ray at which a ball of radius R centred on `origin`
 * first touches a stationary ball at `centre`.
 */
function rayBall(origin: Vec2, dx: number, dy: number, centre: Vec2, limit: number): number | null {
  const px = centre.x - origin.x;
  const py = centre.y - origin.y;
  const proj = px * dx + py * dy;
  if (proj <= 0) return null;

  const reach = 2 * BALL_RADIUS;
  const perpSq = px * px + py * py - proj * proj;
  const rSq = reach * reach;
  if (perpSq > rSq) return null;

  const t = proj - Math.sqrt(rSq - perpSq);
  if (t < 0 || t > limit) return null;
  return t;
}
