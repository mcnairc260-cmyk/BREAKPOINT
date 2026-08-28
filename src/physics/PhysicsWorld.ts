import { BallBody, type BallSnapshot } from './BallBody';
import { EPS, PHYSICS } from './PhysicsConstants';
import { FrictionModel, SpinModel } from './Models';

export type SimulationEvent =
  | { type: 'ball'; time: number; a: number; b: number; impulse: number }
  | { type: 'rail'; time: number; ball: number; rail: 'left' | 'right' | 'top' | 'bottom'; impulse: number }
  | { type: 'pocket'; time: number; ball: number; pocket: number }
  | { type: 'scratch'; time: number; ball: number };

export type ShotRecord = {
  preShotBallStates: BallSnapshot[];
  cueBallPosition: { x: number; z: number };
  aimAngle: number;
  shotPower: number;
  cueContactPoint: { x: number; y: number };
  generatedImpulse: { x: number; z: number };
  simulationEvents: SimulationEvent[];
  ballsPocketed: number[];
  railContacts: { ball: number; rail: string; time: number }[];
  firstObjectBallContact: number | null;
  cueBallScratch: boolean;
  finalBallStates: BallSnapshot[];
  simulationDuration: number;
};

type Pocket = { x: number; z: number; r: number; nx: number; nz: number };

const pockets: Pocket[] = [
  { x: -PHYSICS.TABLE_HALF_WIDTH, z: -PHYSICS.TABLE_HALF_LENGTH, r: PHYSICS.CORNER_POCKET_RADIUS, nx: 1, nz: 1 },
  { x: PHYSICS.TABLE_HALF_WIDTH, z: -PHYSICS.TABLE_HALF_LENGTH, r: PHYSICS.CORNER_POCKET_RADIUS, nx: -1, nz: 1 },
  { x: -PHYSICS.TABLE_HALF_WIDTH, z: PHYSICS.TABLE_HALF_LENGTH, r: PHYSICS.CORNER_POCKET_RADIUS, nx: 1, nz: -1 },
  { x: PHYSICS.TABLE_HALF_WIDTH, z: PHYSICS.TABLE_HALF_LENGTH, r: PHYSICS.CORNER_POCKET_RADIUS, nx: -1, nz: -1 },
  { x: -PHYSICS.TABLE_HALF_WIDTH, z: 0, r: PHYSICS.SIDE_POCKET_RADIUS, nx: 1, nz: 0 },
  { x: PHYSICS.TABLE_HALF_WIDTH, z: 0, r: PHYSICS.SIDE_POCKET_RADIUS, nx: -1, nz: 0 }
];

export class PhysicsWorld {
  readonly balls: BallBody[] = [];
  accumulator = 0;
  time = 0;
  events: SimulationEvent[] = [];
  activeShot: ShotRecord | null = null;

  addBall(ball: BallBody): void { this.balls.push(ball); }

  static standardRack(): PhysicsWorld {
    const w = new PhysicsWorld();
    w.addBall(new BallBody(0, 0, 0.72));
    const spacing = PHYSICS.BALL_RADIUS * 2.04;
    let id = 1;
    const apexZ = -0.42;
    for (let row = 0; row < 5; row += 1) {
      for (let i = 0; i <= row; i += 1) {
        const x = (i - row / 2) * spacing;
        const z = apexZ - row * spacing * 0.8660254;
        w.addBall(new BallBody(id++, x, z));
      }
    }
    return w;
  }

  resetAccumulator(): void { this.accumulator = 0; }

  stepFrame(frameDt: number): void {
    const clamped = Math.min(0.1, Math.max(0, frameDt));
    this.accumulator += clamped;
    while (this.accumulator + EPS >= PHYSICS.FIXED_DT) {
      this.fixedStep(PHYSICS.FIXED_DT);
      this.accumulator -= PHYSICS.FIXED_DT;
    }
  }

