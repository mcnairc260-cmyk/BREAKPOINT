import { PHYSICS } from './PhysicsConstants';

export type Vec2 = { x: number; z: number };
export type Vec3 = { x: number; y: number; z: number };

export type BallSnapshot = {
  id: number;
  position: Vec2;
  velocity: Vec2;
  angularVelocity: Vec3;
  pocketed: boolean;
  sleeping: boolean;
};

export class BallBody {
  readonly id: number;
  readonly radius = PHYSICS.BALL_RADIUS;
  readonly mass = PHYSICS.BALL_MASS;
  position: Vec2;
  velocity: Vec2 = { x: 0, z: 0 };
  angularVelocity: Vec3 = { x: 0, y: 0, z: 0 };
  pocketed = false;
  sleeping = false;
  sleepTimer = 0;

  constructor(id: number, x: number, z: number) {
    this.id = id;
    this.position = { x, z };
  }

  snapshot(): BallSnapshot {
    return {
      id: this.id,
      position: { ...this.position },
      velocity: { ...this.velocity },
      angularVelocity: { ...this.angularVelocity },
      pocketed: this.pocketed,
      sleeping: this.sleeping
    };
  }

  restore(s: BallSnapshot): void {
    this.position = { ...s.position };
    this.velocity = { ...s.velocity };
    this.angularVelocity = { ...s.angularVelocity };
    this.pocketed = s.pocketed;
    this.sleeping = s.sleeping;
    this.sleepTimer = 0;
  }

  wake(): void {
    this.sleeping = false;
    this.sleepTimer = 0;
  }

  kineticEnergy(): number {
    if (this.pocketed) return 0;
    const v2 = this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z;
    const w2 = this.angularVelocity.x ** 2 + this.angularVelocity.y ** 2 + this.angularVelocity.z ** 2;
    const inertia = (2 / 5) * this.mass * this.radius * this.radius;
    return 0.5 * this.mass * v2 + 0.5 * inertia * w2;
  }

  finite(): boolean {
    const values = [
      this.position.x, this.position.z, this.velocity.x, this.velocity.z,
      this.angularVelocity.x, this.angularVelocity.y, this.angularVelocity.z
    ];
    return values.every(Number.isFinite);
  }
}
