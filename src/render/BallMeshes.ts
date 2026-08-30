import * as THREE from 'three';
import type { BallBody } from '../physics/BallBody';
import { BALL_RADIUS } from '../physics/PhysicsConstants';
import { ballTexture } from './BallTextures';
import { setFromPhysicsQuaternion, setFromPlane } from './frame';

/**
 * The balls.
 *
 * One shared sphere geometry, one material per ball. Materials are polished
 * phenolic: near-zero roughness with a clear-coat, so the environment map lands
 * as a tight highlight that travels across the surface as the ball rolls — the
 * single most convincing cue that a ball is actually rotating rather than
 * sliding along as a decal.
 *
 * The orientation applied here is the quaternion the physics integrated from
 * its own angular velocity. Nothing about the visible spin is invented.
 */

export interface BallMesh {
  ball: BallBody;
  mesh: THREE.Mesh;
  shadow: THREE.Mesh;
}

const SEGMENTS = 40;

export function buildBalls(balls: readonly BallBody[]): { group: THREE.Group; items: BallMesh[] } {
  const group = new THREE.Group();
  const geometry = new THREE.SphereGeometry(BALL_RADIUS, SEGMENTS, SEGMENTS / 2);

  // A soft contact blob, kept deliberately small. It has to be: the quad lies
  // on the cloth and extends towards the camera, so anything wider than the
  // ball paints over the ball's own lower half from a low aiming camera. At
  // just under one ball width it only ever darkens cloth.
  const shadowTexture = contactShadowTexture();
  const shadowGeometry = new THREE.PlaneGeometry(BALL_RADIUS * 1.9, BALL_RADIUS * 1.9);

  const items: BallMesh[] = [];
  for (const ball of balls) {
    const material = new THREE.MeshPhysicalMaterial({
      map: ballTexture(ball.number),
      roughness: 0.055,
      metalness: 0.0,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      envMapIntensity: 1.25,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    const shadow = new THREE.Mesh(
      shadowGeometry,
      new THREE.MeshBasicMaterial({
        map: shadowTexture,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
      }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.renderOrder = 1;
    group.add(shadow);

    items.push({ ball, mesh, shadow });
  }

  return { group, items };
}

/** Copy simulation state onto the meshes. Called once per rendered frame. */
export function syncBalls(items: readonly BallMesh[]): void {
  for (const item of items) {
    const visible = !item.ball.pocketed;
    item.mesh.visible = visible;
    item.shadow.visible = visible;
    if (!visible) continue;

    setFromPlane(item.mesh.position, item.ball.position, BALL_RADIUS);
    setFromPhysicsQuaternion(item.mesh.quaternion, item.ball.orientation);
    setFromPlane(item.shadow.position, item.ball.position, 0.0009);
  }
}

function contactShadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0,0,0,0.85)');
  gradient.addColorStop(0.45, 'rgba(0,0,0,0.35)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