  fixedStep(dt = PHYSICS.FIXED_DT): void {
    let maxSpeed = 0;
    for (const b of this.balls) if (!b.pocketed) maxSpeed = Math.max(maxSpeed, Math.hypot(b.velocity.x, b.velocity.z));
    const micro = Math.min(PHYSICS.MAX_MICROSTEPS, Math.max(1, Math.ceil((maxSpeed * dt) / (PHYSICS.BALL_RADIUS * 0.45))));
    const h = dt / micro;
    for (let m = 0; m < micro; m += 1) this.microStep(h);
    this.time += dt;
    this.updateSleep(dt);
    this.assertFinite();
  }

  private microStep(dt: number): void {
    for (const b of this.balls) {
      if (b.pocketed || b.sleeping) continue;
      FrictionModel.apply(b, dt);
      SpinModel.applyDecay(b, dt);
      b.position.x += b.velocity.x * dt;
      b.position.z += b.velocity.z * dt;
    }

    this.handlePockets();
    this.handleRails();
    for (let pass = 0; pass < 2; pass += 1) this.handleBallCollisions();
  }

  strikeCue(aimAngle: number, power: number, contactX = 0, contactY = 0): ShotRecord {
    if (this.isMoving()) throw new Error('Cannot strike while balls are moving');
    const cue = this.balls.find((b) => b.id === 0);
    if (!cue || cue.pocketed) throw new Error('Cue ball unavailable');
    const p = Math.max(0, Math.min(1, power));
    const dx = Math.sin(aimAngle);
    const dz = -Math.cos(aimAngle);
    const impulseMagnitude = PHYSICS.CUE_MAX_IMPULSE * p;
    const vx = dx * impulseMagnitude / cue.mass;
    const vz = dz * impulseMagnitude / cue.mass;
    const speed = Math.hypot(vx, vz);
    cue.velocity = { x: vx, z: vz };
    cue.angularVelocity = SpinModel.cueAngularVelocity(dx, dz, contactX, contactY, speed);
    cue.wake();
    this.events = [];
    const record: ShotRecord = {
      preShotBallStates: this.balls.map((b) => b.snapshot()),
      cueBallPosition: { ...cue.position },
      aimAngle,
      shotPower: p,
      cueContactPoint: { x: contactX, y: contactY },
      generatedImpulse: { x: dx * impulseMagnitude, z: dz * impulseMagnitude },
      simulationEvents: this.events,
      ballsPocketed: [],
      railContacts: [],
      firstObjectBallContact: null,
      cueBallScratch: false,
      finalBallStates: [],
      simulationDuration: 0
    };
    this.activeShot = record;
    return record;
  }

  finishShotIfSettled(): ShotRecord | null {
    if (!this.activeShot || this.isMoving()) return null;
    this.activeShot.finalBallStates = this.balls.map((b) => b.snapshot());
    this.activeShot.simulationDuration = this.time - (this.activeShot.simulationEvents[0]?.time ?? this.time);
    const done = this.activeShot;
    this.activeShot = null;
    return done;
  }

  isMoving(): boolean {
    return this.balls.some((b) => !b.pocketed && !b.sleeping && (Math.hypot(b.velocity.x, b.velocity.z) > PHYSICS.SLEEP_LINEAR || Math.hypot(b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z) > PHYSICS.SLEEP_ANGULAR));
  }

  totalEnergy(): number { return this.balls.reduce((sum, b) => sum + b.kineticEnergy(), 0); }

