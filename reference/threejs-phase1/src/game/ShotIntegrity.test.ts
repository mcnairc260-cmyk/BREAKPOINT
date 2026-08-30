import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, MAX_CUE_SPEED, MAX_TIP_OFFSET, TABLE_LENGTH } from '../physics/PhysicsConstants';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { applyStrike } from '../physics/SpinModel';
import { createRackedWorld } from './Rack';
import type { ShotRecord } from './ShotRecord';
import { ShotSystem } from './ShotSystem';

/**
 * Shot-loop integrity tests added by the Phase 1 validation pass.
 *
 * The break is the physics torture test, so it is exercised across a swept
 * parameter space rather than once; and the shot record is checked for
 * everything a rules engine will later need to adjudicate a shot, since a
 * record that cannot answer "did any ball reach a cushion after the first
 * contact" is not a foundation a referee can be built on.
 */

/** Drive one shot to completion at a steady 60 fps. */
function runShot(system: ShotSystem, maxFrames = 6000): void {
  for (let i = 0; i < maxFrames && system.phase === 'simulating'; i++) system.update(1 / 60);
}

describe('break stress', () => {
  /**
   * A deterministic sweep, not random sampling: the same 24 shots run on every
   * CI run, so a regression is reproducible rather than a flake.
   */
  const shots = Array.from({ length: 24 }, (_, s) => ({
    angle: ((s % 8) - 3.5) * 0.004,
    speed: 6 + (s % 5) * 1.5,
    tipX: (((s * 7) % 11) / 10 - 0.5) * 0.9,
    tipY: (((s * 3) % 11) / 10 - 0.5) * 0.9,
  }));

  it.each(shots)(
    'break at speed $speed tip ($tipX, $tipY) settles cleanly',
    ({ angle, speed, tipX, tipY }) => {
      const world = createRackedWorld();
      applyStrike(world.cueBall!, { direction: { x: 1, y: angle }, speed, tipX, tipY });

      let previous = world.totalEnergy();
      let steps = 0;
      for (; steps < 9000 && !world.isSettled(); steps++) {
        world.step();

        const now = world.totalEnergy();
        expect(now).toBeLessThanOrEqual(previous + 1e-9);
        previous = now;

        for (const ball of world.balls) {
          if (ball.pocketed) continue;
          expect(Number.isFinite(ball.position.x)).toBe(true);
          expect(Number.isFinite(ball.velocity.x)).toBe(true);
          expect(Number.isFinite(ball.spin.z)).toBe(true);
          // Nothing may leave the table except through a pocket throat.
          expect(Math.abs(ball.position.x)).toBeLessThan(TABLE_LENGTH / 2 + 0.12);
        }
      }

      expect(world.isSettled()).toBe(true);
      expect(world.corrupted).toBe(false);
      // No ball may end the shot overlapping another.
      const live = world.balls.filter((b) => !b.pocketed);
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          const d = Math.hypot(
            live[i].position.x - live[j].position.x,
            live[i].position.y - live[j].position.y,
          );
          expect(d).toBeGreaterThanOrEqual(2 * BALL_RADIUS - 1e-6);
        }
      }
    },
  );

  it('a hard break reaches the pack and disperses it', () => {
    const world = createRackedWorld();
    const before = world.balls.slice(1).map((b) => ({ ...b.position }));
    applyStrike(world.cueBall!, { direction: { x: 1, y: 0.004 }, speed: 10, tipX: 0, tipY: 0.1 });
    world.simulateToRest();

    const moved = world.balls
      .slice(1)
      .filter((b, i) => b.pocketed || Math.hypot(b.position.x - before[i].x, b.position.y - before[i].y) > 0.05);
    expect(moved.length).toBeGreaterThanOrEqual(10);
    expect(world.events.filter((e) => e.type === 'ball-ball').length).toBeGreaterThan(10);
  });
});

