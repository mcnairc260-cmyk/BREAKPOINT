import type { BallBody } from './BallBody';
import {
  BALL_FRICTION,
  BALL_MASS,
  BALL_RADIUS,
  BALL_RESTITUTION,
  INV_BALL_INERTIA,
  OVERLAP_SLOP,
} from './PhysicsConstants';

/**
 * Ball-ball detection and impulse resolution.
 *
 * Detection is continuous: `timeOfImpact` solves the quadratic for when two
 * balls travelling at constant velocity first touch, so a ball moving at break
 * speed (12 m/s = 10 cm per 120 Hz step, nearly two ball radii) cannot pass
 * through another between steps. The world uses the returned time to cut the
 * step short at the contact rather than integrating past it.
 *
 * Resolution is a two-part impulse:
 *   • a normal impulse along the line of centres with restitution e, and
 *   • a Coulomb-limited tangential impulse from the relative surface velocity,
 *     which is where throw and spin transfer come from.
 */

const DIAMETER = 2 * BALL_RADIUS;

/**
 * First time in (0, limit] at which `a` and `b` touch, or null.
 *
 * Solves |Δp + Δv t| = 2R. Balls already overlapping and still closing return
 * 0 so the caller resolves them immediately instead of letting them sink in.
 */
export function timeOfImpact(a: BallBody, b: BallBody, limit: number): number | null {
  const px = b.position.x - a.position.x;
  const py = b.position.y - a.position.y;
  const vx = b.velocity.x - a.velocity.x;
  const vy = b.velocity.y - a.velocity.y;

  const c = px * px + py * py - DIAMETER * DIAMETER;
  const bq = px * vx + py * vy;

  // Already touching and approaching: resolve now.
  if (c <= 0) return bq < 0 ? 0 : null;
  // Separating or parallel — a quadratic root would be in the past.
  if (bq >= 0) return null;

  const aq = vx * vx + vy * vy;
  if (aq < 1e-16) return null;

  const disc = bq * bq - aq * c;
  if (disc < 0) return null;

  const t = (-bq - Math.sqrt(disc)) / aq;
  if (t < 0 || t > limit) return null;
  return t;
}

/**
 * Resolve a contact between two balls.
 *
 * Returns the normal impulse magnitude, which the audio layer uses to scale the
 * click and the shot record stores as the collision's strength.
 *
 * `restitution` defaults to the real coefficient. The simultaneous-contact
 * solver overrides it with zero to reach the perfectly inelastic solution
 * first, then scales that result back up — see `PhysicsWorld.resolveBatch`.
 */
export function resolveBallCollision(
  a: BallBody,
  b: BallBody,
  restitution: number = BALL_RESTITUTION,
): number {
  let nx = b.position.x - a.position.x;
  let ny = b.position.y - a.position.y;
  const dist = Math.hypot(nx, ny);

  if (dist < 1e-9) {
    // Perfectly coincident centres cannot define a normal. Pick a stable axis
    // rather than dividing by zero and poisoning the world with NaN.
    nx = 1;
    ny = 0;
  } else {
    nx /= dist;
    ny /= dist;
  }

  const rvx = b.velocity.x - a.velocity.x;
  const rvy = b.velocity.y - a.velocity.y;
  const vn = rvx * nx + rvy * ny;
  if (vn > 0) return 0; // already separating

  // Normal impulse. Reduced mass for equal masses is m/2.
  const j = (-(1 + restitution) * vn * BALL_MASS) / 2;
  const jx = j * nx;
  const jy = j * ny;
  a.velocity.x -= jx / BALL_MASS;
  a.velocity.y -= jy / BALL_MASS;
  b.velocity.x += jx / BALL_MASS;
  b.velocity.y += jy / BALL_MASS;

  applyTangentialImpulse(a, b, nx, ny, j);
  separate(a, b, nx, ny, dist);

  a.resting = false;
  b.resting = false;
  return j;
}

/**
 * Surface friction at the contact point.
 *
 * Relative surface velocity is  u = Δv + R·(ω_a + ω_b) × n̂  — both balls'
 * spins add, because their contact points move in opposite senses. The
 * tangential impulse opposes u and is capped by Coulomb's μ|j|.
 */
function applyTangentialImpulse(a: BallBody, b: BallBody, nx: number, ny: number, j: number): void {
  // (ω_a + ω_b) × n̂, with n̂ = (nx, ny, 0).
  const wx = a.spin.x + b.spin.x;
  const wy = a.spin.y + b.spin.y;
  const wz = a.spin.z + b.spin.z;
  const cx = wy * 0 - wz * ny;
  const cy = wz * nx - wx * 0;
  const cz = wx * ny - wy * nx;

  let ux = a.velocity.x - b.velocity.x + BALL_RADIUS * cx;
  let uy = a.velocity.y - b.velocity.y + BALL_RADIUS * cy;
  const uz = BALL_RADIUS * cz;

  // Strip the normal component; only the tangential part is rubbed away.
  const un = ux * nx + uy * ny;
  ux -= un * nx;
  uy -= un * ny;

  const uMag = Math.hypot(ux, uy, uz);
  if (uMag < 1e-9) return;

  // Impulse that would exactly kill the slip, versus what friction allows.
  const stick = (uMag * BALL_MASS) / 2;
  const jt = Math.min(BALL_FRICTION * Math.abs(j), stick);
  const tx = (-ux / uMag) * jt;
  const ty = (-uy / uMag) * jt;
  const tz = (-uz / uMag) * jt;

  a.velocity.x += tx / BALL_MASS;
  a.velocity.y += ty / BALL_MASS;
  b.velocity.x -= tx / BALL_MASS;
  b.velocity.y -= ty / BALL_MASS;

  // Torque arm is +R n̂ on a and −R n̂ on b, and b takes −J, so both balls
  // receive the same Δω = (R n̂ × J_t) / I.
  const ax = BALL_RADIUS * (ny * tz - 0 * ty);
  const ay = BALL_RADIUS * (0 * tx - nx * tz);
  const az = BALL_RADIUS * (nx * ty - ny * tx);
  a.spin.x += ax * INV_BALL_INERTIA;
  a.spin.y += ay * INV_BALL_INERTIA;
  a.spin.z += az * INV_BALL_INERTIA;
  b.spin.x += ax * INV_BALL_INERTIA;
  b.spin.y += ay * INV_BALL_INERTIA;
  b.spin.z += az * INV_BALL_INERTIA;
}

/**
 * Positional overlap correction.
 *
 * Position only — never velocity. Nudging velocity to fix penetration is the
 * classic way a solver starts injecting energy, and the "no energy created"
 * regression test exists specifically to catch that.
 */
function separate(a: BallBody, b: BallBody, nx: number, ny: number, dist: number): void {
  const overlap = DIAMETER - dist;
  if (overlap <= 0) return;
  const push = overlap / 2 + OVERLAP_SLOP;
  a.position.x -= nx * push;
  a.position.y -= ny * push;
  b.position.x += nx * push;
  b.position.y += ny * push;
}
