import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createTable } from '../physics/TableGeometry';
import { GameCamera } from './GameCamera';

/**
 * Camera framing tests.
 *
 * These exist because the overview the camera pulls back to during a shot is
 * the only view that shows the player what their shot did, and a fixed pose
 * that frames the table on a desktop shows a patch of cloth on a phone —
 * three.js states `fov` vertically, so a tall narrow viewport collapses the
 * horizontal field. The pose is computed, so it can be checked as geometry
 * rather than by eye, and independently of frame timing.
 *
 * GameCamera touches no DOM, so this runs in the plain node test environment.
 */

const table = createTable();

/** Widest normalised-device extent of the table's four corners, as framed. */
function tableExtent(camera: THREE.PerspectiveCamera): { x: number; y: number } {
  camera.updateMatrixWorld();
  const viewProjection = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  );
  let x = 0;
  let y = 0;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const corner = new THREE.Vector3(
        (sx * table.length) / 2,
        0,
        (sy * table.width) / 2,
      ).applyMatrix4(viewProjection);
      x = Math.max(x, Math.abs(corner.x));
      y = Math.max(y, Math.abs(corner.y));
    }
  }
  return { x, y };
}

/** Settle the camera into its watching pose, independently of frame timing. */
function settleWatching(aspect: number): GameCamera {
  const camera = new GameCamera(table, aspect);
  camera.setAspect(aspect);
  const cueBall = { x: -table.length / 4, y: 0 };
  // A fixed number of steps drives the easing to convergence; deliberately not
  // a wall-clock wait, so the result cannot depend on machine speed.
  for (let i = 0; i < 600; i++) camera.update(cueBall, 0, true, 1 / 60);
  return camera;
}

const aspects: [string, number][] = [
  ['desktop 16:10', 1280 / 800],
  ['desktop 16:9', 1920 / 1080],
  ['landscape phone', 844 / 390],
  ['square', 1],
  ['iPhone 14 portrait', 390 / 844],
  ['iPhone Pro Max portrait', 430 / 932],
  ['very tall', 320 / 900],
  ['very wide', 2560 / 720],
];

describe('watch camera framing', () => {
  it.each(aspects)('fits the whole table at %s', (_name, aspect) => {
    const extent = tableExtent(settleWatching(aspect).camera);
    expect(extent.x).toBeLessThan(1);
    expect(extent.y).toBeLessThan(1);
  });

  it.each(aspects)('does not waste the screen at %s', (_name, aspect) => {
    const extent = tableExtent(settleWatching(aspect).camera);
    // At least one axis reasonably filled, or the table is a postage stamp.
    expect(Math.max(extent.x, extent.y)).toBeGreaterThan(0.45);
  });

  it('turns the table along the long axis of the screen', () => {
    // Portrait looks at the table end-on so its length runs up the screen;
    // landscape looks at it side-on.
    const portrait = settleWatching(390 / 844).camera.position;
    const landscape = settleWatching(1280 / 800).camera.position;
    expect(Math.abs(portrait.x)).toBeGreaterThan(Math.abs(portrait.z));
    expect(Math.abs(landscape.z)).toBeGreaterThan(Math.abs(landscape.x));
  });
});

describe('aiming camera', () => {
  it('stays above the rails and behind the cue ball at every angle', () => {
    const camera = new GameCamera(table, 390 / 844);
    const cueBall = { x: 0, y: 0 };
    for (const angle of [0, Math.PI / 2, Math.PI, -2.2, 2.9]) {
      for (let i = 0; i < 400; i++) camera.update(cueBall, angle, false, 1 / 60);
      // Never below the rail cap, or the camera clips through the table.
      expect(camera.camera.position.y).toBeGreaterThan(0.06);
      // Behind the ball along the aim line, in the physics frame.
      const behind =
        -Math.cos(angle) * (camera.camera.position.x - cueBall.x) +
        -Math.sin(angle) * (-camera.camera.position.z - cueBall.y);
      expect(behind).toBeGreaterThan(0);
    }
  });

  it('respects the elevation and zoom limits however hard they are pushed', () => {
    const camera = new GameCamera(table, 16 / 9);
    for (let i = 0; i < 200; i++) camera.adjustElevation(1);
    for (let i = 0; i < 200; i++) camera.adjustDistance(2);
    const high = { elevation: camera.elevation, distance: camera.distance };
    for (let i = 0; i < 400; i++) camera.adjustElevation(-1);
    for (let i = 0; i < 400; i++) camera.adjustDistance(0.5);

    expect(high.elevation).toBeLessThanOrEqual(1.25);
    expect(high.distance).toBeLessThanOrEqual(1.5);
    expect(camera.elevation).toBeGreaterThanOrEqual(0.16);
    expect(camera.distance).toBeGreaterThanOrEqual(0.45);
  });
});
