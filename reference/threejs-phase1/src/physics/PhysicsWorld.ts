import {
  belowRestThreshold,
  cloneBall,
  createBall,
  forceRest,
  integrateOrientation,
  type BallBody,
} from './BallBody';
import { resolveBallCollision, timeOfImpact } from './BallCollision';
import { applyClothFriction } from './FrictionModel';
import {
  BALL_INERTIA,
  BALL_MASS,
  BALL_RESTITUTION,
  FIXED_DT,
  JAW_RESTITUTION,
  MAX_SHOT_SECONDS,
  RAIL_RESTITUTION,
} from './PhysicsConstants';
import { capture, findCapture } from './PocketPhysics';
import {
  depenetrateJaw,
  depenetrateRail,
  jawTimeOfImpact,
  railGap,
  railTimeOfImpact,
  resolveJawCollision,
  resolveRailCollision,
  withinRailSpan,
} from './RailCollision';
import { createTable, type Pocket, type TableGeometry } from './TableGeometry';
import type { Vec2 } from './Vec';

/**
 * The simulation.
 *
 * Two properties are load-bearing and are each covered by a regression test:
 *
 *  1. **Fixed timestep.** `step()` always advances exactly FIXED_DT (1/120 s).
 *     The renderer calls it in a fixed-step accumulator loop, so a 30 fps
 *     machine and a 144 fps machine produce bit-identical results.
 *
 *  2. **Continuous collision within the step.** A step is not integrated in one
 *     go. The world repeatedly finds the *earliest* contact in the remaining
 *     time, advances everything exactly to it, resolves it, and continues. A
 *     ball at break speed covers ~10 cm per step — nearly two ball diameters —
 *     so integrating blindly would let it pass through another ball. Cutting
 *     the step at the contact makes tunnelling impossible rather than unlikely.
 *
 * There is no randomness anywhere. Identical inputs give identical outputs.
 */

export type SimEvent =
  | { type: 'ball-ball'; time: number; a: number; b: number; impulse: number; at: Vec2 }
  | { type: 'rail'; time: number; ball: number; rail: string; impulse: number; at: Vec2 }
  | { type: 'jaw'; time: number; ball: number; jaw: string; impulse: number; at: Vec2 }
  | { type: 'pocket'; time: number; ball: number; pocket: string; at: Vec2 }
  | { type: 'rest'; time: number };

/** Cap on contact resolutions inside one 1/120 s step. */
const MAX_SUBSTEPS = 48;
/** Sub-step times below this are treated as zero to avoid a stall loop. */
const TIME_EPSILON = 1e-9;
/**
 * Contacts within this many seconds of each other are treated as simultaneous.
 * At the fastest legal ball speed (12 m/s) it is a separation of 1.2 µm, four
 * orders of magnitude below a ball radius — far too close to call an order.
 */
const SIMULTANEITY_EPSILON = 1e-7;
/** Slack allowed when checking a batch resolution did not create energy. */
const ENERGY_EPSILON = 1e-12;
/** Relaxation passes allowed when solving a simultaneous batch. */
const MAX_BATCH_PASSES = 12;

/** Stable identity for a contact, used to retire inert ones within a step. */
function contactKey(c: Contact): string {
  return `${c.kind}:${c.a}:${c.b}:${c.railIndex}`;
}

interface Contact {
  time: number;
  kind: 'ball' | 'rail' | 'jaw';
  a: number;
  b: number;
  railIndex: number;
}

export class PhysicsWorld {
  readonly table: TableGeometry;
  readonly balls: BallBody[] = [];
  /** Simulated seconds since the world was created. */
  time = 0;
  /** Events produced since `clearEvents()`. Drained each frame by game code. */
  readonly events: SimEvent[] = [];
  /** Set if a non-finite state was ever detected and quarantined. */
  corrupted = false;

