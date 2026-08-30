import { describe, expect, it } from 'vitest';
import { BALL_RADIUS } from '../physics/PhysicsConstants';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { applyStrike } from '../physics/SpinModel';
import { predictAim } from './AimPredictor';
import { createRackedWorld, rackPositions } from './Rack';
import type { ShotRecord } from './ShotRecord';
import { ShotSystem } from './ShotSystem';

/** Drive a system to the end of the current shot at a steady 60 fps. */
function runShot(system: ShotSystem, maxFrames = 4000): void {
  for (let i = 0; i < maxFrames && system.phase === 'simulating'; i++) {
    system.update(1 / 60);
  }
}

describe('rack', () => {
  it('lays out fifteen balls plus the cue with nothing overlapping', () => {
    const world = createRackedWorld();
    expect(world.balls).toHaveLength(16);
    expect(world.cueBall).toBeDefined();

    for (let i = 0; i < world.balls.length; i++) {
      for (let j = i + 1; j < world.balls.length; j++) {
        const a = world.balls[i];
        const b = world.balls[j];
        const d = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
        expect(d).toBeGreaterThanOrEqual(2 * BALL_RADIUS);
      }
    }
  });

  it('puts every ball inside the cushions and none in a pocket', () => {
    const world = createRackedWorld();
    for (const b of world.balls) {
      expect(Math.abs(b.position.x)).toBeLessThan(world.table.length / 2 - BALL_RADIUS);
      expect(Math.abs(b.position.y)).toBeLessThan(world.table.width / 2 - BALL_RADIUS);
      expect(b.pocketed).toBe(false);
    }
    expect(new Set(rackPositions().map((p) => p.number)).size).toBe(15);
  });
});

describe('shot loop', () => {
  it('locks out every control while the balls are moving, and reopens after', () => {
    const system = new ShotSystem();
    expect(system.acceptsInput).toBe(true);

    system.setAim(0.3);
    system.setPower(0.8);
    system.setTip(0.2, -0.2);
    expect(system.strike()).toBe(true);
    expect(system.phase).toBe('simulating');
    expect(system.acceptsInput).toBe(false);

    // Every input path is a no-op mid-shot, and a second strike is refused.
    system.setAim(2.5);
    system.setPower(0.1);
    system.setTip(0.5, 0.5);
    expect(system.aimAngle).toBeCloseTo(0.3, 9);
    expect(system.power).toBeCloseTo(0.8, 9);
    expect(system.strike()).toBe(false);

    runShot(system);
    expect(system.phase).toBe('aiming');
    expect(system.acceptsInput).toBe(true);
    // ...and the next shot can be taken immediately.
    expect(system.strike()).toBe(true);
  });

  it('clamps the tip onto the miscue disc but keeps its direction', () => {
    const system = new ShotSystem();
    system.setTip(1, 1);
    expect(Math.hypot(system.tip.x, system.tip.y)).toBeCloseTo(0.5, 9);
    expect(system.tip.x).toBeCloseTo(system.tip.y, 9);
  });

  it('maps the power dial onto a monotonic, bounded cue speed', () => {
    const system = new ShotSystem();
    const speeds = [0, 0.25, 0.5, 0.75, 1].map((p) => {
      system.setPower(p);
      return system.cueSpeed;
    });
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]).toBeGreaterThan(speeds[i - 1]);
    expect(speeds[0]).toBeGreaterThan(0);
    expect(speeds[speeds.length - 1]).toBeLessThanOrEqual(12);
  });

  it('respots the cue ball after a scratch so play can continue', () => {
    const system = new ShotSystem();
    // Send the cue ball straight into a corner pocket, past the rack.
    const cue = system.world.cueBall!;
    const pocket = system.world.table.pockets.find((p) => p.id === 'pocket-corner-lb')!;
    system.setAim(Math.atan2(pocket.centre.y - cue.position.y, pocket.centre.x - cue.position.x));
    system.setPower(0.4);
    system.strike();
    runShot(system);

    const record = system.history[0];
    expect(record.scratch).toBe(true);
    // Respotted, on the table, and playable again.
    expect(system.world.cueBall!.pocketed).toBe(false);
    expect(system.acceptsInput).toBe(true);
    expect(Math.abs(system.world.cueBall!.position.x)).toBeLessThan(system.world.table.length / 2);
  });
});

