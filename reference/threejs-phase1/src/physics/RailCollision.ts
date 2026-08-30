import type { BallBody } from './BallBody';
import {
  BALL_MASS,
  BALL_RADIUS,
  CUSHION_HEIGHT,
  INV_BALL_INERTIA,
  JAW_FRICTION,
  JAW_RESTITUTION,
  OVERLAP_SLOP,
  RAIL_FRICTION,
  RAIL_RESTITUTION,
} from './PhysicsConstants';
import type { Jaw, RailSegment } from './TableGeometry';

/**
 * Cushion and jaw collisions.
 *
 * The detail that makes a cushion behave like a cushion rather than a wall is
 * where it touches the ball. A regulation cushion nose sits at ~1.27 R above
 * the cloth, which is *above* the ball's centre, so the contact point is
 *
 *     r = R · ( -n̂·cosθ + ẑ·sinθ ),   sinθ = (h − R) / R
 *
 * Two consequences follow, and both are things players rely on:
 *   • the normal impulse acts above the centre of mass, so it torques the ball
 *     forward — a ball comes off a rail with more topspin than it arrived with;
 *   • the contact point has a velocity contribution from ωz, so English
 *     produces a tangential friction impulse along the rail and the ball
 *     rebounds off the mirror angle. That is "running" and "reverse" English.
 *
 * Resolution uses the textbook rigid-body contact impulse
 *     J = −(1+e)·v_contact·n̂ / K,   K = 1/m + |r × n̂|² / I
 * which, for e ≤ 1 and a Coulomb-limited tangential part, cannot increase the
 * ball's total energy. That property is asserted by the regression suite.
 */

/** sinθ / cosθ of the contact point, precomputed from the nose height. */
const SIN_THETA = (CUSHION_HEIGHT - BALL_RADIUS) / BALL_RADIUS;
const COS_THETA = Math.sqrt(Math.max(0, 1 - SIN_THETA * SIN_THETA));

export interface RailHit {
  kind: 'rail';
  rail: RailSegment;
  time: number;
}

export interface JawHit {
  kind: 'jaw';
  jaw: Jaw;
  time: number;
}

/**
 * First time in (0, limit] at which the ball reaches the cushion face, or null.
 *
 * The contact must land within the segment's span; a ball heading past the end
 * of a cushion is the jaws' problem, not the rail's.
 */
export function railTimeOfImpact(ball: BallBody, rail: RailSegment, limit: number): number | null {
  const n = rail.normal;
  const d = (ball.position.x - rail.a.x) * n.x + (ball.position.y - rail.a.y) * n.y;
  const vn = ball.velocity.x * n.x + ball.velocity.y * n.y;

  let t: number;
  if (d <= BALL_RADIUS) {
    // Already touching or through the face; only act if still closing.
    if (vn >= 0) return null;
    t = 0;
  } else {
    if (vn >= -1e-12) return null;
    t = (d - BALL_RADIUS) / -vn;
    if (t > limit) return null;
  }

  const cx = ball.position.x + ball.velocity.x * t;
  const cy = ball.position.y + ball.velocity.y * t;
  const s = (cx - rail.a.x) * rail.tangent.x + (cy - rail.a.y) * rail.tangent.y;
  if (s < 0 || s > rail.length) return null;
  return t;
}

/** Same quadratic as ball-ball, against a static circle of radius `jaw.radius`. */
export function jawTimeOfImpact(ball: BallBody, jaw: Jaw, limit: number): number | null {
  const reach = BALL_RADIUS + jaw.radius;
  const px = jaw.centre.x - ball.position.x;
  const py = jaw.centre.y - ball.position.y;
  const vx = -ball.velocity.x;
  const vy = -ball.velocity.y;

  const c = px * px + py * py - reach * reach;
  const b = px * vx + py * vy;
  if (c <= 0) return b < 0 ? 0 : null;
  if (b >= 0) return null;

  const a = vx * vx + vy * vy;
  if (a < 1e-16) return null;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / a;
  if (t < 0 || t > limit) return null;
  return t;
}

/** Signed gap between the ball surface and the cushion face; negative = inside. */
export function railGap(ball: BallBody, rail: RailSegment): number {
  const d = (ball.position.x - rail.a.x) * rail.normal.x + (ball.position.y - rail.a.y) * rail.normal.y;
  return d - BALL_RADIUS;
}

/** Is the ball's closest point to the cushion actually within the segment span? */
export function withinRailSpan(ball: BallBody, rail: RailSegment): boolean {
  const s =
    (ball.position.x - rail.a.x) * rail.tangent.x + (ball.position.y - rail.a.y) * rail.tangent.y;
  return s >= 0 && s <= rail.length;
}

/**
 * Push a penetrating ball back out of a cushion. Position only — this exists so
 * that a ball the impulse solver declined to act on (because its contact point
 * was already separating) still cannot sink through the geometry.
 */
export function depenetrateRail(ball: BallBody, rail: RailSegment): void {
  const gap = railGap(ball, rail);
  if (gap >= 0) return;
  ball.position.x += rail.normal.x * (-gap + OVERLAP_SLOP);
  ball.position.y += rail.normal.y * (-gap + OVERLAP_SLOP);
}

/** Same, for a jaw circle. */
export function depenetrateJaw(ball: BallBody, jaw: Jaw): void {
  const dx = ball.position.x - jaw.centre.x;
  const dy = ball.position.y - jaw.centre.y;
  const dist = Math.hypot(dx, dy);
  const reach = BALL_RADIUS + jaw.radius;
  if (dist >= reach) return;
  if (dist < 1e-9) {
    ball.position.x = jaw.centre.x + reach + OVERLAP_SLOP;
    return;
  }
  const push = (reach - dist + OVERLAP_SLOP) / dist;
  ball.position.x += dx * push;
  ball.position.y += dy * push;
}

