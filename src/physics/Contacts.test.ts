import { describe, expect, it } from 'vitest';
import { cloneBall } from './BallBody';
import {
  BALL_MASS,
  BALL_RADIUS,
  BALL_RESTITUTION,
  GRAVITY,
  MU_ROLL,
  TABLE_LENGTH,
  TABLE_WIDTH,
} from './PhysicsConstants';
import { PhysicsWorld } from './PhysicsWorld';
import { applyStrike } from './SpinModel';
import { createTable } from './TableGeometry';

/**
 * Contact-resolution and cloth regression tests added by the Phase 1
 * validation pass.
 *
 * These cover ground the original suite did not: glancing contacts, the two
 * English directions as distinct physical effects, simultaneous contacts,
 * overlap recovery, pocket capture across the speed range, and the rolling
 * resistance relationship. Expected values are closed-form results or physical
 * invariants, never numbers read back out of the implementation.
 */

const R = BALL_RADIUS;
const world = () => new PhysicsWorld(createTable());

/** Step until the first ball-ball contact is recorded, or give up. */
function stepToContact(w: PhysicsWorld, limit = 400): boolean {
  for (let i = 0; i < limit; i++) {
    w.step();
    if (w.events.some((e) => e.type === 'ball-ball')) return true;
  }
  return false;
}

describe('glancing collision', () => {
  it('a near-miss barely disturbs the cue ball and moves the object ball slowly', () => {
    const w = world();
    const cue = w.addBall(0, { x: -0.5, y: 0 });
    // Contact offset 1.9R out of the 2R that would be a complete miss: about
    // as thin a cut as it is possible to hit.
    const object = w.addBall(1, { x: 0, y: 1.9 * R });
    cue.velocity = { x: 4, y: 0 };
    cue.resting = false;

    expect(stepToContact(w)).toBe(true);

    const cueSpeed = Math.hypot(cue.velocity.x, cue.velocity.y);
    const objectSpeed = Math.hypot(object.velocity.x, object.velocity.y);

    // The object ball leaves along the line of centres, which is nearly
    // perpendicular to the cue ball's path, so it gets very little speed.
    expect(object.velocity.y).toBeGreaterThan(0);
    expect(objectSpeed).toBeLessThan(0.45 * cueSpeed);
    // And the cue ball keeps most of what it had.
    expect(cueSpeed).toBeGreaterThan(3.3);
    // Deflected the opposite way to the object ball.
    expect(cue.velocity.y).toBeLessThan(0);
  });

  it('the thinner the cut, the less the object ball receives', () => {
    const speedAt = (offset: number) => {
      const w = world();
      const cue = w.addBall(0, { x: -0.5, y: 0 });
      const object = w.addBall(1, { x: 0, y: offset * R });
      cue.velocity = { x: 4, y: 0 };
      cue.resting = false;
      stepToContact(w);
      return Math.hypot(object.velocity.x, object.velocity.y);
    };
    const full = speedAt(0);
    const half = speedAt(1.0);
    const thin = speedAt(1.9);
    expect(full).toBeGreaterThan(half);
    expect(half).toBeGreaterThan(thin);
  });
});

describe('left and right English', () => {
  it('are equal and opposite about the aim line', () => {
    const strike = (tipX: number) => {
      const w = world();
      const cue = w.addBall(0, { x: -0.9, y: 0 });
      applyStrike(cue, { direction: { x: 1, y: 0 }, speed: 3, tipX, tipY: 0 });
      const spinZ = cue.spin.z;
      w.simulateToRest();
      return { spinZ, finalY: cue.position.y };
    };
    const right = strike(0.45);
    const left = strike(-0.45);
    const none = strike(0);

    // Right English spins the ball counter-clockwise seen from above, so the
    // right-hand side of the ball moves forward. Left is its mirror.
    expect(right.spinZ).toBeGreaterThan(0);
    expect(left.spinZ).toBeLessThan(0);
    expect(right.spinZ + left.spinZ).toBeCloseTo(0, 12);

    // No English shoots dead straight, and the two sides mirror exactly.
    expect(none.finalY).toBe(0);
    expect(right.finalY + left.finalY).toBeCloseTo(0, 12);
    // ...and English does something: it must not be a no-op.
    expect(Math.abs(right.finalY)).toBeGreaterThan(0.01);
  });

  it('survives to the cushion and swings the rebound the opposite way each side', () => {
    const rebound = (spinZ: number) => {
      const w = world();
      const b = w.addBall(0, { x: -0.9, y: -0.3 });
      b.velocity = { x: 0, y: 3 };
      b.spin = { x: 0, y: 0, z: spinZ };
      b.resting = false;
      for (let i = 0; i < 900 && !w.events.some((e) => e.type === 'rail'); i++) w.step();
      expect(w.events.some((e) => e.type === 'rail')).toBe(true);
      return Math.atan2(b.velocity.y, b.velocity.x);
    };
    const plain = rebound(0);
    const right = rebound(90);
    const left = rebound(-90);

    expect(Math.abs(right - plain)).toBeGreaterThan(0.01);
    expect(Math.sign(right - plain)).toBe(-Math.sign(left - plain));
  });
});

