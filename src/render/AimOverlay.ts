import * as THREE from 'three';
import { BRAND } from '../config/brand';
import { BALL_RADIUS } from '../physics/PhysicsConstants';
import type { AimPrediction } from '../game/AimPredictor';
import type { Vec2 } from '../physics/Vec';

/**
 * The aiming overlay: the cue ball's line, the ghost ball, the object ball's
 * departure line and the cue ball's tangent line.
 *
 * Drawn at the cloth surface with depth testing off so it reads clearly over
 * the table without z-fighting against it. The ghost ball is a wireframe rather
 * than a solid so it never gets mistaken for a real ball.
 */

const LINE_HEIGHT = BALL_RADIUS;

export class AimOverlay {
  readonly root = new THREE.Group();

  private readonly cueLine: THREE.Line;
  private readonly targetLine: THREE.Line;
  private readonly tangentLine: THREE.Line;
  private readonly ghost: THREE.Mesh;

  constructor() {
    this.cueLine = makeLine(BRAND.ghostWhite, 0.85);
    this.targetLine = makeLine(BRAND.emberOrange, 0.9);
    this.tangentLine = makeLine(BRAND.signalCyan, 0.55);

    this.ghost = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS, 20, 12),
      new THREE.MeshBasicMaterial({
        color: BRAND.ghostWhite,
        wireframe: true,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      }),
    );

    this.root.add(this.cueLine, this.targetLine, this.tangentLine, this.ghost);
    this.root.renderOrder = 10;
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }

  update(cueBallPosition: Vec2, prediction: AimPrediction | null): void {
    if (!prediction) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    setLine(this.cueLine, cueBallPosition, prediction.end);

    if (prediction.ghost && prediction.target && prediction.targetDirection) {
      this.ghost.visible = true;
      this.ghost.position.set(prediction.ghost.x, LINE_HEIGHT, -prediction.ghost.y);

      // Where the object ball is headed: along the line of centres.
      const t = prediction.targetDirection;
      const from = prediction.target.position;
      this.targetLine.visible = true;
      setLine(this.targetLine, from, { x: from.x + t.x * 0.42, y: from.y + t.y * 0.42 });

      // And the cue ball's tangent — the 90-degree line off a stun hit.
      const c = prediction.cueTangent!;
      this.tangentLine.visible = true;
      setLine(this.tangentLine, prediction.ghost, {
        x: prediction.ghost.x + c.x * 0.26,
        y: prediction.ghost.y + c.y * 0.26,
      });
    } else {
      this.ghost.visible = false;
      this.targetLine.visible = false;
      this.tangentLine.visible = false;
    }
  }
}

function makeLine(color: number, opacity: number): THREE.Line {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
  });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 10;
  return line;
}

function setLine(line: THREE.Line, from: Vec2, to: Vec2): void {
  const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
  attr.setXYZ(0, from.x, LINE_HEIGHT, -from.y);
  attr.setXYZ(1, to.x, LINE_HEIGHT, -to.y);
  attr.needsUpdate = true;
  line.geometry.computeBoundingSphere();
}