export function resolveRailCollision(
  ball: BallBody,
  rail: RailSegment,
  restitution: number = RAIL_RESTITUTION,
): number {
  const j = resolveCushionContact(ball, rail.normal.x, rail.normal.y, restitution, RAIL_FRICTION);
  // Push clear of the face so the next step does not re-detect the same hit.
  const d = (ball.position.x - rail.a.x) * rail.normal.x + (ball.position.y - rail.a.y) * rail.normal.y;
  const overlap = BALL_RADIUS - d;
  if (overlap > 0) {
    ball.position.x += rail.normal.x * (overlap + OVERLAP_SLOP);
    ball.position.y += rail.normal.y * (overlap + OVERLAP_SLOP);
  }
  return j;
}

export function resolveJawCollision(
  ball: BallBody,
  jaw: Jaw,
  restitution: number = JAW_RESTITUTION,
): number {
  let nx = ball.position.x - jaw.centre.x;
  let ny = ball.position.y - jaw.centre.y;
  const dist = Math.hypot(nx, ny);
  if (dist < 1e-9) {
    nx = 1;
    ny = 0;
  } else {
    nx /= dist;
    ny /= dist;
  }

  const j = resolveCushionContact(ball, nx, ny, restitution, JAW_FRICTION);

  const reach = BALL_RADIUS + jaw.radius;
  const overlap = reach - dist;
  if (overlap > 0) {
    ball.position.x += nx * (overlap + OVERLAP_SLOP);
    ball.position.y += ny * (overlap + OVERLAP_SLOP);
  }
  return j;
}

/**
 * The shared impulse solver for any cushion-height contact whose inward normal
 * is (nx, ny). Returns the normal impulse magnitude.
 */
function resolveCushionContact(
  ball: BallBody,
  nx: number,
  ny: number,
  restitution: number,
  friction: number,
): number {
  // Contact point on the ball, at cushion-nose height.
  const rx = -nx * COS_THETA * BALL_RADIUS;
  const ry = -ny * COS_THETA * BALL_RADIUS;
  const rz = SIN_THETA * BALL_RADIUS;

  // v_contact = v + ω × r  (ball velocity is planar, so vz = 0).
  const w = ball.spin;
  const cvx = ball.velocity.x + (w.y * rz - w.z * ry);
  const cvy = ball.velocity.y + (w.z * rx - w.x * rz);

  const vn = cvx * nx + cvy * ny;
  if (vn >= 0) return 0; // separating

  // K = 1/m + |r × n̂|² / I  — the effective mass along the normal.
  const rxnX = ry * 0 - rz * ny;
  const rxnY = rz * nx - rx * 0;
  const rxnZ = rx * ny - ry * nx;
  const kn = 1 / BALL_MASS + (rxnX * rxnX + rxnY * rxnY + rxnZ * rxnZ) * INV_BALL_INERTIA;

  const jn = (-(1 + restitution) * vn) / kn;
  applyImpulse(ball, jn * nx, jn * ny, 0, rx, ry, rz);

  // Friction is evaluated on the slip that remains *after* the normal impulse:
  // that impulse acts above the centre and therefore changes the contact
  // point's velocity, so using the pre-impulse slip would over-apply friction
  // and could push the contact past sticking into slipping the other way.
  applyCushionFriction(ball, nx, ny, rx, ry, rz, jn, friction);

  // Balls stay on the cloth in this simulation: no jumps, no scoops. Dropping
  // the vertical component can only remove energy, never add it.
  ball.resting = false;
  return jn;
}

function applyCushionFriction(
  ball: BallBody,
  nx: number,
  ny: number,
  rx: number,
  ry: number,
  rz: number,
  jn: number,
  friction: number,
): void {
  const w = ball.spin;
  const cvx = ball.velocity.x + (w.y * rz - w.z * ry);
  const cvy = ball.velocity.y + (w.z * rx - w.x * rz);
  const cvz = w.x * ry - w.y * rx;
  const vn = cvx * nx + cvy * ny;

  // Tangential part of the contact velocity.
  let tx = cvx - vn * nx;
  let ty = cvy - vn * ny;
  let tz = cvz;
  const tMag = Math.hypot(tx, ty, tz);
  if (tMag < 1e-9) return;
  tx /= tMag;
  ty /= tMag;
  tz /= tMag;

  const rxtX = ry * tz - rz * ty;
  const rxtY = rz * tx - rx * tz;
  const rxtZ = rx * ty - ry * tx;
  const kt = 1 / BALL_MASS + (rxtX * rxtX + rxtY * rxtY + rxtZ * rxtZ) * INV_BALL_INERTIA;

  // Either friction stops the slip outright, or Coulomb caps it at μ|Jn|.
  const stick = tMag / kt;
  const jt = -Math.min(friction * Math.abs(jn), stick);
  applyImpulse(ball, jt * tx, jt * ty, jt * tz, rx, ry, rz);
}

/** Δv = J/m (planar only) and Δω = (r × J)/I. */
function applyImpulse(
  ball: BallBody,
  jx: number,
  jy: number,
  jz: number,
  rx: number,
  ry: number,
  rz: number,
): void {
  ball.velocity.x += jx / BALL_MASS;
  ball.velocity.y += jy / BALL_MASS;
  ball.spin.x += (ry * jz - rz * jy) * INV_BALL_INERTIA;
  ball.spin.y += (rz * jx - rx * jz) * INV_BALL_INERTIA;
  ball.spin.z += (rx * jy - ry * jx) * INV_BALL_INERTIA;
}