  /** Contacts retired for the current step; see `step()`. */
  private readonly inert = new Set<string>();
  /**
   * Scratch buffers for contact detection, reused across sub-steps.
   *
   * `findSimultaneousContacts` runs up to MAX_SUBSTEPS times per 120 Hz step,
   * so allocating fresh arrays there would churn thousands of short-lived
   * objects a second for no reason. These are private and are consumed before
   * the next call, so reuse is safe.
   */
  private readonly candidates: Contact[] = [];
  private readonly batch: Contact[] = [];

  constructor(table: TableGeometry = createTable()) {
    this.table = table;
  }

  addBall(number: number, position: Vec2): BallBody {
    const ball = createBall(this.balls.length, number, position);
    this.balls.push(ball);
    return ball;
  }

  get cueBall(): BallBody | undefined {
    return this.balls.find((b) => b.number === 0);
  }

  clearEvents(): void {
    this.events.length = 0;
  }

  /** True when nothing is moving — the shot is over and input can reopen. */
  isSettled(): boolean {
    return this.balls.every((b) => b.pocketed || b.resting);
  }

  /** Total kinetic energy, translational + rotational. */
  totalEnergy(): number {
    let e = 0;
    for (const b of this.balls) {
      if (b.pocketed) continue;
      const v2 = b.velocity.x * b.velocity.x + b.velocity.y * b.velocity.y;
      const w2 = b.spin.x * b.spin.x + b.spin.y * b.spin.y + b.spin.z * b.spin.z;
      e += 0.5 * BALL_MASS * v2 + 0.5 * BALL_INERTIA * w2;
    }
    return e;
  }

  snapshot(): BallBody[] {
    return this.balls.map(cloneBall);
  }

  restore(snapshot: readonly BallBody[]): void {
    this.balls.length = 0;
    for (const b of snapshot) this.balls.push(cloneBall(b));
  }

  /** Advance exactly one fixed timestep. */
  step(): void {
    let remaining = FIXED_DT;
    this.inert.clear();

    for (let iter = 0; iter < MAX_SUBSTEPS && remaining > TIME_EPSILON; iter++) {
      const batch = this.findSimultaneousContacts(remaining);
      const dt = batch.length > 0 ? Math.max(batch[0].time, 0) : remaining;

      if (dt > TIME_EPSILON) this.integrate(dt);
      remaining -= dt;

      if (batch.length === 0) break;

      this.resolveBatch(batch);
    }

    this.depenetrate();
    this.time += FIXED_DT;
    this.settleBalls();
    this.sanitize();
  }

  /**
   * Run to completion and return how long the shot took.
   *
   * Used by the regression suite and by the shot recorder; the interactive game
   * steps frame by frame so the player can watch.
   */
  simulateToRest(maxSeconds = MAX_SHOT_SECONDS): number {
    const start = this.time;
    const limit = Math.ceil(maxSeconds / FIXED_DT);
    for (let i = 0; i < limit && !this.isSettled(); i++) this.step();
    return this.time - start;
  }

  // ---------------------------------------------------------------- internals

  /**
   * Integrate positions by `dt` at the current velocities — which is exactly
   * the assumption the time-of-impact solver made — then apply cloth friction
   * and roll the render orientation forward.
   */
  private integrate(dt: number): void {
    for (const b of this.balls) {
      if (b.pocketed || b.resting) continue;
      const px = b.position.x;
      const py = b.position.y;
      b.position.x = px + b.velocity.x * dt;
      b.position.y = py + b.velocity.y * dt;

      const pocket = this.sweptCapture(b, px, py);
      if (pocket) {
        capture(b, pocket);
        this.events.push({
          type: 'pocket',
          time: this.time,
          ball: b.id,
          pocket: pocket.id,
          at: { x: pocket.centre.x, y: pocket.centre.y },
        });
        continue;
      }

      applyClothFriction(b, dt);
      integrateOrientation(b, dt);
    }
  }