describe('shot records', () => {
  it('records everything needed to reconstruct the shot', () => {
    const records: ShotRecord[] = [];
    const system = new ShotSystem({ onShotComplete: (r) => records.push(r) });

    system.setAim(0.02);
    system.setPower(0.85);
    system.setTip(0.3, -0.2);
    const cueBefore = { ...system.world.cueBall!.position };
    system.strike();
    runShot(system);

    expect(records).toHaveLength(1);
    const r = records[0];

    expect(r.index).toBe(0);
    expect(r.preShotBalls).toHaveLength(16);
    expect(r.postShotBalls).toHaveLength(16);
    expect(r.cueBallPosition).toEqual(cueBefore);
    expect(r.aimAngle).toBeCloseTo(0.02, 9);
    expect(r.power).toBeCloseTo(0.85, 9);
    expect(r.cueContactPoint).toEqual({ x: 0.3, y: -0.2 });
    expect(r.impulse.speed).toBeGreaterThan(0);
    expect(r.impulse.spin.z).toBeGreaterThan(0); // right English
    expect(r.events.length).toBeGreaterThan(0);
    expect(r.firstObjectBallContact).not.toBeNull();
    expect(r.durationSeconds).toBeGreaterThan(0);
    expect(r.steps).toBeGreaterThan(0);
    expect(r.railContacts.length).toBeGreaterThan(0);
    expect(r.ballsPocketed.length).toBe(r.pocketsUsed.length);
    // It is a plain data object, so a shot is one JSON round-trip.
    expect(JSON.parse(JSON.stringify(r)).aimAngle).toBeCloseTo(0.02, 9);
  });

  it('a record replays to the same final table it described', () => {
    const system = new ShotSystem();
    system.setAim(0.017);
    system.setPower(0.9);
    system.setTip(-0.25, 0.3);
    system.strike();
    runShot(system);
    const record = system.history[0];

    // Rebuild the pre-shot table from the record alone and re-run the strike.
    const replay = new PhysicsWorld(system.world.table);
    for (const b of record.preShotBalls) {
      const ball = replay.addBall(b.number, b.position);
      ball.pocketed = b.pocketed;
    }
    applyStrike(replay.cueBall!, {
      direction: { x: Math.cos(record.aimAngle), y: Math.sin(record.aimAngle) },
      speed: record.impulse.speed,
      tipX: record.cueContactPoint.x,
      tipY: record.cueContactPoint.y,
    });
    replay.simulateToRest();

    // The recorded post-shot state is what the replay produces, exactly.
    for (const expected of record.postShotBalls) {
      const actual = replay.balls.find((b) => b.number === expected.number)!;
      expect(actual.pocketed).toBe(expected.pocketed);
      if (expected.pocketed) continue;
      expect(actual.position.x).toBeCloseTo(expected.position.x, 12);
      expect(actual.position.y).toBeCloseTo(expected.position.y, 12);
    }
  });

  it('attributes first contact to the cue ball, not to balls colliding in the pack', () => {
    const system = new ShotSystem();
    system.setPower(1);
    system.setAim(0);
    system.strike();
    runShot(system);

    const r = system.history[0];
    // The apex ball of the rack is the 1, and a square break must reach it first.
    expect(r.firstObjectBallContact).toBe(1);
  });
});

describe('aiming line', () => {
  it('stops at the first ball in the way and reports the ghost ball', () => {
    const system = new ShotSystem();
    const p = predictAim(system.world, 0)!;
    expect(p.target).not.toBeNull();
    expect(p.ghost).not.toBeNull();
    // Ghost ball sits exactly one ball diameter back along the line of centres.
    const d = Math.hypot(p.ghost!.x - p.target!.position.x, p.ghost!.y - p.target!.position.y);
    expect(d).toBeCloseTo(2 * BALL_RADIUS, 9);
    // The cue ball's tangent line is perpendicular to the object ball's line.
    const dot = p.cueTangent!.x * p.targetDirection!.x + p.cueTangent!.y * p.targetDirection!.y;
    expect(Math.abs(dot)).toBeLessThan(1e-9);
  });

  it('stops at a cushion when nothing is in the way', () => {
    const world = new PhysicsWorld();
    world.addBall(0, { x: 0.5, y: 0 });
    const p = predictAim(world, Math.PI / 2)!;
    expect(p.target).toBeNull();
    expect(p.ghost).toBeNull();
    expect(p.end.y).toBeCloseTo(world.table.width / 2 - BALL_RADIUS, 6);
  });

  it('predicts the line the shot actually takes', () => {
    // Fire down the prediction and check the cue ball really arrives there.
    const world = new PhysicsWorld();
    const cue = world.addBall(0, { x: -0.8, y: -0.2 });
    world.addBall(1, { x: 0.2, y: 0.15 });
    const angle = Math.atan2(0.15 - -0.2, 0.2 - -0.8);
    const p = predictAim(world, angle)!;
    expect(p.target?.number).toBe(1);

    applyStrike(cue, {
      direction: { x: Math.cos(angle), y: Math.sin(angle) },
      speed: 2,
      tipX: 0,
      tipY: 0.4,
    });
    for (let i = 0; i < 600 && !world.events.some((e) => e.type === 'ball-ball'); i++) world.step();
    // Contact happens within a millimetre of the predicted ghost-ball centre.
    expect(Math.hypot(cue.position.x - p.ghost!.x, cue.position.y - p.ghost!.y)).toBeLessThan(0.001);
  });
});