describe('simultaneous contacts', () => {
  /**
   * A cue ball splitting a frozen pair dead centre. Resolving the two contacts
   * one after the other gives the second one an already-deflected cue ball, so
   * the split comes out lopsided and the cue ball squirts sideways out of a
   * perfectly symmetric shot. A rack is full of frozen pairs, so this is not an
   * exotic case.
   */
  const splitFrozenPair = (upperFirst: boolean) => {
    const w = world();
    const cue = w.addBall(0, { x: -0.4, y: 0 });
    const gap = R * 1.02;
    const first = w.addBall(1, { x: 0, y: upperFirst ? gap : -gap });
    const second = w.addBall(2, { x: 0, y: upperFirst ? -gap : gap });
    cue.velocity = { x: 3, y: 0 };
    cue.resting = false;
    for (let i = 0; i < 400 && w.events.filter((e) => e.type === 'ball-ball').length < 2; i++) {
      w.step();
    }
    return {
      cue,
      upper: upperFirst ? first : second,
      lower: upperFirst ? second : first,
      contacts: w.events.filter((e) => e.type === 'ball-ball').length,
    };
  };

  it('splits a frozen pair symmetrically and leaves the cue ball on its line', () => {
    const { cue, upper, lower, contacts } = splitFrozenPair(true);
    expect(contacts).toBe(2);

    // Mirror symmetry is exact, not approximate: the table, the geometry and
    // the shot are all symmetric about y = 0.
    expect(upper.velocity.x).toBeCloseTo(lower.velocity.x, 12);
    expect(upper.velocity.y + lower.velocity.y).toBeCloseTo(0, 12);
    expect(upper.velocity.y).toBeGreaterThan(0);
    expect(cue.velocity.y).toBe(0);
  });

  it('gives the same result whichever ball is stored first', () => {
    const a = splitFrozenPair(true);
    const b = splitFrozenPair(false);
    expect(a.upper.velocity.y).toBeCloseTo(b.upper.velocity.y, 12);
    expect(a.lower.velocity.y).toBeCloseTo(b.lower.velocity.y, 12);
    expect(a.cue.velocity.x).toBeCloseTo(b.cue.velocity.x, 12);
  });

  it('matches the closed-form solution for a symmetric two-contact impact', () => {
    // For a ball of speed u striking two balls whose lines of centres both sit
    // at angle θ to its path, momentum plus Newton restitution give
    //     j = u·cosθ·(1+e) / (1 + 2cos²θ)
    // for the speed of each struck ball, and u − 2j·cosθ for the striker.
    const w = world();
    const gap = R * 1.02;
    const cue = w.addBall(0, { x: -0.08, y: 0 });
    const upper = w.addBall(1, { x: 0, y: gap });
    const lower = w.addBall(2, { x: 0, y: -gap });
    cue.velocity = { x: 2, y: 0 };
    cue.resting = false;

    // Capture the cue ball's speed on the step before contact, so cloth
    // friction over the approach is not counted as solver error.
    let u = cue.velocity.x;
    for (let i = 0; i < 400; i++) {
      if (w.events.some((e) => e.type === 'ball-ball')) break;
      u = cue.velocity.x;
      w.step();
    }

    const sinTheta = gap / (2 * R);
    const cosTheta = Math.sqrt(1 - sinTheta * sinTheta);
    const j = (u * cosTheta * (1 + BALL_RESTITUTION)) / (1 + 2 * cosTheta * cosTheta);

    const struck = Math.hypot(upper.velocity.x, upper.velocity.y);
    expect(Math.hypot(lower.velocity.x, lower.velocity.y)).toBeCloseTo(struck, 12);
    // Ball-ball surface friction (throw) is not in the closed form, so allow a
    // few per cent; the point is that the answer is the physical one and not
    // the ~40% too small that an inelastic solve would give.
    expect(struck).toBeCloseTo(j, 1);
    expect(struck / j).toBeGreaterThan(0.9);
    expect(struck / j).toBeLessThan(1.1);
    // The striker recoils, as the closed form says it must for this geometry.
    expect(cue.velocity.x).toBeLessThan(0);
    expect(cue.velocity.x).toBeCloseTo(u - 2 * j * cosTheta, 1);
  });

  it('creates no energy when several contacts land at once', () => {
    const w = world();
    const cue = w.addBall(0, { x: -0.3, y: 0 });
    // A cue ball driven into three balls arranged symmetrically around it.
    w.addBall(1, { x: 0, y: 0 });
    w.addBall(2, { x: 0.05, y: 2.02 * R });
    w.addBall(3, { x: 0.05, y: -2.02 * R });
    cue.velocity = { x: 5, y: 0 };
    cue.resting = false;

    let previous = w.totalEnergy();
    for (let i = 0; i < 4000 && !w.isSettled(); i++) {
      w.step();
      const now = w.totalEnergy();
      expect(now).toBeLessThanOrEqual(previous + 1e-9);
      previous = now;
    }
    expect(w.corrupted).toBe(false);
  });
});

