/**
 * Every physical constant the simulation uses, in SI units (metres, kilograms,
 * seconds, radians). Nothing else in `physics/` may hard-code a magic number.
 *
 * Values are the regulation figures for a 9-foot American pool table and
 * 2 1/4" phenolic balls, with friction/restitution coefficients taken from the
 * ranges reported in the billiards-physics literature (Alciatore's technical
 * proofs and Marlow's *The Physics of Pocket Billiards*). Where a coefficient
 * is genuinely a range, the value here is the mid-range one and is marked as a
 * feel knob — those are safe to tune; the geometry is not.
 */

/** Gravity. */
export const GRAVITY = 9.80665;

/** Ball radius (2 1/4" diameter). */
export const BALL_RADIUS = 0.028575;
/** Ball mass (6 oz). */
export const BALL_MASS = 0.17;

/**
 * Moment of inertia of a solid sphere, I = 2/5 m R^2, and the derived factor
 * that turns a surface impulse into an angular-velocity change: Δω = (r × J)/I.
 */
export const BALL_INERTIA = 0.4 * BALL_MASS * BALL_RADIUS * BALL_RADIUS;
export const INV_BALL_INERTIA = 1 / BALL_INERTIA;

/** Playing surface, cushion nose to cushion nose: 100" x 50". */
export const TABLE_LENGTH = 2.54;
export const TABLE_WIDTH = 1.27;

/** Cushion nose height above the cloth — the regulation 0.635 x ball diameter. */
export const CUSHION_HEIGHT = 1.27 * BALL_RADIUS;

/** Coefficient of sliding friction between ball and cloth. Feel knob. */
export const MU_SLIDE = 0.2;
/** Rolling resistance once the ball rolls without slipping. Feel knob. */
export const MU_ROLL = 0.01;
/**
 * Spinning ("drilling") friction that bleeds English away while the ball sits
 * on the cloth. Applied to ωz only. Feel knob.
 */
export const MU_SPIN = 0.044;

/** Ball-ball normal restitution. Phenolic on phenolic is very nearly elastic. */
export const BALL_RESTITUTION = 0.95;
/**
 * Ball-ball surface friction. This is what produces "throw" — a cut shot
 * pushing the object ball off the pure line of centres — and transfers English
 * between balls. Small but not negligible.
 */
export const BALL_FRICTION = 0.06;

/** Cushion normal restitution. Cushions eat far more energy than balls do. */
export const RAIL_RESTITUTION = 0.75;
/** Cushion tangential friction — the source of spin-dependent rebound angles. */
export const RAIL_FRICTION = 0.2;

/** Pocket jaw restitution/friction. Jaws are rubber-faced like the cushions. */
export const JAW_RESTITUTION = 0.55;
export const JAW_FRICTION = 0.2;

/**
 * Rest thresholds. A ball below both is snapped to exactly zero so the
 * simulation terminates in finite time instead of asymptotically creeping.
 */
export const REST_SPEED = 0.005;
export const REST_SPIN = 0.05;

/** Simulation cadence. The renderer never changes this. */
export const FIXED_DT = 1 / 120;
/** Hard cap on simulated seconds for one shot, so a bug cannot hang the tab. */
export const MAX_SHOT_SECONDS = 60;

/**
 * Separation pushed between overlapping balls after an impulse is resolved.
 * Position-only: correcting overlap must never touch velocity, or the
 * correction becomes an energy source.
 */
export const OVERLAP_SLOP = 1e-6;

/** Fastest legal cue-ball speed — a hard break is about 12 m/s (27 mph). */
export const MAX_CUE_SPEED = 12;

/**
 * Furthest from centre the cue tip may strike, in ball radii. Beyond ~0.5R a
 * real tip miscues; 0.5 is the conventional playable limit.
 */
export const MAX_TIP_OFFSET = 0.5;
