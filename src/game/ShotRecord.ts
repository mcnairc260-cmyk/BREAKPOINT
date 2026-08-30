import { cloneBall, type BallBody } from '../physics/BallBody';
import type { SimEvent } from '../physics/PhysicsWorld';
import type { Vec2, Vec3 } from '../physics/Vec';

/**
 * The complete, replayable description of one shot.
 *
 * Everything Phase 2 and beyond needs is derived from this and nothing else:
 * rules need the first contact, the rail contacts and the scratch flag; the AI
 * needs the pre-shot state and the parameters that produced the outcome;
 * replay and multiplayer need the pre-shot state plus the strike, because the
 * simulation is deterministic and will reproduce the rest exactly.
 *
 * Being a plain data object is deliberate — `JSON.stringify` on one of these is
 * a complete, portable shot.
 */

/** One ball-to-ball contact, by ball number. */
export interface BallContact {
  a: number;
  b: number;
  /** Normal impulse magnitude, N·s. */
  impulse: number;
  /** True if this happened after the cue ball's first object-ball contact. */
  afterFirstContact: boolean;
}

/** One cushion or jaw contact, by ball number. */
export interface RailContact {
  ball: number;
  /** Rail or jaw id from the table geometry. */
  id: string;
  impulse: number;
  afterFirstContact: boolean;
}

export interface BallSnapshot {
  id: number;
  number: number;
  position: Vec2;
  velocity: Vec2;
  spin: Vec3;
  pocketed: boolean;
  pocketId: string | null;
}

export interface ShotRecord {
  /** Monotonic index within the session. */
  index: number;
  /** Wall-clock time the shot was committed, for ordering across sessions. */
  timestamp: number;

  // --- inputs -------------------------------------------------------------
  preShotBalls: BallSnapshot[];
  cueBallPosition: Vec2;
  /** Aim heading in radians, measured from +x. */
  aimAngle: number;
  /** Normalised power the player dialled in, 0..1. */
  power: number;
  /** Cue tip contact point in ball radii: x right of centre, y above centre. */
  cueContactPoint: Vec2;

  // --- what the strike actually produced -----------------------------------
  impulse: {
    velocity: Vec2;
    spin: Vec3;
    speed: number;
  };

  // --- what happened -------------------------------------------------------
  events: SimEvent[];
  /** Ball numbers pocketed, in the order they dropped. */
  ballsPocketed: number[];
  /** Pocket ids, parallel to `ballsPocketed`. */
  pocketsUsed: string[];
  /**
   * Every ball-to-ball contact, in order, by ball number.
   *
   * A referee needs the whole contact graph, not just the first one: whether
   * the cue ball went on to touch anything else, and which object balls drove
   * which, are both ordinary questions about a shot.
   */
  ballContacts: BallContact[];
  /**
   * Every cushion contact, in order.
   *
   * Recorded per ball and flagged relative to the cue ball's first object-ball
   * contact, because the question a rules engine actually asks is "after the
   * legal first contact, did any ball reach a cushion" — which a bare list of
   * rail ids cannot answer.
   */
  railContacts: RailContact[];
  /**
   * Pocket-jaw contacts, kept separate from cushions on purpose: a jaw is part
   * of the pocket casting, not a cushion, so it must not satisfy a
   * ball-to-rail requirement.
   */
  jawContacts: RailContact[];
  /** Number of the first object ball the cue ball touched, or null. */
  firstObjectBallContact: number | null;
  /**
   * Index into `events` of that first contact, or null. Lets any consumer
   * partition the event stream into before and after the legal contact without
   * re-deriving it.
   */
  firstContactEventIndex: number | null;
  /** True if the cue ball was pocketed. */
  scratch: boolean;
  postShotBalls: BallSnapshot[];
  /** Simulated seconds from strike to the last ball stopping. */
  durationSeconds: number;
  /** Simulation steps consumed. Determinism checks compare this too. */
  steps: number;
}

export function snapshotBall(b: BallBody): BallSnapshot {
  const c = cloneBall(b);
  return {
    id: c.id,
    number: c.number,
    position: c.position,
    velocity: c.velocity,
    spin: c.spin,
    pocketed: c.pocketed,
    pocketId: c.pocketId,
  };
}

/**
 * Reduce a raw event stream into the summary fields.
 *
 * `cueBallId` is needed because "first object ball contact" is specifically the
 * cue ball's first contact — object balls hitting each other during a break do
 * not count, and getting that wrong would quietly break every rules variant
 * built on top of this later.
 */
export function summariseEvents(
  events: readonly SimEvent[],
  cueBallId: number,
  ballNumberById: (id: number) => number,
) {
  const ballsPocketed: number[] = [];
  const pocketsUsed: string[] = [];
  const ballContacts: BallContact[] = [];
  const railContacts: RailContact[] = [];
  const jawContacts: RailContact[] = [];
  let firstObjectBallContact: number | null = null;
  let firstContactEventIndex: number | null = null;
  let scratch = false;

  const after = () => firstContactEventIndex !== null;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    switch (e.type) {
      case 'ball-ball': {
        const involvesCue = e.a === cueBallId || e.b === cueBallId;
        if (firstObjectBallContact === null && involvesCue) {
          firstObjectBallContact = ballNumberById(e.a === cueBallId ? e.b : e.a);
          firstContactEventIndex = i;
          // This contact *is* the first contact, so it is not "after" it.
          ballContacts.push({
            a: ballNumberById(e.a),
            b: ballNumberById(e.b),
            impulse: e.impulse,
            afterFirstContact: false,
          });
          break;
        }
        ballContacts.push({
          a: ballNumberById(e.a),
          b: ballNumberById(e.b),
          impulse: e.impulse,
          afterFirstContact: after(),
        });
        break;
      }
      case 'rail':
        railContacts.push({
          ball: ballNumberById(e.ball),
          id: e.rail,
          impulse: e.impulse,
          afterFirstContact: after(),
        });
        break;
      case 'jaw':
        jawContacts.push({
          ball: ballNumberById(e.ball),
          id: e.jaw,
          impulse: e.impulse,
          afterFirstContact: after(),
        });
        break;
      case 'pocket':
        ballsPocketed.push(ballNumberById(e.ball));
        pocketsUsed.push(e.pocket);
        if (e.ball === cueBallId) scratch = true;
        break;
      case 'rest':
        break;
    }
  }

  return {
    ballsPocketed,
    pocketsUsed,
    ballContacts,
    railContacts,
    jawContacts,
    firstObjectBallContact,
    firstContactEventIndex,
    scratch,
  };
}