  private handleBallCollisions(): void {
    const diameter = PHYSICS.BALL_RADIUS * 2;
    for (let i = 0; i < this.balls.length; i += 1) {
      const a = this.balls[i]!;
      if (a.pocketed) continue;
      for (let j = i + 1; j < this.balls.length; j += 1) {
        const b = this.balls[j]!;
        if (b.pocketed) continue;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const dist2 = dx * dx + dz * dz;
        if (dist2 >= diameter * diameter) continue;
        const dist = Math.sqrt(Math.max(dist2, EPS));
        const nx = dist > EPS ? dx / dist : 1;
        const nz = dist > EPS ? dz / dist : 0;
        const penetration = diameter - dist;
        const correction = Math.max(0, penetration - PHYSICS.POSITION_SLOP) * PHYSICS.POSITION_CORRECTION * 0.5;
        a.position.x -= nx * correction; a.position.z -= nz * correction;
        b.position.x += nx * correction; b.position.z += nz * correction;

        const rvx = b.velocity.x - a.velocity.x;
        const rvz = b.velocity.z - a.velocity.z;
        const vn = rvx * nx + rvz * nz;
        if (vn >= 0) continue;
        const invMass = 1 / a.mass + 1 / b.mass;
        const jn = -(1 + PHYSICS.BALL_RESTITUTION) * vn / invMass;
        const ix = jn * nx; const iz = jn * nz;
        a.velocity.x -= ix / a.mass; a.velocity.z -= iz / a.mass;
        b.velocity.x += ix / b.mass; b.velocity.z += iz / b.mass;

        const tx = -nz, tz = nx;
        const vt = rvx * tx + rvz * tz;
        const jt = Math.max(-jn * PHYSICS.BALL_FRICTION, Math.min(jn * PHYSICS.BALL_FRICTION, -vt / invMass));
        a.velocity.x -= jt * tx / a.mass; a.velocity.z -= jt * tz / a.mass;
        b.velocity.x += jt * tx / b.mass; b.velocity.z += jt * tz / b.mass;
        const spinImpulse = (2.5 * jt) / (a.mass * a.radius);
        a.angularVelocity.y -= spinImpulse;
        b.angularVelocity.y += spinImpulse;
        a.wake(); b.wake();
        this.emit({ type: 'ball', time: this.time, a: a.id, b: b.id, impulse: Math.abs(jn) });
      }
    }
  }

  private handleRails(): void {
    const xLimit = PHYSICS.TABLE_HALF_WIDTH - PHYSICS.BALL_RADIUS;
    const zLimit = PHYSICS.TABLE_HALF_LENGTH - PHYSICS.BALL_RADIUS;
    for (const b of this.balls) {
      if (b.pocketed) continue;
      this.railAxis(b, 'x', -xLimit, 'left', 1, 0);
      this.railAxis(b, 'x', xLimit, 'right', -1, 0);
      this.railAxis(b, 'z', -zLimit, 'top', 0, 1);
      this.railAxis(b, 'z', zLimit, 'bottom', 0, -1);
    }
  }

  private railAxis(b: BallBody, axis: 'x' | 'z', limit: number, rail: 'left' | 'right' | 'top' | 'bottom', nx: number, nz: number): void {
    const beyond = limit < 0 ? b.position[axis] < limit : b.position[axis] > limit;
    if (!beyond || this.nearPocketOpening(b.position.x, b.position.z, axis, limit)) return;
    b.position[axis] = limit;
    const vn = b.velocity.x * nx + b.velocity.z * nz;
    if (vn >= 0) return;
    const tx = -nz, tz = nx;
    const vt = b.velocity.x * tx + b.velocity.z * tz;
    const sideSurface = b.angularVelocity.y * b.radius;
    const slipT = vt - sideSurface;
    const normalAfter = -vn * PHYSICS.RAIL_RESTITUTION;
    const deltaN = normalAfter - vn;
    b.velocity.x += nx * deltaN; b.velocity.z += nz * deltaN;
    const tangentDelta = Math.max(-Math.abs(deltaN) * PHYSICS.RAIL_TANGENTIAL_FRICTION, Math.min(Math.abs(deltaN) * PHYSICS.RAIL_TANGENTIAL_FRICTION, -slipT));
    b.velocity.x += tx * tangentDelta; b.velocity.z += tz * tangentDelta;
    b.angularVelocity.y -= tangentDelta / Math.max(EPS, b.radius) * 0.7;
    b.wake();
    this.emit({ type: 'rail', time: this.time, ball: b.id, rail, impulse: Math.abs(deltaN) * b.mass });
  }