describe('overlap recovery', () => {
  it('separates deeply interpenetrating balls without exploding', () => {
    const w = world();
    const a = w.addBall(0, { x: 0, y: 0 });
    // Sunk more than halfway into each other — a state the solver should never
    // produce, but must survive if it is ever handed one.
    const b = w.addBall(1, { x: R * 0.6, y: 0 });
    a.velocity = { x: 0.5, y: 0 };
    a.resting = false;
    b.resting = false;

    const energyBefore = w.totalEnergy();
    for (let i = 0; i < 600 && !w.isSettled(); i++) w.step();

    const gap = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
    expect(gap).toBeGreaterThanOrEqual(2 * R - 1e-9);
    expect(w.corrupted).toBe(false);
    // Depenetration is positional, so it cannot have added energy.
    expect(w.totalEnergy()).toBeLessThanOrEqual(energyBefore + 1e-9);
  });
});

describe('pocket capture across the speed range', () => {
  const corner = createTable().pockets.find((p) => p.id === 'pocket-corner-rt')!;

  it.each([0.8, 2, 5, 9, 12])('captures a corner-pocket shot at %s m/s', (speed) => {
    const w = world();
    const b = w.addBall(1, { x: corner.centre.x - 0.35, y: corner.centre.y - 0.35 });
    const unit = 1 / Math.SQRT2;
    b.velocity = { x: unit * speed, y: unit * speed };
    b.resting = false;
    w.simulateToRest();
    expect(b.pocketed).toBe(true);
  });

  it.each([1, 3, 8, 12])('captures a side-pocket shot at %s m/s', (speed) => {
    const w = world();
    const b = w.addBall(1, { x: 0, y: TABLE_WIDTH / 2 - 0.3 });
    b.velocity = { x: 0, y: speed };
    b.resting = false;
    w.simulateToRest();
    expect(b.pocketed).toBe(true);
  });

  it('drops a ball that only just reaches the pocket', () => {
    const w = world();
    const unit = 1 / Math.SQRT2;
    const b = w.addBall(1, { x: corner.centre.x - unit * 0.15, y: corner.centre.y - unit * 0.15 });
    b.velocity = { x: unit * 0.25, y: unit * 0.25 };
    b.resting = false;
    w.simulateToRest();
    expect(b.pocketed).toBe(true);
  });

  it('does not suck in a ball that runs out of steam short of the mouth', () => {
    // A pocket must not act as a vacuum. At 0.3 m/s the ball can only travel
    // about 25 cm, so from half a metre away it has to stop on the cloth.
    const w = world();
    const unit = 1 / Math.SQRT2;
    const start = { x: corner.centre.x - unit * 0.5, y: corner.centre.y - unit * 0.5 };
    const b = w.addBall(1, start);
    b.velocity = { x: unit * 0.3, y: unit * 0.3 };
    b.resting = false;
    w.simulateToRest();

    expect(b.pocketed).toBe(false);
    expect(w.isSettled()).toBe(true);
    // And it stopped somewhere sensible, not on top of the pocket.
    const travelled = Math.hypot(b.position.x - start.x, b.position.y - start.y);
    expect(travelled).toBeGreaterThan(0.1);
    expect(travelled).toBeLessThan(0.4);
  });
});

