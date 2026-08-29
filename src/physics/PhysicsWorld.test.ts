import { describe, expect, it } from 'vitest';
import { FixedStepDriver } from '../core/FixedStepDriver';
import { contactVelocity } from './BallBody';
import { clothPhase } from './FrictionModel';
import {
  BALL_INERTIA,
  BALL_MASS,
  BALL_RADIUS,
  FIXED_DT,
  GRAVITY,
  MU_SLIDE,
  TABLE_LENGTH,
  TABLE_WIDTH,
} from './PhysicsConstants';
import { PhysicsWorld } from './PhysicsWorld';
import { applyStrike, computeStrike } from './SpinModel';
import { createTable } from './TableGeometry';

/**
 * The physics regression suite.
 *
 * Every test here exercises the real simulation end to end — construct a table,
 * place balls, strike, run to rest, assert on the outcome. Nothing is stubbed
 * and no expected value is copied back out of a previous run: each assertion is
 * either a conservation law, a sign, or a documented billiards fact.
 */

const R = BALL_RADIUS;

function world(): PhysicsWorld {
  return new PhysicsWorld(createTable());
}

/** Kinetic energy of one ball, translational + rotational. */
function ballEnergy(b: { velocity: { x: number; y: number }; spin: { x: number; y: number; z: number } }) {
  const v2 = b.velocity.x ** 2 + b.velocity.y ** 2;
  const w2 = b.spin.x ** 2 + b.spin.y ** 2 + b.spin.z ** 2;
  return 0.5 * BALL_MASS * v2 + 0.5 * BALL_INERTIA * w2;
}

// ---------------------------------------------------------------- collisions

describe('1. stationary-ball collision', () => {
  it('a ball rolled into a stationary ball sets it moving and does not pass through', () => {
    const w = world();
    const cue = w.addBall(0, { x: -0.5, y: 0 });
    const object = w.addBall(1, { x: 0, y: 0 });

    applyStrike(cue, { direction: { x: 1, y: 0 }, speed: 2, tipX: 0, tipY: 0.4 });
    w.simulateToRest();

    expect(object.position.x).toBeGreaterThan(0.05);
    expect(w.events.some((e) => e.type === 'ball-ball')).toBe(true);
    // Never overlapping at rest.
    const gap = Math.hypot(cue.position.x - object.position.x, cue.position.y - object.position.y);
    if (!cue.pocketed && !object.pocketed) expect(gap).toBeGreaterThanOrEqual(2 * R - 1e-6);
  });
});

describe('2. head-on collision', () => {
  it('a full-ball centre hit transfers nearly all speed and stops the cue ball', () => {
    const w = world();
    const cue = w.addBall(0, { x: -0.3, y: 0 });
    const object = w.addBall(1, { x: 0, y: 0 });

    // Stun: no top or bottom spin, so the cue ball has no roll to carry it on.
    cue.velocity = { x: 3, y: 0 };
    cue.resting = false;

    // Step until the collision has happened.
    for (let i = 0; i < 240 && !w.events.some((e) => e.type === 'ball-ball'); i++) w.step();

    expect(w.events.some((e) => e.type === 'ball-ball')).toBe(true);
    // Object ball leaves along the line of centres at close to the full speed.
    expect(object.velocity.x).toBeGreaterThan(2.5);
    expect(Math.abs(object.velocity.y)).toBeLessThan(0.05);
    // Cue ball is nearly stopped — the classic stop shot.
    expect(Math.abs(cue.velocity.x)).toBeLessThan(0.3);
  });
});

