import { expect, test, type Page } from '@playwright/test';
import {
  bestTableExtent,
  boot,
  lastShot,
  pullAndShoot,
  screenPointForTable,
  settleShot,
} from './helpers';

/**
 * Phase 1 browser acceptance.
 *
 * These exercise the real built game through its real UI: nothing is stubbed,
 * and every assertion is about something a player would notice. They run once
 * per viewport project, so desktop, both portraits and landscape each report
 * separately.
 */

/** Fatal page errors and console errors, collected for the whole test. */
function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

test.describe('Phase 1 acceptance', () => {
  test('opens on the start presentation and clears it completely', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/');
    await page.waitForFunction(() => !!window.BREAKPOINT, null, { timeout: 60_000 });

    // The DPA-branded entry point, and the gesture that unlocks audio.
    const overlay = page.locator('#start-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.start-mark')).toHaveText('BREAKPOINT');
    await expect(overlay.locator('.start-eyebrow')).toHaveText('Dragon Phoenix Ascension');
    await expect(overlay.locator('.start-motto')).toHaveText('Fire Within. Power Unleashed.');

    // Comfortably above the 44pt touch guidance on every viewport.
    const action = (await page.locator('#start-action').boundingBox())!;
    expect(action.height).toBeGreaterThanOrEqual(44);

    await page.locator('#start-action').click();

    // Removed from the DOM, not merely transparent: a leftover overlay would
    // silently swallow every pointer event meant for the table.
    await expect(overlay).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('#hud-status')).toHaveText('Aim');
    expect(errors).toEqual([]);
  });

  test('renders the table and the HUD without a blank screen', async ({ page }) => {
    const errors = watchForErrors(page);
    await boot(page);

    await expect(page).toHaveTitle(/BREAKPOINT/);

    // Real geometry actually drawn — not just an HTML page that loaded.
    const render = await page.evaluate(() => {
      const r = window.BREAKPOINT!.renderer.renderer;
      return { calls: r.info.render.calls, triangles: r.info.render.triangles };
    });
    expect(render.calls).toBeGreaterThan(20);
    expect(render.triangles).toBeGreaterThan(1000);

    // The table, the full rack and the cue ball are all in the world.
    const world = await page.evaluate(() => {
      const s = window.BREAKPOINT!.system;
      return {
        balls: s.world.balls.length,
        cueBall: !!s.world.cueBall,
        rails: s.world.table.rails.length,
        pockets: s.world.table.pockets.length,
      };
    });
    expect(world.balls).toBe(16);
    expect(world.cueBall).toBe(true);
    expect(world.rails).toBe(6);
    expect(world.pockets).toBe(6);

    // HUD is present and readable.
    await expect(page.locator('#hud-status')).toBeVisible();
    await expect(page.locator('#hud-status')).toHaveText('Aim');
    await expect(page.locator('#hud-spin')).toBeVisible();
    await expect(page.locator('#hud-cue')).toBeVisible();
    await expect(page.locator('#hud-power-value')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('lays the interface out inside the viewport with usable touch targets', async ({
    page,
  }, testInfo) => {
    await boot(page);

    const layout = await page.evaluate(() => {
      const de = document.documentElement;
      const box = (selector: string) => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
      };
      return {
        scrollWidth: de.scrollWidth,
        clientWidth: de.clientWidth,
        scrollHeight: de.scrollHeight,
        clientHeight: de.clientHeight,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        spin: box('#hud-spin'),
        cue: box('#hud-cue'),
      };
    });

    // No overflow in either direction — the page must never scroll.
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.scrollHeight).toBeLessThanOrEqual(layout.clientHeight);

    for (const pad of [layout.spin, layout.cue]) {
      expect(pad.x).toBeGreaterThanOrEqual(0);
      expect(pad.y).toBeGreaterThanOrEqual(0);
      expect(pad.right).toBeLessThanOrEqual(layout.viewport.w + 0.5);
      expect(pad.bottom).toBeLessThanOrEqual(layout.viewport.h + 0.5);
    }

    // Apple's 44pt guidance for a touch target; desktop only needs to be clickable.
    const touch = testInfo.project.name.startsWith('mobile');
    const minimum = touch ? 44 : 24;
    expect(Math.min(layout.spin.w, layout.spin.h)).toBeGreaterThanOrEqual(minimum);
    expect(Math.min(layout.cue.w, layout.cue.h)).toBeGreaterThanOrEqual(minimum);

    // The controls must not sit on top of the cue ball.
    const cueBallOnScreen = await page.evaluate(() => {
      const ball = window.BREAKPOINT!.system.world.cueBall!;
      const camera = window.BREAKPOINT!.renderer.gameCamera.camera;
      camera.updateMatrixWorld();
      const e = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse).elements;
      const x = ball.position.x;
      const y = 0.028575;
      const z = -ball.position.y;
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      const ndcX = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
      const ndcY = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
      return {
        x: (ndcX * 0.5 + 0.5) * window.innerWidth,
        y: (-ndcY * 0.5 + 0.5) * window.innerHeight,
      };
    });
    const covers = (pad: typeof layout.spin) =>
      cueBallOnScreen.x >= pad.x &&
      cueBallOnScreen.x <= pad.right &&
      cueBallOnScreen.y >= pad.y &&
      cueBallOnScreen.y <= pad.bottom;
    expect(covers(layout.spin)).toBe(false);
    expect(covers(layout.cue)).toBe(false);
  });

  test('aims with the pointer and with a tap', async ({ page }) => {
    await boot(page);

    // Drag on the table rotates the aim.
    const before = await page.evaluate(() => window.BREAKPOINT!.system.aimAngle);
    const size = page.viewportSize()!;
    const cx = Math.round(size.width * 0.5);
    const cy = Math.round(size.height * 0.4);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(cx - i * 10, cy);
    await page.mouse.up();
    const dragged = await page.evaluate(() => window.BREAKPOINT!.system.aimAngle);
    expect(Math.abs(dragged - before)).toBeGreaterThan(0.05);

    // A tap on the cloth aims at that point. The target is projected from a
    // known table coordinate rather than guessed from the viewport, so the tap
    // cannot quietly land on the room behind the table and do nothing.
    const target = { x: 0.35, y: 0.32 };
    const onScreen = await screenPointForTable(page, target);
    await page.mouse.click(Math.round(onScreen.x), Math.round(onScreen.y));

    const aimed = await page.evaluate((t) => {
      const cue = window.BREAKPOINT!.system.world.cueBall!;
      return {
        angle: window.BREAKPOINT!.system.aimAngle,
        expected: Math.atan2(t.y - cue.position.y, t.x - cue.position.x),
      };
    }, target);
    // The cue now points at the tapped spot, not merely somewhere different.
    const delta = Math.abs(
      Math.atan2(Math.sin(aimed.angle - aimed.expected), Math.cos(aimed.angle - aimed.expected)),
    );
    expect(delta).toBeLessThan(0.02);
    expect(aimed.angle).not.toBe(dragged);
  });

  test('accepts touch input on the table', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('mobile'), 'touch projects only');
    await boot(page);

    // Projected from a real table coordinate, not a fraction of the viewport:
    // in landscape the upper third of the screen is the room behind the table,
    // and a tap there correctly does nothing.
    const target = { x: 0.3, y: -0.28 };
    const onScreen = await screenPointForTable(page, target);
    await page.touchscreen.tap(Math.round(onScreen.x), Math.round(onScreen.y));

    const aimed = await page.evaluate((t) => {
      const cue = window.BREAKPOINT!.system.world.cueBall!;
      return {
        angle: window.BREAKPOINT!.system.aimAngle,
        expected: Math.atan2(t.y - cue.position.y, t.x - cue.position.x),
      };
    }, target);
    const delta = Math.abs(
      Math.atan2(Math.sin(aimed.angle - aimed.expected), Math.cos(aimed.angle - aimed.expected)),
    );
    expect(delta).toBeLessThan(0.02);
  });

  test('sets cue-ball spin from the contact-point control, bounded to the miscue limit', async ({
    page,
  }) => {
    await boot(page);
    const pad = (await page.locator('#hud-spin').boundingBox())!;

    // Drag down-right: draw plus right English.
    await page.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2);
    await page.mouse.down();
    await page.mouse.move(pad.x + pad.width * 0.95, pad.y + pad.height * 0.95, { steps: 8 });
    await page.mouse.up();

    const tip = await page.evaluate(() => window.BREAKPOINT!.system.tip);
    expect(tip.x).toBeGreaterThan(0);
    expect(tip.y).toBeLessThan(0);
    // Clamped onto the miscue disc however far outside the pad the drag went.
    expect(Math.hypot(tip.x, tip.y)).toBeLessThanOrEqual(0.5 + 1e-9);
    await expect(page.locator('#hud-spin-readout')).toHaveText('draw + right');

    // And the opposite corner gives the mirror image.
    await page.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2);
    await page.mouse.down();
    await page.mouse.move(pad.x + pad.width * 0.05, pad.y + pad.height * 0.05, { steps: 8 });
    await page.mouse.up();
    const mirrored = await page.evaluate(() => window.BREAKPOINT!.system.tip);
    expect(mirrored.x).toBeLessThan(0);
    expect(mirrored.y).toBeGreaterThan(0);
    await expect(page.locator('#hud-spin-readout')).toHaveText('follow + left');
  });

  test('loads power with the pull-back gesture and cancels a nudge', async ({ page }) => {
    await boot(page);

    // A few pixels of accidental movement must not fire a shot.
    const shotsBefore = await page.evaluate(() => window.BREAKPOINT!.system.history.length);
    await pullAndShoot(page, 4);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.BREAKPOINT!.system.phase)).toBe('aiming');
    expect(await page.evaluate(() => window.BREAKPOINT!.system.history.length)).toBe(shotsBefore);

    // A real pull loads the meter proportionally.
    const pad = (await page.locator('#hud-cue').boundingBox())!;
    const x = pad.x + pad.width / 2;
    const y = pad.y + 14;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 60, { steps: 5 });
    const quarter = await page.locator('#hud-power-value').textContent();
    await page.mouse.move(x, y + 190, { steps: 8 });
    const full = await page.locator('#hud-power-value').textContent();
    await page.mouse.up();

    expect(parseInt(quarter!, 10)).toBeGreaterThan(0);
    expect(parseInt(full!, 10)).toBeGreaterThan(parseInt(quarter!, 10));
    expect(parseInt(full!, 10)).toBeLessThanOrEqual(100);
  });

  test('plays a complete shot: strike, watch, settle, shoot again', async ({ page }) => {
    const errors = watchForErrors(page);
    await boot(page);

    await page.evaluate(() => window.BREAKPOINT!.system.setAim(0));
    await pullAndShoot(page, 200);

    // WATCH: the shot is running and the controls are shut, visibly and in fact.
    await expect(page.locator('#hud-status')).toHaveText('Running');
    const running = await page.evaluate(() => {
      const s = window.BREAKPOINT!.system;
      const aim = s.aimAngle;
      s.setAim(aim + 1); // must be refused
      return {
        phase: s.phase,
        accepts: s.acceptsInput,
        aimUnchanged: s.aimAngle === aim,
        struckAgain: s.strike(),
        locked: document.querySelector('.hud')!.classList.contains('is-locked'),
      };
    });
    expect(running.phase).toBe('simulating');
    expect(running.accepts).toBe(false);
    expect(running.aimUnchanged).toBe(true);
    expect(running.struckAgain).toBe(false);
    expect(running.locked).toBe(true);

    // The whole table comes into frame while the balls run, on every viewport.
    const extent = await bestTableExtent(page);
    expect(extent.x).toBeLessThanOrEqual(1);
    expect(extent.y).toBeLessThanOrEqual(1);

    await settleShot(page);

    // AIM: everything stopped, nothing corrupted, controls open again.
    await expect(page.locator('#hud-status')).toHaveText('Aim');
    const settled = await page.evaluate(() => {
      const s = window.BREAKPOINT!.system;
      return {
        settled: s.world.balls.every((b) => b.pocketed || b.resting),
        finite: s.world.balls.every(
          (b) =>
            Number.isFinite(b.position.x) &&
            Number.isFinite(b.position.y) &&
            Number.isFinite(b.spin.z),
        ),
        corrupted: s.world.corrupted,
        accepts: s.acceptsInput,
        locked: document.querySelector('.hud')!.classList.contains('is-locked'),
        cueOnTable: !s.world.cueBall!.pocketed,
      };
    });
    expect(settled.settled).toBe(true);
    expect(settled.finite).toBe(true);
    expect(settled.corrupted).toBe(false);
    expect(settled.accepts).toBe(true);
    expect(settled.locked).toBe(false);
    expect(settled.cueOnTable).toBe(true);

    // A second shot starts immediately and also completes.
    await page.evaluate(() => {
      const s = window.BREAKPOINT!.system;
      s.setTip(0, -0.4);
      s.setPower(0.5);
      s.strike();
    });
    expect(await page.evaluate(() => window.BREAKPOINT!.system.phase)).toBe('simulating');
    await settleShot(page);
    expect(await page.evaluate(() => window.BREAKPOINT!.system.history.length)).toBe(2);

    expect(errors).toEqual([]);
  });

  test('produces a complete, referee-ready shot record', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const s = window.BREAKPOINT!.system;
      s.setAim(0.01);
      s.setPower(0.9);
      s.setTip(0.2, -0.1);
      s.strike();
    });
    await settleShot(page);

    const record = await lastShot(page);
    expect(record).not.toBeNull();

    // Inputs.
    expect(record!.preShotBalls).toHaveLength(16);
    expect(record!.postShotBalls).toHaveLength(16);
    expect(record!.cueBallPosition).toBeTruthy();
    expect(record!.aimAngle).toBeCloseTo(0.01, 6);
    expect(record!.power).toBeCloseTo(0.9, 6);
    expect(record!.cueContactPoint).toEqual({ x: 0.2, y: -0.1 });

    // The strike that was generated from them.
    expect(record!.impulse.speed).toBeGreaterThan(0);
    expect(record!.impulse.spin.z).toBeGreaterThan(0); // right English
    expect(record!.impulse.spin.y).toBeLessThan(0); // draw

    // What happened.
    expect(record!.events.length).toBeGreaterThan(0);
    expect(record!.ballContacts.length).toBeGreaterThan(0);
    expect(record!.railContacts.length).toBeGreaterThan(0);
    expect(Array.isArray(record!.jawContacts)).toBe(true);
    expect(record!.firstObjectBallContact).not.toBeNull();
    expect(record!.firstContactEventIndex).not.toBeNull();
    expect(typeof record!.scratch).toBe('boolean');
    expect(record!.ballsPocketed.length).toBe(record!.pocketsUsed.length);
    expect(record!.durationSeconds).toBeGreaterThan(0);
    expect(record!.steps).toBeGreaterThan(0);

    // The flags a rules engine will actually read.
    for (const contact of record!.railContacts) {
      expect(typeof contact.ball).toBe('number');
      expect(typeof contact.id).toBe('string');
      expect(typeof contact.afterFirstContact).toBe('boolean');
      expect(contact.impulse).toBeGreaterThan(0);
    }
    expect(record!.railContacts.some((c) => c.afterFirstContact)).toBe(true);
    expect(record!.events[record!.firstContactEventIndex!].type).toBe('ball-ball');
  });

  test('survives an orientation change mid-shot', async ({ page }) => {
    await boot(page);
    const original = page.viewportSize()!;

    await page.evaluate(() => window.BREAKPOINT!.system.setAim(0));
    await pullAndShoot(page, 180);
    expect(await page.evaluate(() => window.BREAKPOINT!.system.phase)).toBe('simulating');

    await page.setViewportSize({ width: original.height, height: original.width });
    await page.waitForTimeout(400);

    const rotated = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      calls: window.BREAKPOINT!.renderer.renderer.info.render.calls,
      phase: window.BREAKPOINT!.system.phase,
    }));
    expect(rotated.overflow).toBe(true);
    expect(rotated.calls).toBeGreaterThan(20);

    // The whole table still comes into frame after the rotation.
    const extent = await bestTableExtent(page);
    expect(extent.x).toBeLessThanOrEqual(1);
    expect(extent.y).toBeLessThanOrEqual(1);

    await page.setViewportSize(original);
    await settleShot(page);
    expect(await page.evaluate(() => window.BREAKPOINT!.system.acceptsInput)).toBe(true);
  });
});
