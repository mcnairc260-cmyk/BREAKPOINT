import { FixedStepDriver } from '../core/FixedStepDriver';
import { BALL_RADIUS, MAX_CUE_SPEED, TABLE_LENGTH } from '../physics/PhysicsConstants';
import { PhysicsWorld, type SimEvent } from '../physics/PhysicsWorld';
import { applyStrike, clampTipOffset, type StrikeImpulse } from '../physics/SpinModel';
import { clamp, type Vec2 } from '../physics/Vec';
import { breakCuePosition, createRackedWorld } from './Rack';
import { snapshotBall, summariseEvents, type ShotRecord } from './ShotRecord';

/**
 * The shot loop: AIM → SET SPIN → SET POWER → STRIKE → WATCH → NEXT SHOT.
 *
 * This owns the whole player-facing state machine and is deliberately free of
 * DOM, three.js and timers — input adapters push intent in, the renderer reads
 * state out, and the tests drive it directly. Controls being locked while balls
 * are moving is a property of this class, not of the UI, so no input path can
 * bypass it.
 */

export type ShotPhase = 'aiming' | 'simulating';

/** Slowest useful shot, so power 0 is still a shot and not a no-op. */
const MIN_CUE_SPEED = 0.6;

export interface ShotSystemOptions {
  /** Called once per committed shot, after the balls stop. */
  onShotComplete?: (record: ShotRecord) => void;
  /** Called with events produced this frame, for audio and effects. */
  onEvents?: (events: readonly SimEvent[]) => void;
  /**
   * How many recent shot records to retain. A record carries two full ball
   * snapshots and the whole event stream — measured at roughly 12 kB — so an
   * uncapped history grows without bound over a long session. Every record is
   * still handed to `onShotComplete`, so a consumer that wants them all can
   * keep them; this cap only bounds what the system itself holds on to.
   */
  historyLimit?: number;
}

const DEFAULT_HISTORY_LIMIT = 200;

export class ShotSystem {
  world: PhysicsWorld;
  private driver: FixedStepDriver;

  phase: ShotPhase = 'aiming';
  /** Aim heading in radians from +x. */
  aimAngle = 0;
  /** Normalised power, 0..1. */
  power = 0.5;
  /** Cue tip contact point in ball radii, already inside the miscue disc. */
  tip: Vec2 = { x: 0, y: 0 };

  readonly history: ShotRecord[] = [];
  /** Shots committed this session. Keeps `record.index` monotonic under the
   *  history cap, so indices remain stable identifiers. */
  private shotCount = 0;

  private shotStartTime = 0;
  private shotStartSteps = 0;
  private pending: {
    preShotBalls: ShotRecord['preShotBalls'];
    cueBallPosition: Vec2;
    aimAngle: number;
    power: number;
    tip: Vec2;
    impulse: StrikeImpulse;
  } | null = null;

  constructor(private readonly options: ShotSystemOptions = {}) {
    this.world = createRackedWorld();
    this.driver = new FixedStepDriver(this.world);
  }

  // ------------------------------------------------------------------ input

  /** True while the player may aim, spin and power up. */
  get acceptsInput(): boolean {
    return this.phase === 'aiming';
  }

  setAim(angle: number): void {
    if (!this.acceptsInput) return;
    // Keep the angle in (-π, π] so the cue's yaw never winds up unboundedly.
    this.aimAngle = Math.atan2(Math.sin(angle), Math.cos(angle));
  }

  /** Aim at a table-space point — how a click or tap on the cloth is handled. */
  aimAt(target: Vec2): void {
    const cue = this.world.cueBall;
    if (!cue || !this.acceptsInput) return;
    const dx = target.x - cue.position.x;
    const dy = target.y - cue.position.y;
    if (Math.hypot(dx, dy) < 1e-6) return;
    this.setAim(Math.atan2(dy, dx));
  }

  setPower(power: number): void {
    if (!this.acceptsInput) return;
    this.power = clamp(power, 0, 1);
  }

  /** Set the cue tip contact point, clamped onto the miscue disc. */
  setTip(x: number, y: number): void {
    if (!this.acceptsInput) return;
    const clamped = clampTipOffset(x, y);
    this.tip = { x: clamped.tipX, y: clamped.tipY };
  }

  /** Cue speed the current power dial will produce. */
  get cueSpeed(): number {
    // Squared response: the low half of the travel is where touch shots live,
    // and a linear dial makes every soft shot feel the same.
    return MIN_CUE_SPEED + (MAX_CUE_SPEED - MIN_CUE_SPEED) * this.power * this.power;
  }

  // ------------------------------------------------------------------ shots

