import * as THREE from 'three';
import { BALL_RADIUS } from '../physics/PhysicsConstants';
import type { Vec2 } from '../physics/Vec';

/**
 * The cue.
 *
 * It exists to answer three questions the player asks continuously: which way
 * am I aiming, how hard am I about to hit, and where on the ball will the tip
 * land. So the cue's yaw is the aim angle, its distance from the ball is the
 * power, and its tip is offset by the chosen contact point — the same three
 * numbers the shot system will hand to the physics, shown rather than
 * described.
 */

const CUE_LENGTH = 1.45;
const BUTT_RADIUS = 0.0135;
const TIP_RADIUS = 0.0065;
/** How far the tip sits off the ball at zero power, and at full power. */
const IDLE_GAP = 0.02;
const MAX_PULL = 0.34;

export class CueMesh {
  readonly root = new THREE.Group();

  constructor() {
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(TIP_RADIUS, BUTT_RADIUS, CUE_LENGTH, 20),
      new THREE.MeshPhysicalMaterial({
        color: 0x8a6a42,
        roughness: 0.34,
        metalness: 0.05,
        clearcoat: 0.7,
        clearcoatRoughness: 0.15,
      }),
    );
    // Lie the cylinder along +X, tip at the origin, butt trailing behind.
    shaft.rotation.z = Math.PI / 2;
    shaft.position.x = -CUE_LENGTH / 2;
    shaft.castShadow = true;
    this.root.add(shaft);

    const wrap = new THREE.Mesh(
      new THREE.CylinderGeometry(BUTT_RADIUS * 1.02, BUTT_RADIUS * 1.06, 0.3, 20),
      new THREE.MeshStandardMaterial({ color: 0x14141c, roughness: 0.85 }),
    );
    wrap.rotation.z = Math.PI / 2;
    wrap.position.x = -CUE_LENGTH * 0.78;
    this.root.add(wrap);

    const ferrule = new THREE.Mesh(
      new THREE.CylinderGeometry(TIP_RADIUS * 1.05, TIP_RADIUS * 1.05, 0.026, 16),
      new THREE.MeshStandardMaterial({ color: 0xf1ece0, roughness: 0.35 }),
    );
    ferrule.rotation.z = Math.PI / 2;
    ferrule.position.x = -0.015;
    this.root.add(ferrule);

    const tip = new THREE.Mesh(
      new THREE.CylinderGeometry(TIP_RADIUS, TIP_RADIUS, 0.006, 16),
      new THREE.MeshStandardMaterial({ color: 0x3f6f8a, roughness: 0.9 }),
    );
    tip.rotation.z = Math.PI / 2;
    tip.position.x = -0.0015;
    this.root.add(tip);
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }

  /**
   * Point the cue at the cue ball.
   *
   * `pull` is 0..1 and includes both the power dial and any live pull-back
   * gesture. `tip` is the contact point in ball radii, which shifts the cue
   * off-axis so aiming with side or draw looks like what it does.
   */
  aimAt(cueBallPosition: Vec2, angle: number, pull: number, tip: Vec2, elevation = 0.2): void {
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);

    // Offset the tip across the face of the ball, then step back along the aim.
    const rightX = dirY;
    const rightY = -dirX;
    const back = BALL_RADIUS + IDLE_GAP + pull * MAX_PULL;

    const px = cueBallPosition.x - dirX * back + rightX * tip.x * BALL_RADIUS;
    const py = cueBallPosition.y - dirY * back + rightY * tip.x * BALL_RADIUS;
    const height = BALL_RADIUS + tip.y * BALL_RADIUS;

    this.root.position.set(px, height, -py);
    this.root.rotation.set(0, 0, 0);
    // Yaw onto the aim line, then a little butt-up elevation for realism.
    this.root.rotateY(-Math.atan2(-dirY, dirX));
    this.root.rotateZ(elevation);
  }
}