  private nearPocketOpening(x: number, z: number, axis: 'x' | 'z', limit: number): boolean {
    if (axis === 'x') return Math.abs(z) < PHYSICS.SIDE_POCKET_RADIUS * 1.15 || Math.abs(Math.abs(z) - PHYSICS.TABLE_HALF_LENGTH) < PHYSICS.CORNER_POCKET_RADIUS * 1.25;
    return Math.abs(Math.abs(x) - PHYSICS.TABLE_HALF_WIDTH) < PHYSICS.CORNER_POCKET_RADIUS * 1.25;
  }

  private handlePockets(): void {
    for (const b of this.balls) {
      if (b.pocketed) continue;
      for (let i = 0; i < pockets.length; i += 1) {
        const p = pockets[i]!;
        const dx = b.position.x - p.x, dz = b.position.z - p.z;
        const d = Math.hypot(dx, dz);
        if (d >= p.r) continue;
        const speed = Math.hypot(b.velocity.x, b.velocity.z);
        const toward = -(b.velocity.x * p.nx + b.velocity.z * p.nz);
        const deep = d < p.r * 0.58;
        if (deep || (speed < PHYSICS.POCKET_CAPTURE_SPEED && toward > -0.15)) {
          b.pocketed = true; b.velocity = { x: 0, z: 0 }; b.angularVelocity = { x: 0, y: 0, z: 0 }; b.sleeping = true;
          this.emit({ type: b.id === 0 ? 'scratch' : 'pocket', time: this.time, ...(b.id === 0 ? { ball: b.id } : { ball: b.id, pocket: i }) } as SimulationEvent);
          break;
        }
        if (speed > PHYSICS.POCKET_REJECT_SPEED && !deep) {
          const nx = d > EPS ? dx / d : p.nx, nz = d > EPS ? dz / d : p.nz;
          const vn = b.velocity.x * nx + b.velocity.z * nz;
          if (vn < 0) { b.velocity.x -= 1.55 * vn * nx; b.velocity.z -= 1.55 * vn * nz; }
        }
      }
    }
  }

  private updateSleep(dt: number): void {
    for (const b of this.balls) {
      if (b.pocketed) continue;
      const linear = Math.hypot(b.velocity.x, b.velocity.z);
      const angular = Math.hypot(b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z);
      if (linear < PHYSICS.SLEEP_LINEAR && angular < PHYSICS.SLEEP_ANGULAR) {
        b.sleepTimer += dt;
        if (b.sleepTimer >= PHYSICS.SLEEP_TIME) {
          b.velocity = { x: 0, z: 0 }; b.angularVelocity = { x: 0, y: 0, z: 0 }; b.sleeping = true;
        }
      } else { b.sleepTimer = 0; b.sleeping = false; }
    }
  }

  private emit(event: SimulationEvent): void {
    this.events.push(event);
    const s = this.activeShot;
    if (!s) return;
    if (event.type === 'ball' && s.firstObjectBallContact == null) {
      if (event.a === 0) s.firstObjectBallContact = event.b;
      else if (event.b === 0) s.firstObjectBallContact = event.a;
    }
    if (event.type === 'rail') s.railContacts.push({ ball: event.ball, rail: event.rail, time: event.time });
    if (event.type === 'pocket' && !s.ballsPocketed.includes(event.ball)) s.ballsPocketed.push(event.ball);
    if (event.type === 'scratch') s.cueBallScratch = true;
  }

  private assertFinite(): void {
    for (const b of this.balls) {
      if (!b.finite()) throw new Error(`Non-finite physics state on ball ${b.id}`);
      const speed = Math.hypot(b.velocity.x, b.velocity.z);
      if (speed > PHYSICS.MAX_SPEED) {
        const s = PHYSICS.MAX_SPEED / speed; b.velocity.x *= s; b.velocity.z *= s;
      }
    }
  }
}
