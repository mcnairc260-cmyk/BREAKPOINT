import type { Page } from '@playwright/test';
import type { ShotRecord } from '../src/game/ShotRecord';
import type { ShotSystem } from '../src/game/ShotSystem';
import type { GameRenderer } from '../src/render/GameRenderer';
import type { Hud } from '../src/ui/Hud';
import type { StartOverlay } from '../src/ui/StartOverlay';

/** The debug bridge `main.ts` publishes. Read-only as far as these tests care. */
export interface BreakpointBridge {
  system: ShotSystem;
  renderer: GameRenderer;
  hud: Hud;
  startOverlay: StartOverlay;
}

declare global {
  interface Window {
    BREAKPOINT?: BreakpointBridge;
  }
}

/**
 * Wait for the bundle to boot, then start the game the way a player does.
 *
 * The start presentation is a real gate — it is what unlocks audio — so the
 * tests go through it rather than around it, and `startOverlay` is asserted
 * gone before anything touches the table.
 */
export async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => !!window.BREAKPOINT, null, { timeout: 60_000 });
  await page.locator('#start-action').click();
  await page.waitForFunction(() => !document.querySelector('#start-overlay'), null, {
    timeout: 15_000,
  });
  // One rendered frame, so the first draw has happened before anything is asserted.
  await page.waitForFunction(
    () => (window.BREAKPOINT?.renderer.renderer.info.render.calls ?? 0) > 0,
    null,
    { timeout: 60_000 },
  );
}

/**
 * Run the current shot to completion without waiting out wall-clock time.
 *
 * This drives the real game loop — `ShotSystem.update` with a clamped frame
 * delta, exactly what `requestAnimationFrame` feeds it — rather than stepping
 * the physics world behind the shot system's back. So the phase transition,
 * the settle detection and the shot record are all produced by the same code
 * that runs in front of a player; only the waiting is skipped.
 *
 * Without this a single shot takes eight seconds of real time per viewport
 * under software rendering, and the suite spends most of its life asleep.
 */
export async function settleShot(page: Page): Promise<void> {
  await page.evaluate(() => {
    const system = window.BREAKPOINT!.system;
    // The driver clamps a frame to 0.25 s, so this is 60 s of table time.
    for (let i = 0; i < 240 && system.phase === 'simulating'; i++) system.update(0.25);
  });
  await page.waitForFunction(() => window.BREAKPOINT!.system.phase === 'aiming', null, {
    timeout: 30_000,
  });
}

/** Read the most recent shot record out of the page. */
export async function lastShot(page: Page): Promise<ShotRecord | null> {
  return page.evaluate(() => {
    const history = window.BREAKPOINT!.system.history;
    return history.length > 0 ? JSON.parse(JSON.stringify(history[history.length - 1])) : null;
  });
}

/** Pull the cue back by `pixels` on the cue pad and release, firing a shot. */
export async function pullAndShoot(page: Page, pixels: number): Promise<void> {
  const pad = await page.locator('#hud-cue').boundingBox();
  if (!pad) throw new Error('cue pad not found');
  const x = pad.x + pad.width / 2;
  const y = pad.y + 14;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + pixels, { steps: 10 });
  await page.mouse.up();
}

/**
 * Screen position of a point on the cloth, in CSS pixels.
 *
 * Lets a test tap somewhere it *knows* is on the table, instead of guessing a
 * fraction of the viewport and silently landing on the room behind it.
 */
export async function screenPointForTable(
  page: Page,
  point: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  return page.evaluate((p) => {
    const camera = window.BREAKPOINT!.renderer.gameCamera.camera;
    camera.updateMatrixWorld();
    const e = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse).elements;
    const x = p.x;
    const z = -p.y;
    const w = e[3] * x + e[11] * z + e[15];
    const ndcX = (e[0] * x + e[8] * z + e[12]) / w;
    const ndcY = (e[1] * x + e[9] * z + e[13]) / w;
    return {
      x: (ndcX * 0.5 + 0.5) * window.innerWidth,
      y: (-ndcY * 0.5 + 0.5) * window.innerHeight,
    };
  }, point);
}

/**
 * The tightest framing the camera reaches while the shot is running.
 *
 * The camera eases between the aiming pose and the pulled-back overview, so a
 * single sample measures whatever the transition happened to be doing at that
 * instant rather than the pose itself. The pose maths is covered exactly by the
 * unit tests; what this checks is the user-visible property, that the whole
 * table does come into frame during the shot.
 */
export async function bestTableExtent(
  page: Page,
  samples = 14,
  gapMs = 300,
): Promise<{ x: number; y: number }> {
  let best = { x: Infinity, y: Infinity };
  for (let i = 0; i < samples; i++) {
    const extent = await tableExtent(page);
    if (Math.max(extent.x, extent.y) < Math.max(best.x, best.y)) best = extent;
    if (best.x <= 1 && best.y <= 1) break;
    await page.waitForTimeout(gapMs);
  }
  return best;
}

/**
 * Widest normalised-device extent of the table's four corners.
 *
 * A value of 1 is the edge of the frame, so <= 1 on both axes means the whole
 * table is visible. A corner behind the camera reports as far outside.
 */
export async function tableExtent(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const table = window.BREAKPOINT!.system.world.table;
    const camera = window.BREAKPOINT!.renderer.gameCamera.camera;
    camera.updateMatrixWorld();
    const e = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse).elements;
    const project = (x: number, z: number) => {
      const w = e[3] * x + e[11] * z + e[15];
      if (w <= 0) return { x: 99, y: 99 };
      return { x: (e[0] * x + e[8] * z + e[12]) / w, y: (e[1] * x + e[9] * z + e[13]) / w };
    };
    const hx = table.length / 2;
    const hy = table.width / 2;
    const corners = [project(-hx, -hy), project(hx, -hy), project(hx, hy), project(-hx, hy)];
    return {
      x: Math.max(...corners.map((c) => Math.abs(c.x))),
      y: Math.max(...corners.map((c) => Math.abs(c.y))),
    };
  });
}