describe('cloth: rolling resistance', () => {
  it('a rolling ball stops in the distance the friction coefficient predicts', () => {
    // v² = 2·a·d for a ball already in natural roll, with a = μ_roll·g. The
    // speed is chosen so the ball never reaches a cushion, because a rebound
    // would make the test measure restitution instead.
    const speed = 0.5;
    const predicted = (speed * speed) / (2 * MU_ROLL * GRAVITY);
    expect(predicted).toBeLessThan(TABLE_LENGTH - 0.3); // stays on the cloth

    const w = world();
    const start = { x: -TABLE_LENGTH / 2 + 0.15, y: 0 };
    const b = w.addBall(0, start);
    applyStrike(b, { direction: { x: 1, y: 0 }, speed, tipX: 0, tipY: 0.4 });
    w.simulateToRest();

    expect(w.events.some((e) => e.type === 'rail')).toBe(false);
    const travelled = b.position.x - start.x;
    expect(travelled).toBeCloseTo(predicted, 1);
  });

  it('a ball struck without spin slides first, so it stops sooner than a rolling one', () => {
    const run = (tipY: number) => {
      const w = world();
      const b = w.addBall(0, { x: -TABLE_LENGTH / 2 + 0.15, y: 0 });
      applyStrike(b, { direction: { x: 1, y: 0 }, speed: 0.5, tipX: 0, tipY });
      w.simulateToRest();
      return b.position.x;
    };
    // Sliding friction is twenty times rolling resistance, so the stunned ball
    // must not travel as far as the one that rolls from the start.
    expect(run(0)).toBeLessThan(run(0.4));
  });

  it('momentum is conserved through a batch-resolved contact', () => {
    const w = world();
    const cue = w.addBall(0, { x: -0.2, y: 0 });
    w.addBall(1, { x: 0, y: R * 1.02 });
    w.addBall(2, { x: 0, y: -R * 1.02 });
    cue.velocity = { x: 3, y: 0 };
    cue.resting = false;

    const momentum = () =>
      w.balls.reduce(
        (acc, b) => ({ x: acc.x + BALL_MASS * b.velocity.x, y: acc.y + BALL_MASS * b.velocity.y }),
        { x: 0, y: 0 },
      );

    let before = momentum();
    for (let i = 0; i < 400; i++) {
      if (w.events.some((e) => e.type === 'ball-ball')) break;
      before = momentum();
      w.step();
    }
    const after = momentum();

    // Only one step of cloth friction on three balls stands between the two
    // measurements, so bound the loss by exactly that.
    const bound = 3 * BALL_MASS * 0.2 * GRAVITY * (1 / 120);
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(bound);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(bound);
  });
});

describe('state integrity', () => {
  it('snapshot and restore round-trip a world exactly', () => {
    const w = world();
    const cue = w.addBall(0, { x: -0.5, y: 0.1 });
    w.addBall(1, { x: 0.2, y: -0.05 });
    applyStrike(cue, { direction: { x: 1, y: -0.2 }, speed: 4, tipX: 0.3, tipY: 0.3 });
    for (let i = 0; i < 40; i++) w.step();

    const snapshot = w.snapshot().map(cloneBall);
    const continued = () => {
      for (let i = 0; i < 200; i++) w.step();
      return w.balls.map((b) => [b.position.x, b.position.y]);
    };
    const first = continued();

    w.restore(snapshot);
    const second = continued();
    expect(second).toEqual(first);
  });
});
