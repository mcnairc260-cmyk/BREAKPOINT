import {
  BALL_RADIUS,
  TABLE_LENGTH,
  TABLE_WIDTH,
} from './PhysicsConstants';
import type { Vec2 } from './Vec';

/**
 * The static collision world: cushion segments, pocket jaws, pocket mouths.
 *
 * Built once as a plain data structure so the renderer can draw exactly the
 * geometry the simulation collides against — there is no second, "visual"
 * table that could drift out of sync with this one.
 *
 * Layout (looking down, +x long axis, +y short axis, origin at table centre):
 *
 *     C---------S---------C     y = +W/2   (top long rail, two segments)
 *     |                   |
 *     |                   |     x = ±L/2   (head/foot short rails)
 *     |                   |
 *     C---------S---------C     y = -W/2   (bottom long rail, two segments)
 *
 * C = corner pocket, S = side pocket. Each cushion segment ends in a rounded
 * jaw; the jaws are what make a ball rattle instead of vanishing.
 */

/** A straight cushion face. `normal` points into the playing area. */
export interface RailSegment {
  readonly id: string;
  readonly a: Vec2;
  readonly b: Vec2;
  readonly normal: Vec2;
  /** Unit vector from a to b, precomputed. */
  readonly tangent: Vec2;
  readonly length: number;
}

/** A rounded cushion end. Balls collide with it as a static circle. */
export interface Jaw {
  readonly id: string;
  readonly centre: Vec2;
  readonly radius: number;
}

export interface Pocket {
  readonly id: string;
  readonly kind: 'corner' | 'side';
  readonly centre: Vec2;
  /** A ball whose centre comes within this of `centre` has dropped. */
  readonly captureRadius: number;
  /** Visual mouth radius, used by the renderer only. */
  readonly mouthRadius: number;
}

export interface TableGeometry {
  readonly length: number;
  readonly width: number;
  readonly rails: readonly RailSegment[];
  readonly jaws: readonly Jaw[];
  readonly pockets: readonly Pocket[];
  /** Head string x — where the cue ball is placed for a break. */
  readonly headStringX: number;
  /** Foot spot x — where the apex ball of the rack sits. */
  readonly footSpotX: number;
}

/** Corner pocket mouth, 4 1/2" measured between the jaw noses. */
const CORNER_MOUTH = 0.1143;
/** Side pocket mouth, 5". Sides are cut wider because the approach is worse. */
const SIDE_MOUTH = 0.127;
/** Radius of the rounded rubber jaw at each cushion end. */
const JAW_RADIUS = 0.012;

function segment(id: string, a: Vec2, b: Vec2, normal: Vec2): RailSegment {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  return { id, a, b, normal, tangent: { x: dx / length, y: dy / length }, length };
}

/**
 * Build the standard 9-foot table.
 *
 * The one number worth explaining: `cornerCut`. A corner pocket is cut at 45°,
 * so the cushion has to stop `mouth / sqrt(2)` short of the corner for the
 * mouth to measure `mouth` across the diagonal. Side pockets are cut square, so
 * their cushions simply stop half a mouth short of x = 0.
 */
export function createTable(): TableGeometry {
  const L = TABLE_LENGTH;
  const W = TABLE_WIDTH;
  const hx = L / 2;
  const hy = W / 2;

  const cornerCut = CORNER_MOUTH / Math.SQRT2; // ≈ 0.0808
  const sideCut = SIDE_MOUTH / 2; // ≈ 0.0635

  const rails: RailSegment[] = [
    // Top long rail (y = +hy), normal points down into the table.
    segment('rail-top-left', { x: -hx + cornerCut, y: hy }, { x: -sideCut, y: hy }, { x: 0, y: -1 }),
    segment('rail-top-right', { x: sideCut, y: hy }, { x: hx - cornerCut, y: hy }, { x: 0, y: -1 }),
    // Bottom long rail (y = -hy), normal points up.
    segment('rail-bottom-left', { x: -hx + cornerCut, y: -hy }, { x: -sideCut, y: -hy }, { x: 0, y: 1 }),
    segment('rail-bottom-right', { x: sideCut, y: -hy }, { x: hx - cornerCut, y: -hy }, { x: 0, y: 1 }),
    // Short rails.
    segment('rail-left', { x: -hx, y: -hy + cornerCut }, { x: -hx, y: hy - cornerCut }, { x: 1, y: 0 }),
    segment('rail-right', { x: hx, y: -hy + cornerCut }, { x: hx, y: hy - cornerCut }, { x: -1, y: 0 }),
  ];

  /**
   * Each jaw sits just *outside* the cushion face so that a ball hugging the
   * rail clears it and drops, which is how a real table plays. Offsetting by
   * the jaw radius puts the jaw's inner surface flush with the cushion line.
   */
  const jaws: Jaw[] = [];
  const addJaw = (id: string, centre: Vec2) => jaws.push({ id, centre, radius: JAW_RADIUS });

  for (const sy of [1, -1] as const) {
    addJaw(`jaw-corner-left-long-${sy}`, { x: -hx + cornerCut, y: sy * (hy + JAW_RADIUS) });
    addJaw(`jaw-side-left-${sy}`, { x: -sideCut, y: sy * (hy + JAW_RADIUS) });
    addJaw(`jaw-side-right-${sy}`, { x: sideCut, y: sy * (hy + JAW_RADIUS) });
    addJaw(`jaw-corner-right-long-${sy}`, { x: hx - cornerCut, y: sy * (hy + JAW_RADIUS) });
  }
  for (const sx of [1, -1] as const) {
    addJaw(`jaw-corner-${sx}-short-top`, { x: sx * (hx + JAW_RADIUS), y: hy - cornerCut });
    addJaw(`jaw-corner-${sx}-short-bottom`, { x: sx * (hx + JAW_RADIUS), y: -(hy - cornerCut) });
  }

  /**
   * Pocket centres sit back from the cushion line, inside the throat. A ball
   * has to travel past the jaws to reach the capture radius, which is what
   * makes a jaw-clipping ball rattle out instead of dropping anyway.
   */
  const cornerDrop = 0.026;
  const sideDrop = 0.030;
  const pockets: Pocket[] = [
    ...([1, -1] as const).flatMap((sx) =>
      ([1, -1] as const).map<Pocket>((sy) => ({
        id: `pocket-corner-${sx > 0 ? 'r' : 'l'}${sy > 0 ? 't' : 'b'}`,
        kind: 'corner',
        centre: { x: sx * (hx + cornerDrop), y: sy * (hy + cornerDrop) },
        captureRadius: CORNER_MOUTH / 2,
        mouthRadius: CORNER_MOUTH / 2,
      })),
    ),
    ...([1, -1] as const).map<Pocket>((sy) => ({
      id: `pocket-side-${sy > 0 ? 't' : 'b'}`,
      kind: 'side',
      centre: { x: 0, y: sy * (hy + sideDrop) },
      captureRadius: SIDE_MOUTH / 2 - BALL_RADIUS * 0.25,
      mouthRadius: SIDE_MOUTH / 2,
    })),
  ];

  return {
    length: L,
    width: W,
    rails,
    jaws,
    pockets,
    headStringX: -L / 4,
    footSpotX: L / 4,
  };
}
