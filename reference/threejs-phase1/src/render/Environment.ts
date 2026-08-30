import * as THREE from 'three';
import { BRAND, TABLE } from '../config/brand';

/**
 * Lighting and reflections.
 *
 * The look is a single low pendant lamp over a dark room, which is what a real
 * table under tournament lighting looks like and what the brand's dark-first
 * design language asks for. Three pieces do the work:
 *
 *  • a shadow-casting spot light standing in for the lamp, which is what makes
 *    the balls sit *on* the cloth instead of floating above it;
 *  • two dim rim lights so the rails and the far side of each ball are not
 *    solid black;
 *  • a generated environment map, without which polished phenolic balls have
 *    no highlight to catch and read as matte plastic.
 */

export interface SceneLighting {
  lamp: THREE.SpotLight;
  /**
   * The visible fixture — the glowing panel and its shade.
   *
   * Grouped and handed back because it hangs between an overhead camera and
   * the table: from the pulled-back view it is a black slab across the middle
   * of the cloth. The renderer hides it whenever the camera climbs above it.
   */
  fixture: THREE.Group;
  /** Height of the fixture, so the renderer knows when it is in the way. */
  fixtureHeight: number;
}

const FIXTURE_HEIGHT = 1.52;

export function setupLighting(scene: THREE.Scene, tableLength: number): SceneLighting {
  scene.add(new THREE.AmbientLight(0xdfe9ff, 0.09));

  // Ground colour is the cloth, not black: the underside of a ball on a real
  // table is lit by light bouncing off the baize, and without that term every
  // ball has a dead, slightly muddy lower hemisphere.
  const hemi = new THREE.HemisphereLight(0x9fd4e8, TABLE.cloth, 0.3);
  hemi.position.set(0, 2, 0);
  scene.add(hemi);

  const lamp = new THREE.SpotLight(0xfff2e0, 17, 0, Math.PI / 2.7, 0.65, 1.5);
  lamp.position.set(0, 1.5, 0);
  lamp.target.position.set(0, 0, 0);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(2048, 2048);
  lamp.shadow.camera.near = 0.4;
  lamp.shadow.camera.far = 4;
  lamp.shadow.bias = -0.0006;
  lamp.shadow.normalBias = 0.012;
  scene.add(lamp);
  scene.add(lamp.target);

  // The visible fixture. Emissive only — it does not light anything itself.
  const fixture = new THREE.Group();
  const lampMesh = new THREE.Mesh(
    new THREE.BoxGeometry(tableLength * 0.62, 0.06, 0.34),
    new THREE.MeshStandardMaterial({
      color: 0x0b0b10,
      emissive: 0xfff0dc,
      emissiveIntensity: 2.4,
      roughness: 0.4,
    }),
  );
  lampMesh.position.set(0, FIXTURE_HEIGHT, 0);
  fixture.add(lampMesh);

  const shade = new THREE.Mesh(
    new THREE.BoxGeometry(tableLength * 0.66, 0.12, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x101018, roughness: 0.5, metalness: 0.3 }),
  );
  shade.position.set(0, FIXTURE_HEIGHT + 0.08, 0);
  fixture.add(shade);
  scene.add(fixture);

  // Warm and cool rim lights. Kept very low and placed symmetrically about the
  // long axis: asymmetric rims make one cushion glow while the opposite one
  // reads as broken geometry rather than as lighting.
  const warm = new THREE.DirectionalLight(BRAND.emberOrange, 0.13);
  warm.position.set(-2.6, 1.3, 1.6);
  scene.add(warm);

  const cool = new THREE.DirectionalLight(BRAND.signalCyan, 0.11);
  cool.position.set(2.6, 1.3, -1.6);
  scene.add(cool);

  return { lamp, fixture, fixtureHeight: FIXTURE_HEIGHT };
}

/**
 * A tiny scene rendered into an environment map.
 *
 * `RoomEnvironment` from three's examples is a bright white studio and would
 * wash the table out. This is the same idea at a fraction of the cost: a dark
 * shell with one bright overhead panel and two dim side panels, which gives the
 * balls a single crisp highlight and a soft gradient — the difference between
 * "polished resin" and "grey sphere".
 */
export function buildEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const env = new THREE.Scene();

  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(10, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0x0c0c12, side: THREE.BackSide }),
  );
  env.add(shell);

  const panel = (w: number, h: number, color: number, intensity: number, place: THREE.Vector3) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity) }),
    );
    mesh.position.copy(place);
    mesh.lookAt(0, 0, 0);
    env.add(mesh);
  };

  panel(4.2, 1.6, 0xfff4e6, 3.4, new THREE.Vector3(0, 4.6, 0));
  panel(3.0, 2.2, 0x2a3f52, 0.7, new THREE.Vector3(-4.6, 0.6, 0));
  panel(3.0, 2.2, 0x243a48, 0.6, new THREE.Vector3(4.6, 0.6, 0));
  panel(3.4, 1.4, 0x1a2430, 0.5, new THREE.Vector3(0, 0.4, -4.6));

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(env, 0.04);
  pmrem.dispose();
  shell.geometry.dispose();
  return target.texture;
}