describe('3. angled collision', () => {
  it('a cut sends the balls apart on roughly perpendicular paths', () => {
    const w = world();
    // Offset the object ball by half a ball width: a ~30 degree cut.
    const cue = w.addBall(0, { x: -0.4, y: 0 });
    const object = w.addBall(1, { x: 0, y: R });

    cue.velocity = { x: 3, y: 0 };
    cue.resting = false;
    for (let i = 0; i < 240 && !w.events.some((e) => e.type === 'ball-ball'); i++) w.step();

    // Object ball goes up and right along the line of centres.
    expect(object.velocity.x).toBeGreaterThan(0);
    expect(object.velocity.y).toBeGreaterThan(0);
    // Cue ball is deflected the other way.
    expect(cue.velocity.y).toBeLessThan(0);

    // The 90-degree rule: for a stun cut the outgoing paths are perpendicular.
    const ca = Math.atan2(cue.velocity.y, cue.velocity.x);
    const oa = Math.atan2(object.velocity.y, object.velocity.x);
    const between = Math.abs(((oa - ca + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    expect(between).toBeGreaterThan(Math.PI / 2 - 0.25);
    expect(between).toBeLessThan(Math.PI / 2 + 0.25);
  });
});

describe('4. conservation sanity check', () => {
  it('an elastic-limit head-on collision conserves momentum along the line of centres', () => {
    const w = world();
    const a = w.addBall(0, { x: -0.1, y: 0 });
    const b = w.addBall(1, { x: 0, y: 0 });
    a.velocity = { x: 2, y: 0 };
    a.resting = false;

    // Momentum is compared across the single step containing the impulse, so
    // that cloth friction over the approach is not counted as a solver error.
    let before = BALL_MASS * (a.velocity.x + b.velocity.x);
    for (let i = 0; i < 60 && !w.events.some((e) => e.type === 'ball-ball'); i++) {
      before = BALL_MASS * (a.velocity.x + b.velocity.x);
      w.step();
    }
    const after = BALL_MASS * (a.velocity.x + b.velocity.x);

    expect(w.events.some((e) => e.type === 'ball-ball')).toBe(true);
    // The only momentum sink left is one step of cloth friction acting on two
    // balls, so bound the loss by exactly that rather than by a magic
    // percentage: Δp <= 2 · m · μ_slide · g · Δt.
    const frictionBound = 2 * BALL_MASS * MU_SLIDE * GRAVITY * FIXED_DT;
    expect(Math.abs(after - before)).toBeLessThanOrEqual(frictionBound);
    // Transverse momentum is created from nothing if the solver is wrong.
    expect(Math.abs(a.velocity.y + b.velocity.y)).toBeLessThan(1e-9);
  });
});

describe('5. no energy creation', () => {
  it('total energy never rises across any step of a full break', () => {
    const w = world();
    const cue = w.addBall(0, { x: -TABLE_LENGTH / 4, y: 0 });
    // A tight cluster, so the break produces dozens of contacts.
    let n = 1;
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i <= row; i++) {
        w.addBall(n++, {
          x: TABLE_LENGTH / 4 + row * R * Math.sqrt(3) * 1.001,
          y: (i - row / 2) * 2 * R * 1.001,
        });
      }
    }
    applyStrike(cue, { direction: { x: 1, y: 0 }, speed: 9, tipX: 0, tipY: 0 });

    let previous = w.totalEnergy();
    for (let i = 0; i < 6000 && !w.isSettled(); i++) {
      w.step();
      const now = w.totalEnergy();
      // A tiny tolerance for floating-point noise; anything real is orders of
      // magnitude larger than this.
      expect(now).toBeLessThanOrEqual(previous + 1e-9);
      previous = now;
    }
    expect(w.corrupted).toBe(false);
  });

  it('a ball trapped in a corner does not gain energy from repeated contacts', () => {
    const w = world();
    const b = w.addBall(0, { x: TABLE_LENGTH / 2 - R * 3, y: TABLE_WIDTH / 2 - R * 3 });
    b.velocity = { x: 4, y: 4 };
    b.spin = { x: 0, y: 0, z: 60 };
    b.resting = false;

    let previous = w.totalEnergy();
    for (let i = 0; i < 3000 && !w.isSettled(); i++) {
      w.step();
      const now = w.totalEnergy();
      expect(now).toBeLessThanOrEqual(previous + 1e-9);
      previous = now;
    }
  });
});

describe('6. ball eventually reaches rest', () => {
  it('a hard break settles well inside the shot time limit', () => {
    const w = world();
    const cue = w.addBall(0, { x: -TABLE_LENGTH / 4, y: 0 });
    for (let i = 1; i <= 9; i++) {
      w.addBall(i, { x: TABLE_LENGTH / 4 + (i % 3) * 2.05 * R, y: (Math.floor(i / 3) - 1) * 2.05 * R });
    }
    applyStrike(cue, { direction: { x: 1, y: 0.02 }, speed: 10, tipX: 0.2, tipY: 0.2 });

    const seconds = w.simulateToRest();
    expect(w.isSettled()).toBe(true);
    expect(seconds).toBeLessThan(45);
    for (const b of w.balls) {
      if (b.pocketed) continue;
      expect(b.velocity.x).toBe(0);
      expect(b.velocity.y).toBe(0);
      expect(b.spin.z).toBe(0);
    }
  });

  it('a slow roll comes to a complete stop, not an asymptotic crawl', () => {
    const w = world();
    const b = w.addBall(0, { x: -0.5, y: 0 });
    b.velocity = { x: 0.3, y: 0 };
    b.resting = false;
    w.simulateToRest();
    expect(b.resting).toBe(true);
    expect(Math.hypot(b.velocity.x, b.velocity.y)).toBe(0);
  });
});

// -------------------------------------------------------------------- spin

describe('7. draw shot', () => {
  it('backspin brings the cue ball back towards the shooter after contact', () => {
    const w = world();
    const cue = w.addBall(0, { x: -0.35, y: 0 });
    w.addBall(1, { x: 0, y: 0 });

    applyStrike(cue, { direction: { x: 1, y: 0 }, speed: 3.2, tipX: 0, tipY: -0.45 });
    // Backspin: the contact patch slips forward, so ω about ŝ has the opposite
    // sign to a follow shot.
    expect(cue.spin.y).toBeLessThan(0);

    for (let i = 0; i < 120 && !w.events.some((e) => e.type === 'ball-ball'); i++) w.step();
    const contactX = cue.position.x;
    // Measured in its own window, before any rail rally can interfere.
    for (let i = 0; i < 45; i++) w.step();
    expect(cue.velocity.x).toBeLessThan(0);
    expect(cue.position.x).toBeLessThan(contactX);

    w.simulateToRest();
    // The defining property of draw: the cue ball ends up behind where it hit.
    expect(cue.position.x).toBeLessThan(-2 * R);
  });

  it('draw and follow from the same speed end on opposite sides of the contact', () => {
    const run = (tipY: number) => {
      const w = world();
      const cue = w.addBall(0, { x: -0.35, y: 0 });
      w.addBall(1, { x: 0, y: 0 });
      applyStrike(cue, { direction: { x: 1, y: 0 }, speed: 3.2, tipX: 0, tipY });
      w.simulateToRest();
      return cue.position.x;
    };
    expect(run(-0.45)).toBeLessThan(run(0.45));
  });
});

describe('8. follow shot', () => {
  it('topspin carries the cue ball forward through the contact point', () => {
    const w = world();
    const cue = w.addBall(0, { x: -0.35, y: 0 });
    const object = w.addBall(1, { x: 0, y: 0 });

    applyStrike(cue, { direction: { x: 1, y: 0 }, speed: 3.2, tipX: 0, tipY: 0.45 });
    expect(cue.spin.y).toBeGreaterThan(0);

    for (let i = 0; i < 120 && !w.events.some((e) => e.type === 'ball-ball'); i++) w.step();
    // A full hit takes nearly all the cue ball's speed, so what happens next is
    // entirely down to the spin it kept.
    const justAfter = cue.velocity.x;
    expect(justAfter).toBeLessThan(0.3);

    // Judge the follow before the object ball can come back off the far
    // cushion and shove the cue ball around; that later rally is real physics
    // but it is not what this test is about.
    for (let i = 0; i < 45; i++) w.step();
    expect(cue.velocity.x).toBeGreaterThan(justAfter);
    expect(cue.position.x).toBeGreaterThan(0);
    expect(object.position.x).toBeGreaterThan(cue.position.x);
  });

  it('a tip 2/5 of a radius high produces natural roll immediately', () => {
    // The textbook result: at b = 0.4 the strike puts the ball straight onto
    // the rolling constraint, so the contact patch is not slipping at all.
    const impulse = computeStrike({ direction: { x: 1, y: 0 }, speed: 2, tipX: 0, tipY: 0.4 });
    const w = world();
    const cue = w.addBall(0, { x: -0.5, y: 0 });
    cue.velocity = impulse.velocity;
    cue.spin = impulse.spin;
    cue.resting = false;

    const u = contactVelocity(cue);
    expect(Math.hypot(u.x, u.y)).toBeLessThan(1e-9);
    expect(clothPhase(cue)).toBe('rolling');
  });
});

describe('9. stun shot', () => {
  it('a centre-ball hit slides first, then transitions to rolling on its own', () => {
    const w = world();
    const cue = w.addBall(0, { x: -1.0, y: 0 });
    applyStrike(cue, { direction: { x: 1, y: 0 }, speed: 3, tipX: 0, tipY: 0 });

    expect(clothPhase(cue)).toBe('sliding');
    let sawRolling = false;
    for (let i = 0; i < 2000 && !w.isSettled(); i++) {
      w.step();
      if (!sawRolling && clothPhase(cue) === 'rolling') sawRolling = true;
    }
    expect(sawRolling).toBe(true);
  });

  it('a stun hit into a full ball leaves the cue ball almost dead', () => {
    const w = world();
    const cue = w.addBall(0, { x: -2 * R - 0.002, y: 0 });
    const object = w.addBall(1, { x: 0, y: 0 });
    // Struck almost touching the object ball, so there is no room for the
    // cue ball to pick up any roll before contact.
    applyStrike(cue, { direction: { x: 1, y: 0 }, speed: 3, tipX: 0, tipY: 0 });
    for (let i = 0; i < 60 && !w.events.some((e) => e.type === 'ball-ball'); i++) w.step();

    expect(w.events.some((e) => e.type === 'ball-ball')).toBe(true);
    expect(object.velocity.x).toBeGreaterThan(2.5);
    // Essentially all of the speed has gone into the object ball.
    expect(Math.abs(cue.velocity.x)).toBeLessThan(0.15);
    expect(Math.abs(cue.velocity.x)).toBeLessThan(0.1 * object.velocity.x);
  });
});

// ------------------------------------------------------------------- rails

describe('10. side-spin cushion response', () => {
  it('English changes the rebound angle, and reverses with the spin', () => {
    const rebound = (spinZ: number) => {
      const w = world();
      // Away from x = 0: that is the side pocket, not a cushion.
      const b = w.addBall(0, { x: -0.9, y: 0 });
      // Into the top rail at 45 degrees.
      b.velocity = { x: 2, y: 2 };
      b.spin = { x: 0, y: 0, z: spinZ };
      b.resting = false;
      for (let i = 0; i < 2000 && !w.events.some((e) => e.type === 'rail'); i++) w.step();
      expect(w.events.some((e) => e.type === 'rail')).toBe(true);
      return Math.atan2(b.velocity.y, b.velocity.x);
    };

    const plain = rebound(0);
    const running = rebound(80);
    const reverse = rebound(-80);

    // Both spins move the rebound angle, and they move it opposite ways.
    expect(running).not.toBeCloseTo(plain, 3);
    expect(reverse).not.toBeCloseTo(plain, 3);
    expect(Math.sign(running - plain)).toBe(-Math.sign(reverse - plain));
  });

  it('cushion contact adds forward roll — the ball leaves with more topspin', () => {
    const w = world();
    const b = w.addBall(0, { x: -0.6, y: 0 });
    b.velocity = { x: 0, y: 3 };
    // Pure slide, no rotation at all, straight into the top rail.
    b.spin = { x: 0, y: 0, z: 0 };
    b.resting = false;
    for (let i = 0; i < 2000 && !w.events.some((e) => e.type === 'rail'); i++) w.step();
    // After the bounce the ball travels in -y. The rolling constraint is
    // ω = (ẑ × v)/R, and ẑ × (-ŷ) = +x̂, so forward roll for -y travel means a
    // positive spin.x. The ball arrived with no rotation at all, so any
    // positive spin.x can only have come from the cushion torquing it.
    expect(b.velocity.y).toBeLessThan(0);
    expect(b.spin.x).toBeGreaterThan(0);
    // And it is genuinely rolling forward, not merely spinning.
    expect(b.spin.x * BALL_RADIUS).toBeGreaterThan(0.25 * Math.abs(b.velocity.y));
  });
});

describe('11. cushion rebound', () => {
  it('a straight rail shot comes back along its own line, slower', () => {
    const w = world();
    const b = w.addBall(0, { x: -0.6, y: 0 });
    b.velocity = { x: 0, y: 3 };
    b.resting = false;

    for (let i = 0; i < 2000 && !w.events.some((e) => e.type === 'rail'); i++) w.step();
    expect(b.velocity.y).toBeLessThan(0);
    expect(Math.abs(b.velocity.y)).toBeLessThan(3);
    expect(Math.abs(b.velocity.x)).toBeLessThan(0.2);
  });

  it('a ball bounced round the table stays inside the cushions', () => {
    const w = world();
    const b = w.addBall(0, { x: -0.4, y: -0.2 });
    b.velocity = { x: 5.3, y: 2.9 };
    b.resting = false;

    for (let i = 0; i < 8000 && !w.isSettled(); i++) {
      w.step();
      if (b.pocketed) break;
      expect(Math.abs(b.position.x)).toBeLessThanOrEqual(TABLE_LENGTH / 2 + 0.09);
      expect(Math.abs(b.position.y)).toBeLessThanOrEqual(TABLE_WIDTH / 2 + 0.09);
    }
  });
});

// ----------------------------------------------------------------- pockets

describe('12. corner-pocket capture', () => {
  it('a ball rolled at a corner pocket drops', () => {
    const w = world();
    const table = w.table;
    const pocket = table.pockets.find((p) => p.id === 'pocket-corner-rt')!;
    const b = w.addBall(1, { x: pocket.centre.x - 0.4, y: pocket.centre.y - 0.4 });
    const d = Math.hypot(0.4, 0.4);
    b.velocity = { x: (0.4 / d) * 2, y: (0.4 / d) * 2 };
    b.resting = false;

    w.simulateToRest();
    expect(b.pocketed).toBe(true);
    expect(b.pocketId).toBe('pocket-corner-rt');
    expect(w.events.some((e) => e.type === 'pocket')).toBe(true);
  });

  it('a ball hugging the long rail still drops in the corner', () => {
    const w = world();
    const b = w.addBall(1, { x: 0.4, y: TABLE_WIDTH / 2 - BALL_RADIUS - 0.0005 });
    b.velocity = { x: 2.2, y: 0 };
    b.resting = false;
    w.simulateToRest();
    expect(b.pocketed).toBe(true);
  });
});

describe('13. side-pocket capture', () => {
  it('a ball rolled square at a side pocket drops', () => {
    const w = world();
    const b = w.addBall(1, { x: 0, y: 0.2 });
    b.velocity = { x: 0, y: 2 };
    b.resting = false;
    w.simulateToRest();
    expect(b.pocketed).toBe(true);
    expect(b.pocketId).toBe('pocket-side-t');
  });
});

describe('14. pocket rejection', () => {
  it('a ball that clips the jaw rattles out instead of dropping', () => {
    // Aimed a little past the corner pocket, so the ball meets the far jaw at
    // an angle that kicks it back onto the table rather than into the throat.
    //
    // This scenario replaced an earlier one during the Phase 1 validation
    // pass. The old case fired a ball into a 24 mm band of entry angles that
    // missed both jaws *and* the capture point, so it left the table
    // altogether — the test passed only because the ball escaped, not because
    // the pocket rejected it. That containment gap is now closed, and this
    // case exercises a genuine jaw rebound instead.
    const w = world();
    const b = w.addBall(1, { x: 0.55, y: 0.42 });
    const dx = 1.296 - 0.55;
    const dy = 0.69 - 0.42;
    const d = Math.hypot(dx, dy);
    b.velocity = { x: (dx / d) * 3, y: (dy / d) * 3 };
    b.resting = false;

    w.simulateToRest();
    expect(w.events.some((e) => e.type === 'jaw')).toBe(true);
    expect(b.pocketed).toBe(false);
    // Back on the cloth, not stranded outside the cushions.
    expect(Math.abs(b.position.x)).toBeLessThan(TABLE_LENGTH / 2);
    expect(Math.abs(b.position.y)).toBeLessThan(TABLE_WIDTH / 2);
  });

  it('never lets a ball escape the table instead of being pocketed', () => {
    // The containment invariant, swept across every entry line into a corner
    // mouth: a ball either drops or stays on the cloth. Before the Phase 1
    // validation pass a narrow band did neither and sailed off the table.
    let escapes = 0;
    let pocketed = 0;
    let rejected = 0;
    for (let y = 0.42; y <= 0.632; y += 0.012) {
      for (const speed of [1.5, 4, 8]) {
        const w = world();
        const b = w.addBall(1, { x: 0.55, y });
        const dx = 1.296 - 0.55;
        const dy = 0.661 - y;
        const d = Math.hypot(dx, dy);
        b.velocity = { x: (dx / d) * speed, y: (dy / d) * speed };
        b.resting = false;
        w.simulateToRest();

        const outside =
          Math.abs(b.position.x) > TABLE_LENGTH / 2 || Math.abs(b.position.y) > TABLE_WIDTH / 2;
        if (b.pocketed) pocketed++;
        else if (outside) escapes++;
        else rejected++;
      }
    }
    expect(escapes).toBe(0);
    // And the pocket is not a vacuum: some of those approaches must rattle out.
    expect(pocketed).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });

  it('a ball rolling parallel past a pocket mouth does not get sucked in', () => {
    const w = world();
    const b = w.addBall(1, { x: -0.8, y: TABLE_WIDTH / 2 - BALL_RADIUS - 0.03 });
    b.velocity = { x: 1.4, y: 0 };
    b.resting = false;
    // Stop before it reaches the far corner so only the side pocket is in play.
    for (let i = 0; i < 1200 && b.position.x < 0.5 && !b.pocketed; i++) w.step();
    expect(b.pocketed).toBe(false);
  });
});

// ---------------------------------------------------- integrator guarantees

describe('15. high-speed tunnelling resistance', () => {
  it('a ball at break speed cannot pass through a stationary ball', () => {
    // At 12 m/s a ball covers 10 cm per 1/120 s step — nearly two diameters.
    const w = world();
    const cue = w.addBall(0, { x: -1.0, y: 0 });
    const object = w.addBall(1, { x: 0, y: 0 });
    cue.velocity = { x: 12, y: 0 };
    cue.resting = false;

    for (let i = 0; i < 240 && !w.events.some((e) => e.type === 'ball-ball'); i++) w.step();
    expect(w.events.some((e) => e.type === 'ball-ball')).toBe(true);
    expect(object.velocity.x).toBeGreaterThan(5);
    // The cue ball must still be behind the object ball, not past it.
    expect(cue.position.x).toBeLessThan(object.position.x);
  });

  it('a ball fired at a cushion at break speed stays on the table', () => {
    const w = world();
    const b = w.addBall(0, { x: 0, y: 0 });
    b.velocity = { x: 12, y: 0 };
    b.resting = false;
    for (let i = 0; i < 4000 && !w.isSettled(); i++) {
      w.step();
      if (b.pocketed) break;
      expect(Math.abs(b.position.x)).toBeLessThan(TABLE_LENGTH / 2 + 0.1);
    }
  });
});

describe('16. deterministic simulation replay', () => {
  it('the same opening shot replays identically, twice', () => {
    const play = () => {
      const w = world();
      const cue = w.addBall(0, { x: -TABLE_LENGTH / 4, y: 0 });
      let n = 1;
      for (let row = 0; row < 5; row++) {
        for (let i = 0; i <= row; i++) {
          w.addBall(n++, {
            x: TABLE_LENGTH / 4 + row * R * Math.sqrt(3) * 1.002,
            y: (i - row / 2) * 2 * R * 1.002,
          });
        }
      }
      applyStrike(cue, { direction: { x: 1, y: 0.013 }, speed: 8.5, tipX: 0.25, tipY: -0.15 });
      w.simulateToRest();
      return w.balls.map((b) => [b.position.x, b.position.y, b.pocketed ? 1 : 0]);
    };

    expect(play()).toEqual(play());
  });
});

describe('17. identical result across different render frame rates', () => {
  it('30 fps, 60 fps, 144 fps and jittering frames all give the same table', () => {
    const runAt = (frames: number[]) => {
      const w = world();
      const cue = w.addBall(0, { x: -TABLE_LENGTH / 4, y: 0 });
      for (let i = 1; i <= 6; i++) {
        w.addBall(i, { x: TABLE_LENGTH / 4 + (i % 3) * 2.04 * R, y: (Math.floor(i / 3) - 1) * 2.04 * R });
      }
      applyStrike(cue, { direction: { x: 1, y: 0.02 }, speed: 7, tipX: -0.2, tipY: 0.3 });

      const driver = new FixedStepDriver(w);
      let fed = 0;
      let i = 0;
      // Feed the same total simulated time as whole steps, in different-sized
      // frame chunks, then let it settle.
      while (fed < 12 && !w.isSettled()) {
        const dt = frames[i++ % frames.length];
        driver.advance(dt);
        fed += dt;
      }
      w.simulateToRest();
      return w.balls.map((b) => [b.position.x, b.position.y, b.pocketed ? 1 : 0]);
    };

    const at60 = runAt([1 / 60]);
    expect(runAt([1 / 30])).toEqual(at60);
    expect(runAt([1 / 144])).toEqual(at60);
    // Deliberately uneven frames, including sub-step ones the driver must bank.
    expect(runAt([1 / 200, 1 / 45, 1 / 90, 1 / 33])).toEqual(at60);
  });

  it('the driver banks sub-step frames instead of dropping or duplicating time', () => {
    const w = world();
    const b = w.addBall(0, { x: 0, y: 0 });
    b.velocity = { x: 1, y: 0 };
    b.resting = false;
    const driver = new FixedStepDriver(w);

    // Four frames of half a step should produce exactly two steps.
    let steps = 0;
    for (let i = 0; i < 4; i++) steps += driver.advance(FIXED_DT / 2);
    expect(steps).toBe(2);

    // A huge frame is clamped rather than spiralling.
    expect(driver.advance(10)).toBeLessThanOrEqual(Math.ceil(0.25 / FIXED_DT));
  });
});

describe('18. no NaN/Infinity physics state', () => {
  it('a violent multi-ball break leaves every value finite', () => {
    const w = world();
    const cue = w.addBall(0, { x: -TABLE_LENGTH / 4, y: 0 });
    let n = 1;
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i <= row; i++) {
        w.addBall(n++, {
          x: TABLE_LENGTH / 4 + row * R * Math.sqrt(3) * 1.001,
          y: (i - row / 2) * 2 * R * 1.001,
        });
      }
    }
    applyStrike(cue, { direction: { x: 1, y: 0.005 }, speed: 12, tipX: 0.5, tipY: -0.5 });
    w.simulateToRest();

    for (const b of w.balls) {
      for (const v of [b.position.x, b.position.y, b.velocity.x, b.velocity.y, b.spin.x, b.spin.y, b.spin.z]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      for (const q of b.orientation) expect(Number.isFinite(q)).toBe(true);
    }
    expect(w.corrupted).toBe(false);
  });

  it('perfectly coincident balls are separated instead of producing NaN', () => {
    const w = world();
    const a = w.addBall(0, { x: 0, y: 0 });
    const b = w.addBall(1, { x: 0, y: 0 });
    a.velocity = { x: 1, y: 0 };
    a.resting = false;
    b.resting = false;

    for (let i = 0; i < 60; i++) w.step();
    expect(Number.isFinite(a.position.x)).toBe(true);
    expect(Number.isFinite(b.position.x)).toBe(true);
    expect(w.corrupted).toBe(false);
  });

  it('the energy accounting itself stays finite for a long random-ish rally', () => {
    const w = world();
    for (let i = 0; i < 8; i++) {
      const ball = w.addBall(i, { x: -0.9 + i * 0.22, y: (i % 3) * 0.07 - 0.07 });
      ball.velocity = { x: 3 - i * 0.4, y: 1.7 - i * 0.35 };
      ball.spin = { x: 0, y: 0, z: 40 - i * 11 };
      ball.resting = false;
    }
    for (let i = 0; i < 6000 && !w.isSettled(); i++) {
      w.step();
      expect(Number.isFinite(w.totalEnergy())).toBe(true);
    }
    for (const b of w.balls) expect(Number.isFinite(ballEnergy(b))).toBe(true);
  });
});
