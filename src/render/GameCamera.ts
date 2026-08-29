import * as THREE from 'three';
import { BALL_RADIUS } from '../physics/PhysicsConstants';
import type { TableGeometry } from '../physics/TableGeometry';
import type { Vec2 } from '../physics/Vec';
import { clamp } from '../physics/Vec';

/**
 * The camera.
 *
 * Two framings, smoothly blended:
 *
 *  • AIMING — behind the cue ball, looking down the shot. This is what makes
 *    aiming legible: the aim line runs away from the viewer, so a small change
 *    in angle is a visible change on screen. A top-down view would make aiming
 *    precise but flat, and a fixed 3/4 view makes the player do the mental
 *    rotation on every shot.
 *
 *  • WATCHING — pulled up and back to take in the whole table while the balls
 *    run, then eased back down for the next shot. That transition is doing the
 *    cinematic work; nothing else needs to move.
 *
 * Elevation is a player control because the right height genuinely differs
 * between a long straight pot (low, down the line) and a positional shot where
 * you need to see the whole table (high).
 */

/** Vertical field of view, in degrees. */
const FIELD_OF_VIEW = 46;
/** Elevation the overview camera looks down from, in radians (about 58°). */
const WATCH_ELEVATION = 1.01;

const MIN_ELEVATION = 0.16;
const MAX_ELEVATION = 1.25;
const MIN_DISTANCE = 0.45;
const MAX_DISTANCE = 1.5;

export class GameCamera {
  readonly camera: THREE.PerspectiveCamera;

  /** Elevation of the aiming camera, in radians above the cloth. */
  elevation = 0.52;
  /** Distance behind the cue ball, in metres. */
  distance = 1.02;
  /** 0 = fully aiming, 1 = fully pulled back to watch. */
  private blend = 0;

  private readonly position = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private initialised = false;

  private aspect: number;

  constructor(
    private readonly table: TableGeometry,
    aspect: number,
  ) {
    this.aspect = aspect;
    this.camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, aspect, 0.02, 60);
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  adjustElevation(delta: number): void {
    this.elevation = clamp(this.elevation + delta, MIN_ELEVATION, MAX_ELEVATION);
  }

  adjustDistance(factor: number): void {
    this.distance = clamp(this.distance * factor, MIN_DISTANCE, MAX_DISTANCE);
  }

  /**
   * Advance the camera one frame.
   *
   * `watching` drives the blend rather than setting the pose directly, so the
   * camera keeps easing even when the shot ends mid-transition — it never snaps.
   */
  update(cueBall: Vec2, aimAngle: number, watching: boolean, dt: number): void {
    const targetBlend = watching ? 1 : 0;
    // Frame-rate independent easing; the camera is presentation only, so unlike
    // the simulation it is free to depend on wall-clock time.
    const k = 1 - Math.exp(-dt * (watching ? 2.4 : 3.6));
    this.blend += (targetBlend - this.blend) * k;

    const aimPose = this.aimingPose(cueBall, aimAngle);
    const watchPose = this.watchingPose();

    const desiredPos = aimPose.position.lerp(watchPose.position, this.blend);
    const desiredTarget = aimPose.target.lerp(watchPose.target, this.blend);

    if (!this.initialised) {
      this.position.copy(desiredPos);
      this.target.copy(desiredTarget);
      this.initialised = true;
    } else {
      const follow = 1 - Math.exp(-dt * 9);
      this.position.lerp(desiredPos, follow);
      this.target.lerp(desiredTarget, follow);
    }

    this.camera.position.copy(this.position);
    this.camera.lookAt(this.target);
  }

  /** Snap to the current pose — used on the first frame and after a reset. */
  reset(): void {
    this.initialised = false;
    this.blend = 0;
  }

  private aimingPose(cueBall: Vec2, aimAngle: number) {
    const dirX = Math.cos(aimAngle);
    const dirY = Math.sin(aimAngle);
    const back = this.distance * Math.cos(this.elevation);
    const up = this.distance * Math.sin(this.elevation);

    const position = new THREE.Vector3(
      cueBall.x - dirX * back,
      BALL_RADIUS + up,
      -(cueBall.y - dirY * back),
    );
    // Look a little ahead of the ball rather than at it, so the aim line has
    // room on screen instead of running off the bottom edge.
    const lookAhead = 0.42;
    const target = new THREE.Vector3(
      cueBall.x + dirX * lookAhead,
      BALL_RADIUS,
      -(cueBall.y + dirY * lookAhead),
    );

    // Never let the camera drop below the rail cap or clip through the table.
    position.y = Math.max(position.y, 0.14);
    return { position, target };
  }

  /**
   * The overview the camera pulls back to while the balls run.
   *
   * The framing is computed rather than fixed, because a fixed one does not
   * survive a phone. three.js expresses `fov` vertically, so on a tall narrow
   * screen the horizontal field collapses: a distance chosen to fit the table
   * in landscape shows only a patch of cloth in portrait, and the player cannot
   * see the shot they just took — which is the entire purpose of this pose.
   *
   * Two things fix it. The table is turned to lie along the long axis of the
   * screen, so a portrait phone views it end-on and a landscape screen views it
   * side-on; and the distance is solved from both the horizontal and the
   * vertical field, so whichever is tighter is the one that decides.
   */
  private watchingPose() {
    const portrait = this.aspect < 1;
    // Half-extents as they will appear on screen. The margin is deliberately
    // wider than the rail: a fit that lands flush against the frame edge has
    // the far corners clipping in and out as the camera eases into place.
    const margin = 0.26;
    const halfAcross = (portrait ? this.table.width : this.table.length) / 2 + margin;
    const halfUp = (portrait ? this.table.length : this.table.width) / 2 + margin;

    const tanHalfFov = Math.tan((this.camera.fov * Math.PI) / 360);
    // The near edge of the table sits this much closer to the camera than the
    // centre does, and perspective makes it the widest thing on screen. Fitting
    // to the centre distance alone leaves the near corners hanging off the
    // sides, so the constraint is written at the near edge and the offset added
    // back to give the distance to the centre.
    const nearEdge = halfUp * Math.cos(WATCH_ELEVATION);
    const forWidth = halfAcross / (tanHalfFov * this.aspect) + nearEdge;
    // The table lies flat, so its extent up the screen is foreshortened by the
    // viewing elevation; dividing by the sine is what stops a low camera from
    // cropping the far end.
    const forHeight = halfUp / (tanHalfFov * Math.sin(WATCH_ELEVATION)) + nearEdge;
    const distance = Math.max(forWidth, forHeight);

    const horizontal = distance * Math.cos(WATCH_ELEVATION);
    const height = distance * Math.sin(WATCH_ELEVATION);

    return {
      position: portrait
        ? new THREE.Vector3(-horizontal, height, 0)
        : new THREE.Vector3(0, height, horizontal),
      target: new THREE.Vector3(0, 0, 0),
    };
  }
}
