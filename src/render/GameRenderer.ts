import * as THREE from 'three';
import { BRAND } from '../config/brand';
import { predictAim } from '../game/AimPredictor';
import type { ShotSystem } from '../game/ShotSystem';
import { BALL_RADIUS } from '../physics/PhysicsConstants';
import type { Vec2 } from '../physics/Vec';
import { AimOverlay } from './AimOverlay';
import { buildBalls, syncBalls, type BallMesh } from './BallMeshes';
import { CueMesh } from './CueMesh';
import { buildEnvironment, setupLighting, type SceneLighting } from './Environment';
import { GameCamera } from './GameCamera';
import { buildTable } from './TableMesh';
import { renderToPlane } from './frame';

/**
 * Everything on screen.
 *
 * The renderer is a strict consumer: it reads simulation state and draws it,
 * and there is no path by which anything here can change a ball's position,
 * velocity or spin. That separation is what lets the physics be tested headless
 * and lets the same shot produce the same result at any frame rate.
 */

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly gameCamera: GameCamera;

  private readonly balls: BallMesh[];
  private readonly cue = new CueMesh();
  private readonly aim = new AimOverlay();
  private readonly clothSurface: THREE.Mesh;
  private readonly lighting: SceneLighting;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  /** Extra pull-back shown on the cue during a live power gesture. */
  livePull = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly system: ShotSystem,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene.background = new THREE.Color(BRAND.voidBlack);
    this.scene.fog = new THREE.Fog(BRAND.voidBlack, 3.2, 9);
    this.scene.environment = buildEnvironment(this.renderer);
    this.lighting = setupLighting(this.scene, system.world.table.length);

    const table = buildTable(system.world.table);
    this.scene.add(table.root);
    this.clothSurface = table.clothSurface;

    const built = buildBalls(system.world.balls);
    this.scene.add(built.group);
    this.balls = built.items;

    this.scene.add(this.cue.root);
    this.scene.add(this.aim.root);

    this.gameCamera = new GameCamera(system.world.table, this.aspect);
    this.resize();
  }

  private get aspect(): number {
    return this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
  }

  resize(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.gameCamera.setAspect(width / height);
  }

  /**
   * Rebuild the ball meshes. Only needed after a re-rack, since the physics
   * world is replaced wholesale.
   */
  rebuildBalls(): void {
    // Removing a mesh from the scene graph does not free its GPU buffers, so a
    // re-rack would leak a geometry, sixteen materials and a shadow texture
    // every time without this.
    for (const item of this.balls) {
      disposeMesh(item.mesh);
      disposeMesh(item.shadow);
    }
    const built = buildBalls(this.system.world.balls);
    this.scene.add(built.group);
    this.balls.length = 0;
    this.balls.push(...built.items);
    this.gameCamera.reset();
  }

  /** Draw one frame. `dt` is wall-clock seconds and never reaches the physics. */
  render(dt: number): void {
    const system = this.system;
    const cueBall = system.world.cueBall;
    const aiming = system.acceptsInput;

    if (cueBall && !cueBall.pocketed) {
      this.gameCamera.update(cueBall.position, system.aimAngle, !aiming, dt);

      if (aiming) {
        const pull = Math.max(system.power, this.livePull);
        this.cue.visible = true;
        this.cue.aimAt(cueBall.position, system.aimAngle, pull, system.tip);
        this.aim.update(cueBall.position, predictAim(system.world, system.aimAngle));
      } else {
        this.cue.visible = false;
        this.aim.visible = false;
      }
    }

    // The pendant lamp hangs between an overhead camera and the cloth, where
    // it reads as a black slab lying across the table. It belongs in the low
    // aiming view and nowhere else, so it goes away once the camera is above
    // it — which only ever happens during the pulled-back watch shot.
    const cameraHeight = this.gameCamera.camera.position.y;
    this.lighting.fixture.visible = cameraHeight < this.lighting.fixtureHeight - 0.1;

    syncBalls(this.balls);
    this.renderer.render(this.scene, this.gameCamera.camera);
  }

  /**
   * Convert a screen position to a point on the cloth.
   *
   * Used by tap-to-aim. Returns null when the ray misses the table, so a tap on
   * the surrounding room does nothing rather than aiming somewhere arbitrary.
   */
  pickTable(clientX: number, clientY: number): Vec2 | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.gameCamera.camera);
    const hits = this.raycaster.intersectObject(this.clothSurface, false);
    if (hits.length === 0) return null;
    const p = renderToPlane(hits[0].point);
    // Keep picks on the playing surface so a tap near the edge cannot aim into
    // a cushion and produce a meaningless angle.
    const hx = this.system.world.table.length / 2 - BALL_RADIUS;
    const hy = this.system.world.table.width / 2 - BALL_RADIUS;
    return {
      x: Math.max(-hx, Math.min(hx, p.x)),
      y: Math.max(-hy, Math.min(hy, p.y)),
    };
  }

  dispose(): void {
    for (const item of this.balls) {
      disposeMesh(item.mesh);
      disposeMesh(item.shadow);
    }
    this.balls.length = 0;
    this.renderer.dispose();
  }
}

/** Detach a mesh and free everything it owns on the GPU. */
function disposeMesh(mesh: THREE.Mesh): void {
  mesh.removeFromParent();
  mesh.geometry.dispose();
  for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
    const map = (material as THREE.MeshStandardMaterial).map;
    // Ball albedo maps are shared from a cache and must outlive any one mesh;
    // the per-mesh shadow texture is not, so only non-cached maps are freed.
    if (map && !isSharedTexture(map)) map.dispose();
    material.dispose();
  }
}

function isSharedTexture(texture: THREE.Texture): boolean {
  return texture.userData.shared === true;
}