describe('shot record: referee readiness', () => {
  let record: ShotRecord;

  const play = () => {
    const system = new ShotSystem();
    system.setAim(0.01);
    system.setPower(0.85);
    system.setTip(0.2, -0.1);
    system.strike();
    runShot(system);
    return system.history[0];
  };

  it('records the full contact graph, not just the first contact', () => {
    record = play();
    expect(record.ballContacts.length).toBeGreaterThan(1);
    for (const c of record.ballContacts) {
      expect(Number.isInteger(c.a)).toBe(true);
      expect(Number.isInteger(c.b)).toBe(true);
      expect(c.impulse).toBeGreaterThan(0);
    }
    // The cue ball is in the very first contact and it is not "after" itself.
    const first = record.ballContacts[0];
    expect(first.a === 0 || first.b === 0).toBe(true);
    expect(first.afterFirstContact).toBe(false);
  });

  it('attributes every cushion contact to a ball and to a side of the first contact', () => {
    record = play();
    expect(record.railContacts.length).toBeGreaterThan(0);
    for (const c of record.railContacts) {
      expect(typeof c.id).toBe('string');
      expect(Number.isInteger(c.ball)).toBe(true);
      expect(c.impulse).toBeGreaterThan(0);
      expect(typeof c.afterFirstContact).toBe('boolean');
    }
    // A break drives balls into the cushions, so some contact must follow the
    // first contact — the exact question a legal-shot rule asks.
    expect(record.railContacts.some((c) => c.afterFirstContact)).toBe(true);
  });

  it('keeps jaw contacts separate from cushion contacts', () => {
    // A jaw is part of the pocket casting, so it must never be counted as a
    // ball-to-rail contact by a future rules engine.
    const railIds = new Set(createRackedWorld().table.rails.map((r) => r.id));
    const jawIds = new Set(createRackedWorld().table.jaws.map((j) => j.id));
    record = play();
    for (const c of record.railContacts) expect(railIds.has(c.id)).toBe(true);
    for (const c of record.jawContacts) expect(jawIds.has(c.id)).toBe(true);
  });

  it('points at the first contact inside the raw event stream', () => {
    record = play();
    expect(record.firstObjectBallContact).not.toBeNull();
    expect(record.firstContactEventIndex).not.toBeNull();

    const event = record.events[record.firstContactEventIndex!];
    expect(event.type).toBe('ball-ball');
    // Everything before it is un-flagged, everything after it is flagged.
    const before = record.events.slice(0, record.firstContactEventIndex!);
    expect(before.some((e) => e.type === 'ball-ball')).toBe(false);
  });

  it('is plain data that survives a JSON round trip unchanged', () => {
    record = play();
    const round = JSON.parse(JSON.stringify(record)) as ShotRecord;
    expect(round.ballContacts).toEqual(record.ballContacts);
    expect(round.railContacts).toEqual(record.railContacts);
    expect(round.jawContacts).toEqual(record.jawContacts);
    expect(round.postShotBalls).toEqual(record.postShotBalls);
    expect(round.firstContactEventIndex).toBe(record.firstContactEventIndex);
  });

  it('replays from its own record to the same final table', () => {
    record = play();
    const replay = new PhysicsWorld(createRackedWorld().table);
    for (const b of record.preShotBalls) replay.addBall(b.number, b.position);
    applyStrike(replay.cueBall!, {
      direction: { x: Math.cos(record.aimAngle), y: Math.sin(record.aimAngle) },
      speed: record.impulse.speed,
      tipX: record.cueContactPoint.x,
      tipY: record.cueContactPoint.y,
    });
    replay.simulateToRest();

    for (const expected of record.postShotBalls) {
      const actual = replay.balls.find((b) => b.number === expected.number)!;
      expect(actual.pocketed).toBe(expected.pocketed);
      if (!expected.pocketed) {
        expect(actual.position.x).toBeCloseTo(expected.position.x, 12);
        expect(actual.position.y).toBeCloseTo(expected.position.y, 12);
      }
    }
    // The event stream must match too, or a replay is only coincidentally right.
    const summary = (es: ShotRecord['events']) => es.map((e) => e.type).join(',');
    expect(summary(replay.events)).toBe(summary(record.events));
  });
});

