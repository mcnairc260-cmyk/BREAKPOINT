import { BallBody } from './BallBody';
import { EPS, PHYSICS } from './PhysicsConstants';

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export class FrictionModel {
  static apply(ball: BallBody, dt: number): void {
    if (ball.pocketed || ball.sleeping) return;
    const speed = Math.hypot(ball.velocity.x, ball.velocity.z);
    if (speed < EPS) return;

    // Velocity at the cloth contact patch. For a sphere on a horizontal plane,
    // rolling condition is v = (r*wz, -r*wx).
    const contactX = ball.velocity.x - ball.radius * ball.angularVelocity.z;
    const contactZ = ball.velocity.z + ball.radius * ball.angularVelocity.x;
    const slip = Math.hypot(contactX, contactZ);

    if (slip > 0.015) {
      const maxDv = PHYSICS.SLIDING_FRICTION * PHYSICS.GRAVITY * dt;
      const dv = Math.min(maxDv, slip);
      const nx = contactX / slip;
      const nz = contactZ / slip;
      ball.velocity.x -= nx * dv;
      ball.velocity.z -= nz * dv;

      // Equal/opposite cloth impulse produces torque. I=2/5mr² => angular factor 5/(2r).
      const angularDelta = (2.5 * dv) / ball.radius;
      ball.angularVelocity.z += nx * angularDelta;
      ball.angularVelocity.x -= nz * angularDelta;
    } else {
      const decel = PHYSICS.ROLLING_FRICTION * PHYSICS.GRAVITY * dt;
      const next = Math.max(0, speed - decel);
      const scale = speed > EPS ? next / speed : 0;
      ball.velocity.x *= scale;
      ball.velocity.z *= scale;
      if (next > EPS) {
        ball.angularVelocity.z = ball.velocity.x / ball.radius;
        ball.angularVelocity.x = -ball.velocity.z / ball.radius;
      }
    }
  }
}

export class SpinModel {
  static applyDecay(ball: BallBody, dt: number): void {
    if (ball.pocketed || ball.sleeping) return;
    const sideDecay = Math.exp(-PHYSICS.SPIN_DECAY * dt);
    ball.angularVelocity.y *= sideDecay;
    ball.angularVelocity.x = clamp(ball.angularVelocity.x, -PHYSICS.MAX_ANGULAR, PHYSICS.MAX_ANGULAR);
    ball.angularVelocity.y = clamp(ball.angularVelocity.y, -PHYSICS.MAX_ANGULAR, PHYSICS.MAX_ANGULAR);
    ball.angularVelocity.z = clamp(ball.angularVelocity.z, -PHYSICS.MAX_ANGULAR, PHYSICS.MAX_ANGULAR);
  }

  static cueAngularVelocity(aimX: number, aimZ: number, contactX: number, contactY: number, speed: number): { x: number; y: number; z: number } {
    const forwardRollX = -aimZ * speed / PHYSICS.BALL_RADIUS;
    const forwardRollZ = aimX * speed / PHYSICS.BALL_RADIUS;
    const verticalSpin = contactY * speed * 34;
    const sideSpin = -contactX * speed * 42;
    return {
      x: clamp(forwardRollX * 0.35 - aimZ * verticalSpin, -PHYSICS.MAX_ANGULAR, PHYSICS.MAX_ANGULAR),
      y: clamp(sideSpin, -PHYSICS.MAX_ANGULAR, PHYSICS.MAX_ANGULAR),
      z: clamp(forwardRollZ * 0.35 + aimX * verticalSpin, -PHYSICS.MAX_ANGULAR, PHYSICS.MAX_ANGULAR)
    };
  }
}
