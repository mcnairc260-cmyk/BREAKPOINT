/**
 * Minimal vector maths for the physics core.
 *
 * Deliberately plain objects rather than classes with methods: the simulation
 * allocates nothing per step in its hot loops, and plain records serialise
 * straight into shot records without a custom encoder.
 *
 * Convention used everywhere in `physics/`: the cloth is the z = 0 plane, +z is
 * up, ball centres sit at z = R. Linear motion is therefore two-dimensional
 * (`Vec2`) while angular velocity needs all three axes (`Vec3`) — ωz is English.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const clone2 = (a: Vec2): Vec2 => ({ x: a.x, y: a.y });
export const clone3 = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });

export const add2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale2 = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot2 = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const len2 = (a: Vec2): number => Math.hypot(a.x, a.y);
export const lenSq2 = (a: Vec2): number => a.x * a.x + a.y * a.y;

/** Normalise, returning the zero vector for a degenerate input rather than NaN. */
export function norm2(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y);
  if (l < 1e-12) return { x: 0, y: 0 };
  return { x: a.x / l, y: a.y / l };
}

/** Rotate 90° counter-clockwise — the "left of travel" direction. */
export const perp2 = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

export const add3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale3 = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const len3 = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

export const cross3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export function norm3(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z);
  if (l < 1e-12) return { x: 0, y: 0, z: 0 };
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** True only for real, representable numbers — the NaN/Infinity tripwire. */
export const isFiniteNum = (v: number): boolean => Number.isFinite(v);
