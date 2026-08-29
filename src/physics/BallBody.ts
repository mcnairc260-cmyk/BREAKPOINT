import { BALL_RADIUS, REST_SPEED, REST_SPIN } from './PhysicsConstants';
import { clone2, clone3, type Vec2, type Vec3 } from './Vec';

/**
 * One ball's complete dynamic state.
 *
 * `spin` is the full angular velocity vector in world axes: spin.x / spin.y are
 * the rolling axes (they are what topspin and backspin live on) and spin.z is
 * English. Everything the renderer needs to orient a ball comes from
 * integrating this, so spin is never faked visually.
 */
export interface BallBody {
  readonly id: number;
  /** 0 = cue ball, 1..15 = object balls. */
  readonly number: number;
  position: Vec2;
  velocity: Vec2;
  spin: Vec3;
  /** Accumulated orientation, as a quaternion (x, y, z, w). Render-only. */
  orientation: [number, number, number, number];
  /** True once the ball has dropped; pocketed balls leave the simulation. */
  pocketed: boolean;
  /** Which pocket it fell in, for the shot record. */
  pocketId: string | null;
  /** True when both velocity and spin are exactly zero. */
  resting: boolean;
}

export function createBall(id: number, number: number, position: Vec2): BallBody {
  return {
    id,
    number,
    position: clone2(position),
    velocity: { x: 0, y: 0 },
    spin: { x: 0, y: 0, z: 0 },
    orientation: [0, 0, 0, 1],
    pocketed: false,
    pocketId: null,
    resting: true,
  };
}

export function cloneBall(b: BallBody): BallBody {
  return {
    id: b.id,
    number: b.number,
    position: clone2(b.position),
    velocity: clone2(b.velocity),
    spin: clone3(b.spin),
    orientation: [...b.orientation] as [number, number, number, number],
    pocketed: b.pocketed,
    pocketId: b.pocketId,
    resting: b.resting,
  };
}

/** Linear kinetic energy, 1/2 m v². Mass is factored out by the caller. */
export function linearSpeedSq(b: BallBody): number {
  return b.velocity.x * b.velocity.x + b.velocity.y * b.velocity.y;
}

export function spinMagSq(b: BallBody): number {
  return b.spin.x * b.spin.x + b.spin.y * b.spin.y + b.spin.z * b.spin.z;
}

/**
 * Velocity of the contact patch where the ball touches the cloth, at
 * r = (0, 0, -R) from the centre:  u = v + ω × r.
 *
 * Expanding the cross product for r = (0,0,-R) gives u = (vx - R ωy, vy + R ωx).
 * When u is zero the ball rolls without slipping; while it is non-zero the ball
 * is sliding and sliding friction applies.
 */
export function contactVelocity(b: BallBody): Vec2 {
  return {
    x: b.velocity.x - BALL_RADIUS * b.spin.y,
    y: b.velocity.y + BALL_RADIUS * b.spin.x,
  };
}

/** Is this ball below both rest thresholds? */
export function belowRestThreshold(b: BallBody): boolean {
  const v = Math.hypot(b.velocity.x, b.velocity.y);
  const w = Math.hypot(b.spin.x, b.spin.y, b.spin.z);
  return v < REST_SPEED && w < REST_SPIN;
}

/** Snap a near-stopped ball to exact rest so the shot actually terminates. */
export function forceRest(b: BallBody): void {
  b.velocity.x = 0;
  b.velocity.y = 0;
  b.spin.x = 0;
  b.spin.y = 0;
  b.spin.z = 0;
  b.resting = true;
}

/**
 * Roll the render orientation forward by ω·dt.
 *
 * This is bookkeeping on top of the real physics, not a substitute for it: the
 * quaternion is derived from the same `spin` that drives the trajectory, so the
 * visible rotation and the physical rotation cannot disagree.
 */
export function integrateOrientation(b: BallBody, dt: number): void {
  const { x: wx, y: wy, z: wz } = b.spin;
  const mag = Math.hypot(wx, wy, wz);
  if (mag < 1e-9) return;
  const half = (mag * dt) / 2;
  const s = Math.sin(half) / mag;
  const dq: [number, number, number, number] = [wx * s, wy * s, wz * s, Math.cos(half)];
  const [qx, qy, qz, qw] = b.orientation;
  const [dx, dy, dz, dw] = dq;
  const nx = dw * qx + dx * qw + dy * qz - dz * qy;
  const ny = dw * qy - dx * qz + dy * qw + dz * qx;
  const nz = dw * qz + dx * qy - dy * qx + dz * qw;
  const nw = dw * qw - dx * qx - dy * qy - dz * qz;
  const inv = 1 / Math.hypot(nx, ny, nz, nw);
  b.orientation = [nx * inv, ny * inv, nz * inv, nw * inv];
}