  /**
   * Capture test swept along the ball's path this sub-step.
   *
   * A point test would let a ball moving 12 m/s skip straight over a 5.7 cm
   * capture disc, so the test is against the closest approach of the segment
   * the ball actually travelled.
   */
  private sweptCapture(b: BallBody, fromX: number, fromY: number): Pocket | null {
    const dx = b.position.x - fromX;
    const dy = b.position.y - fromY;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-14) return findCapture(b, this.table);

    for (const pocket of this.table.pockets) {
      const t = Math.max(
        0,
        Math.min(1, ((pocket.centre.x - fromX) * dx + (pocket.centre.y - fromY) * dy) / lenSq),
      );
      const cx = fromX + dx * t - pocket.centre.x;
      const cy = fromY + dy * t - pocket.centre.y;
      if (cx * cx + cy * cy <= pocket.captureRadius * pocket.captureRadius) return pocket;
    }
    // The swept test only covers the capture point. A ball that threaded a
    // mouth without passing close enough to it is caught by the throat rule in
    // `findCapture`, evaluated where the ball actually ended up.
    return findCapture(b, this.table);
  }

  /**
   * Every contact that happens at the earliest contact time in (0, limit].
   *
   * Returning the whole simultaneous set rather than just the first one is what
   * lets `resolveBatch` treat them as the simultaneous event they physically
   * are. The scan order is fixed, so the *contents* of the batch — and
   * therefore the result — are deterministic.
   */
  private findSimultaneousContacts(limit: number): Contact[] {
    const found = this.candidates;
    found.length = 0;
    let earliest = Infinity;
    const take = (c: Contact) => {
      if (this.inert.has(contactKey(c))) return;
      if (c.time < earliest) earliest = c.time;
      found.push(c);
    };

    const n = this.balls.length;
    for (let i = 0; i < n; i++) {
      const a = this.balls[i];
      if (a.pocketed) continue;

      for (let j = i + 1; j < n; j++) {
        const b = this.balls[j];
        if (b.pocketed) continue;
        if (a.resting && b.resting) continue;
        const t = timeOfImpact(a, b, limit);
        if (t !== null) take({ time: t, kind: 'ball', a: i, b: j, railIndex: -1 });
      }

      if (a.resting) continue;

      for (let r = 0; r < this.table.rails.length; r++) {
        const t = railTimeOfImpact(a, this.table.rails[r], limit);
        if (t !== null) take({ time: t, kind: 'rail', a: i, b: -1, railIndex: r });
      }
      for (let k = 0; k < this.table.jaws.length; k++) {
        const t = jawTimeOfImpact(a, this.table.jaws[k], limit);
        if (t !== null) take({ time: t, kind: 'jaw', a: i, b: -1, railIndex: k });
      }
    }

    const batch = this.batch;
    batch.length = 0;
    for (const c of found) {
      if (c.time - earliest <= SIMULTANEITY_EPSILON) batch.push(c);
    }
    return batch;
  }

  /**
   * Resolve every contact that happens at the same instant, together.
   *
   * A cue ball splitting a frozen pair touches both object balls at the same
   * moment. Resolving them one after another gives the first contact a clean
   * cue ball and the second one a cue ball that has already been deflected, so
   * a dead-centre split squirts the cue ball sideways and the two object balls
   * leave at different speeds — an outcome that also depends on which ball
   * happens to sit earlier in the array. A rack is full of frozen pairs, so
   * this fires on every break.
   *
   * The fix is to compute each impulse in the batch against the *same*
   * pre-impulse state and then apply the sum (a Jacobi step). Symmetric input
   * then gives symmetric output, and the result no longer depends on storage
   * order.
   *
   * Summing full impulses can in principle over-correct when one ball takes
   * several at once, so the batch is checked against the energy it started
   * with and abandoned in favour of the sequential result if it would ever
   * create energy. The no-energy-created invariant outranks the symmetry fix.
   *
   * A batch of one — overwhelmingly the common case — takes the sequential
   * path unchanged.
   */
  private resolveBatch(contacts: Contact[]): void {
    if (contacts.length === 1) {
      this.retireIfInert(contacts[0], this.emitResolve(contacts[0]));
      return;
    }

    const indices: number[] = [];
    let maxPerBody = 1;
    const load = new Map<number, number>();
    for (const c of contacts) {
      for (const i of c.b >= 0 ? [c.a, c.b] : [c.a]) {
        if (!indices.includes(i)) indices.push(i);
        const n = (load.get(i) ?? 0) + 1;
        load.set(i, n);
        if (n > maxPerBody) maxPerBody = n;
      }
    }

    const before = indices.map((i) => cloneBall(this.balls[i]));
    const energyBefore = this.energyOf(indices);
    const eventsBefore = this.events.length;

    // Applying every contact's full impulse at once double-counts on a ball
    // that takes several of them, which overshoots and creates energy. Sharing
    // the ball out between its contacts and iterating converges on the
    // simultaneous answer instead, and because every pass is computed from one
    // shared state the symmetry is preserved at every step.
    //
    // The iteration runs perfectly inelastically (restitution zero), because
    // repeatedly applying -(1+e)·vn converges on vn = 0 whatever e is, landing
    // somewhere between the inelastic and the elastic answer depending on where
    // the passes happen to stop. Solving for vn = 0 exactly and then scaling
    // the whole result by (1+e) is the standard Poisson treatment of a
    // simultaneous impact, and for the frozen-pair case it reproduces the
    // closed-form elastic solution exactly.
    const relaxation = 1 / maxPerBody;
    const impulses = contacts.map(() => 0);

    for (let pass = 0; pass < MAX_BATCH_PASSES; pass++) {
      const pre = indices.map((i) => cloneBall(this.balls[i]));
      const deltas = indices.map(() => ({ vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, px: 0, py: 0 }));
      let active = 0;

      for (let ci = 0; ci < contacts.length; ci++) {
        this.restoreBodies(indices, pre);
        const impulse = this.applyContact(contacts[ci], 0);
        if (impulse > 0) {
          active++;
          impulses[ci] += impulse * relaxation;
        }
        for (let k = 0; k < indices.length; k++) {
          const now = this.balls[indices[k]];
          const base = pre[k];
          const d = deltas[k];
          d.vx += now.velocity.x - base.velocity.x;
          d.vy += now.velocity.y - base.velocity.y;
          d.wx += now.spin.x - base.spin.x;
          d.wy += now.spin.y - base.spin.y;
          d.wz += now.spin.z - base.spin.z;
          d.px += now.position.x - base.position.x;
          d.py += now.position.y - base.position.y;
        }
      }

      this.restoreBodies(indices, pre);
      if (active === 0) break;

      for (let k = 0; k < indices.length; k++) {
        const ball = this.balls[indices[k]];
        const d = deltas[k];
        ball.velocity.x += d.vx * relaxation;
        ball.velocity.y += d.vy * relaxation;
        ball.spin.x += d.wx * relaxation;
        ball.spin.y += d.wy * relaxation;
        ball.spin.z += d.wz * relaxation;
        ball.position.x += d.px * relaxation;
        ball.position.y += d.py * relaxation;
      }
    }

    // Restitution: add e times the whole inelastic result, giving (1+e) times
    // it in total. Positions are excluded — separation is geometric, not an
    // impulse, and scaling it would push balls apart by more than they overlap.
    const e = this.batchRestitution(contacts);
    for (let k = 0; k < indices.length; k++) {
      const ball = this.balls[indices[k]];
      const base = before[k];
      const dvx = ball.velocity.x - base.velocity.x;
      const dvy = ball.velocity.y - base.velocity.y;
      const dwx = ball.spin.x - base.spin.x;
      const dwy = ball.spin.y - base.spin.y;
      const dwz = ball.spin.z - base.spin.z;
      ball.velocity.x += dvx * e;
      ball.velocity.y += dvy * e;
      ball.spin.x += dwx * e;
      ball.spin.y += dwy * e;
      ball.spin.z += dwz * e;
      if (dvx !== 0 || dvy !== 0 || dwx !== 0 || dwy !== 0 || dwz !== 0) ball.resting = false;
    }
    for (let i = 0; i < impulses.length; i++) impulses[i] *= 1 + e;

    if (this.energyOf(indices) > energyBefore + ENERGY_EPSILON) {
      this.restoreBodies(indices, before);
      this.events.length = eventsBefore;
      for (const c of contacts) this.retireIfInert(c, this.emitResolve(c));
      return;
    }

    for (let i = 0; i < contacts.length; i++) {
      this.emitContactEvent(contacts[i], impulses[i]);
      this.retireIfInert(contacts[i], impulses[i]);
    }
  }

  /**
   * A contact that produces no impulse is *inert*: geometrically touching, but
   * not actually approaching once the contact point's own motion is taken into
   * account (a ball held against a cushion with heavy draw is the usual case).
   * Left in the candidate set it would be re-detected at t = 0 for the rest of
   * the step and the loop would spin without advancing time — the balls would
   * appear to freeze mid-table. Retiring it for the remainder of this step is
   * what guarantees forward progress.
   */
  private retireIfInert(c: Contact, impulse: number): void {
    if (impulse <= 0) this.inert.add(contactKey(c));
  }

  /** Kinetic energy of just the listed balls. */
  private energyOf(indices: readonly number[]): number {
    let e = 0;
    for (const i of indices) {
      const b = this.balls[i];
      if (b.pocketed) continue;
      const v2 = b.velocity.x * b.velocity.x + b.velocity.y * b.velocity.y;
      const w2 = b.spin.x * b.spin.x + b.spin.y * b.spin.y + b.spin.z * b.spin.z;
      e += 0.5 * BALL_MASS * v2 + 0.5 * BALL_INERTIA * w2;
    }
    return e;
  }

  private restoreBodies(indices: readonly number[], snapshot: readonly BallBody[]): void {
    for (let k = 0; k < indices.length; k++) {
      const ball = this.balls[indices[k]];
      const base = snapshot[k];
      ball.position.x = base.position.x;
      ball.position.y = base.position.y;
      ball.velocity.x = base.velocity.x;
      ball.velocity.y = base.velocity.y;
      ball.spin.x = base.spin.x;
      ball.spin.y = base.spin.y;
      ball.spin.z = base.spin.z;
      ball.resting = base.resting;
    }
  }

  /** Mutate state for one contact and return its normal impulse. No events. */
  private applyContact(c: Contact, restitution?: number): number {
    if (c.kind === 'ball') {
      return resolveBallCollision(this.balls[c.a], this.balls[c.b], restitution);
    }
    if (c.kind === 'rail') {
      return resolveRailCollision(this.balls[c.a], this.table.rails[c.railIndex], restitution);
    }
    return resolveJawCollision(this.balls[c.a], this.table.jaws[c.railIndex], restitution);
  }

  /** The least elastic coefficient in a batch — the conservative choice. */
  private batchRestitution(contacts: readonly Contact[]): number {
    let e = Infinity;
    for (const c of contacts) {
      const own =
        c.kind === 'ball' ? BALL_RESTITUTION : c.kind === 'rail' ? RAIL_RESTITUTION : JAW_RESTITUTION;
      if (own < e) e = own;
    }
    return e;
  }

  private emitContactEvent(c: Contact, impulse: number): void {
    if (impulse <= 0) return;
    if (c.kind === 'ball') {
      const a = this.balls[c.a];
      const b = this.balls[c.b];
      this.events.push({
        type: 'ball-ball',
        time: this.time,
        a: a.id,
        b: b.id,
        impulse,
        at: { x: (a.position.x + b.position.x) / 2, y: (a.position.y + b.position.y) / 2 },
      });
      return;
    }
    const ball = this.balls[c.a];
    if (c.kind === 'rail') {
      this.events.push({
        type: 'rail',
        time: this.time,
        ball: ball.id,
        rail: this.table.rails[c.railIndex].id,
        impulse,
        at: { x: ball.position.x, y: ball.position.y },
      });
      return;
    }
    this.events.push({
      type: 'jaw',
      time: this.time,
      ball: ball.id,
      jaw: this.table.jaws[c.railIndex].id,
      impulse,
      at: { x: ball.position.x, y: ball.position.y },
    });
  }

  private emitResolve(c: Contact): number {
    if (c.kind === 'ball') {
      const a = this.balls[c.a];
      const b = this.balls[c.b];
      const impulse = resolveBallCollision(a, b);
      if (impulse > 0) {
        this.events.push({
          type: 'ball-ball',
          time: this.time,
          a: a.id,
          b: b.id,
          impulse,
          at: { x: (a.position.x + b.position.x) / 2, y: (a.position.y + b.position.y) / 2 },
        });
      }
      return impulse;
    }

    const ball = this.balls[c.a];
    if (c.kind === 'rail') {
      const rail = this.table.rails[c.railIndex];
      const impulse = resolveRailCollision(ball, rail);
      if (impulse > 0) {
        this.events.push({
          type: 'rail',
          time: this.time,
          ball: ball.id,
          rail: rail.id,
          impulse,
          at: { x: ball.position.x, y: ball.position.y },
        });
      }
      return impulse;
    }

    const jaw = this.table.jaws[c.railIndex];
    const impulse = resolveJawCollision(ball, jaw);
    if (impulse > 0) {
      this.events.push({
        type: 'jaw',
        time: this.time,
        ball: ball.id,
        jaw: jaw.id,
        impulse,
        at: { x: ball.position.x, y: ball.position.y },
      });
    }
    return impulse;
  }

  /**
   * Position-only escape hatch: push any ball that has ended the step inside a
   * cushion or a jaw back to the surface.
   *
   * This is the safety net for inert contacts. A ball the impulse solver
   * declined to act on keeps its inward velocity, so without this it would
   * creep through the rail over successive steps. Correcting position without
   * touching velocity cannot add energy, which is what keeps the "no energy
   * created" guarantee intact.
   */
  private depenetrate(): void {
    for (const ball of this.balls) {
      if (ball.pocketed) continue;
      for (const rail of this.table.rails) {
        if (railGap(ball, rail) < 0 && withinRailSpan(ball, rail)) depenetrateRail(ball, rail);
      }
      for (const jaw of this.table.jaws) depenetrateJaw(ball, jaw);
    }
  }

  /** Snap balls below the rest thresholds to exact zero, and emit 'rest' once. */
  private settleBalls(): void {
    const wasSettled = this.balls.every((b) => b.pocketed || b.resting);
    for (const b of this.balls) {
      if (b.pocketed || b.resting) continue;
      if (belowRestThreshold(b)) forceRest(b);
    }
    if (!wasSettled && this.isSettled()) {
      this.events.push({ type: 'rest', time: this.time });
    }
  }

  /**
   * The NaN/Infinity tripwire.
   *
   * Nothing in the model should produce a non-finite value — every
   * normalisation guards its divisor and every friction term is clamped — but a
   * physics core that silently poisons the whole table is far worse than one
   * that stops a single ball, so the state is checked every step and any bad
   * ball is frozen rather than allowed to spread NaN through a collision.
   */
  private sanitize(): void {
    for (const b of this.balls) {
      if (
        Number.isFinite(b.position.x) &&
        Number.isFinite(b.position.y) &&
        Number.isFinite(b.velocity.x) &&
        Number.isFinite(b.velocity.y) &&
        Number.isFinite(b.spin.x) &&
        Number.isFinite(b.spin.y) &&
        Number.isFinite(b.spin.z)
      ) {
        continue;
      }
      this.corrupted = true;
      if (!Number.isFinite(b.position.x)) b.position.x = 0;
      if (!Number.isFinite(b.position.y)) b.position.y = 0;
      forceRest(b);
    }
  }
}
