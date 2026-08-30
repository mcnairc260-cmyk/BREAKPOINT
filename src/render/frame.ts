import * as THREE from 'three';
import type { Vec2, Vec3 } from '../physics/Vec';

/**
 * The one place the physics frame is converted to the render frame.
 *
 * Physics works in a right-handed frame with the cloth as z = 0 and +z up,
 * because that is the convention every billiards reference uses and it keeps
 * the spin derivations readable. three.js is y-up. The mapping is
 *
 *     three = ( x,  z, -y )
 *
 * which preserves handedness (x̂ → X̂, ŷ → −Ẑ, ẑ → Ŷ, and X̂ × −Ẑ = Ŷ), so a
 * rotation in physics is the *same* rotation on screen. Getting this wrong
 * would mirror every spin — English would visibly curve the wrong way — which
 * is exactly the kind of "faked spin" this project is not allowed to ship.
 *
 * Because the map is a proper rotation, quaternions convert by putting their
 * vector part through the same transform.
 */

export function toRender(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.z, -v.y);
}

export function planeToRender(v: Vec2, height = 0): THREE.Vector3 {
  return new THREE.Vector3(v.x, height, -v.y);
}

export function setFromPlane(out: THREE.Vector3, v: Vec2, height = 0): THREE.Vector3 {
  return out.set(v.x, height, -v.y);
}

/** Physics orientation quaternion (x, y, z, w) → render quaternion. */
export function setFromPhysicsQuaternion(
  out: THREE.Quaternion,
  q: readonly [number, number, number, number],
): THREE.Quaternion {
  return out.set(q[0], q[2], -q[1], q[3]);
}

/** Render-frame point on the cloth plane → physics table coordinates. */
export function renderToPlane(p: THREE.Vector3): Vec2 {
  return { x: p.x, y: -p.z };
}