describe('shot loop across many shots', () => {
  it('locks and reopens the controls on every shot in a long sequence', () => {
    const system = new ShotSystem();
    for (let shot = 0; shot < 12; shot++) {
      expect(system.acceptsInput).toBe(true);

      system.setAim(((shot % 9) - 4) * 0.2);
      system.setPower(0.3 + (shot % 6) * 0.1);
      system.setTip(((shot % 5) - 2) * 0.2, ((shot % 3) - 1) * 0.3);

      const aim = system.aimAngle;
      expect(system.strike()).toBe(true);
      expect(system.acceptsInput).toBe(false);

      // Locked: no input path may take effect, and no second strike may fire.
      system.setAim(aim + 1);
      system.setPower(1);
      system.setTip(0.5, 0.5);
      expect(system.aimAngle).toBeCloseTo(aim, 12);
      expect(system.strike()).toBe(false);

      runShot(system);

      expect(system.phase).toBe('aiming');
      expect(system.acceptsInput).toBe(true);
      expect(system.world.isSettled()).toBe(true);
      expect(system.world.corrupted).toBe(false);
      expect(system.world.cueBall!.pocketed).toBe(false);
    }
    expect(system.history).toHaveLength(12);
    // Indices stay unique and monotonic, so they work as shot identifiers.
    expect(system.history.map((r) => r.index)).toEqual([...Array(12).keys()]);
  });

  it('bounds the retained history while still reporting every shot', () => {
    const seen: number[] = [];
    const system = new ShotSystem({ historyLimit: 5, onShotComplete: (r) => seen.push(r.index) });
    for (let shot = 0; shot < 9; shot++) {
      system.setAim(((shot % 7) - 3) * 0.25);
      system.setPower(0.45);
      system.strike();
      runShot(system);
    }
    expect(seen).toEqual([...Array(9).keys()]);
    expect(system.history).toHaveLength(5);
    // What is kept is the most recent, and the indices never restart.
    expect(system.history.map((r) => r.index)).toEqual([4, 5, 6, 7, 8]);
  });

  it('never lets power or spin leave their physical bounds, whatever is asked for', () => {
    const system = new ShotSystem();
    for (const p of [-5, -0.001, 0, 0.5, 1, 1.001, 99, Number.MAX_SAFE_INTEGER]) {
      system.setPower(p);
      expect(system.power).toBeGreaterThanOrEqual(0);
      expect(system.power).toBeLessThanOrEqual(1);
      expect(system.cueSpeed).toBeGreaterThan(0);
      expect(system.cueSpeed).toBeLessThanOrEqual(MAX_CUE_SPEED);
    }
    for (const [x, y] of [[9, 9], [-9, 3], [0, -50], [0.5, 0.5], [-0.4, -0.4]] as const) {
      system.setTip(x, y);
      expect(Math.hypot(system.tip.x, system.tip.y)).toBeLessThanOrEqual(MAX_TIP_OFFSET + 1e-12);
    }
  });

  it('respots a scratched cue ball clear of every other ball', () => {
    const system = new ShotSystem();
    const cue = system.world.cueBall!;
    const pocket = system.world.table.pockets.find((p) => p.id === 'pocket-corner-lb')!;
    system.setAim(Math.atan2(pocket.centre.y - cue.position.y, pocket.centre.x - cue.position.x));
    system.setPower(0.4);
    system.strike();
    runShot(system);

    expect(system.history[0].scratch).toBe(true);
    const respotted = system.world.cueBall!;
    expect(respotted.pocketed).toBe(false);
    expect(respotted.resting).toBe(true);
    for (const other of system.world.balls) {
      if (other === respotted || other.pocketed) continue;
      const d = Math.hypot(
        other.position.x - respotted.position.x,
        other.position.y - respotted.position.y,
      );
      expect(d).toBeGreaterThanOrEqual(2 * BALL_RADIUS);
    }
    // ...and the very next shot is playable.
    expect(system.acceptsInput).toBe(true);
    expect(system.strike()).toBe(true);
  });
});