  /** Commit the shot. Returns false if the table is still moving. */
  strike(): boolean {
    if (!this.acceptsInput) return false;
    const cue = this.world.cueBall;
    if (!cue || cue.pocketed) return false;

    const preShotBalls = this.world.balls.map(snapshotBall);
    const cueBallPosition = { ...cue.position };

    this.world.clearEvents();
    const impulse = applyStrike(cue, {
      direction: { x: Math.cos(this.aimAngle), y: Math.sin(this.aimAngle) },
      speed: this.cueSpeed,
      tipX: this.tip.x,
      tipY: this.tip.y,
    });

    this.pending = {
      preShotBalls,
      cueBallPosition,
      aimAngle: this.aimAngle,
      power: this.power,
      tip: { ...this.tip },
      impulse,
    };
    this.shotStartTime = this.world.time;
    this.shotStartSteps = 0;
    this.phase = 'simulating';
    return true;
  }

  /**
   * Advance by one rendered frame.
   *
   * The only place wall-clock time enters the system. Everything downstream is
   * driven by whole fixed steps.
   */
  update(frameSeconds: number): void {
    if (this.phase !== 'simulating') return;

    const before = this.world.events.length;
    this.shotStartSteps += this.driver.advance(frameSeconds);
    if (this.world.events.length > before) {
      this.options.onEvents?.(this.world.events.slice(before));
    }

    if (this.world.isSettled()) this.completeShot();
  }

  private completeShot(): void {
    const pending = this.pending;
    this.pending = null;
    this.phase = 'aiming';

    this.resolveScratchAndRespot();

    if (!pending) return;

    const cue = this.world.cueBall;
    const cueId = cue ? cue.id : -1;
    const numberById = (id: number) => this.world.balls.find((b) => b.id === id)?.number ?? -1;
    const summary = summariseEvents(this.world.events, cueId, numberById);

    const record: ShotRecord = {
      index: this.shotCount++,
      timestamp: Date.now(),
      preShotBalls: pending.preShotBalls,
      cueBallPosition: pending.cueBallPosition,
      aimAngle: pending.aimAngle,
      power: pending.power,
      cueContactPoint: pending.tip,
      impulse: {
        velocity: pending.impulse.velocity,
        spin: pending.impulse.spin,
        speed: pending.impulse.speed,
      },
      events: this.world.events.slice(),
      ...summary,
      postShotBalls: this.world.balls.map(snapshotBall),
      durationSeconds: this.world.time - this.shotStartTime,
      steps: this.shotStartSteps,
    };

    this.history.push(record);
    const limit = this.options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    if (this.history.length > limit) this.history.splice(0, this.history.length - limit);
    this.options.onShotComplete?.(record);

    // Point the cue at something sensible so the next shot starts usefully
    // rather than aimed at wherever the last one finished.
    this.faceNearestTarget();
  }

  /**
   * Put the cue ball back after a scratch.
   *
   * Phase 1 has no rules, so this is the minimum that keeps the game playable:
   * the cue ball returns behind the head string, nudged clear if that spot is
   * occupied. Ball-in-hand proper belongs with the rules engine.
   */
  private resolveScratchAndRespot(): void {
    const cue = this.world.cueBall;
    if (!cue || !cue.pocketed) return;

    const home = breakCuePosition(this.world.table);
    let x = home.x;
    const y = home.y;
    for (let attempt = 0; attempt < 40; attempt++) {
      const clash = this.world.balls.some(
        (b) =>
          b !== cue &&
          !b.pocketed &&
          Math.hypot(b.position.x - x, b.position.y - y) < 2 * BALL_RADIUS + 0.002,
      );
      if (!clash) break;
      x -= 2.2 * BALL_RADIUS;
      if (x < -TABLE_LENGTH / 2 + 3 * BALL_RADIUS) x = home.x + 2.2 * BALL_RADIUS * attempt;
    }

    cue.position.x = x;
    cue.position.y = y;
    cue.pocketed = false;
    cue.pocketId = null;
    cue.velocity.x = 0;
    cue.velocity.y = 0;
    cue.spin.x = 0;
    cue.spin.y = 0;
    cue.spin.z = 0;
    cue.resting = true;
  }

  /** Aim at the nearest remaining object ball. */
  private faceNearestTarget(): void {
    const cue = this.world.cueBall;
    if (!cue) return;
    let best: { d: number; angle: number } | null = null;
    for (const b of this.world.balls) {
      if (b.pocketed || b.number === 0) continue;
      const dx = b.position.x - cue.position.x;
      const dy = b.position.y - cue.position.y;
      const d = Math.hypot(dx, dy);
      if (!best || d < best.d) best = { d, angle: Math.atan2(dy, dx) };
    }
    if (best) this.aimAngle = best.angle;
  }

  /** Start a fresh rack. */
  reset(): void {
    this.world = createRackedWorld();
    this.driver = new FixedStepDriver(this.world);
    this.phase = 'aiming';
    this.power = 0.5;
    this.tip = { x: 0, y: 0 };
    this.aimAngle = 0;
    this.pending = null;
  }

  /** True once only the cue ball is left. */
  get tableCleared(): boolean {
    return this.world.balls.every((b) => b.number === 0 || b.pocketed);
  }
}
