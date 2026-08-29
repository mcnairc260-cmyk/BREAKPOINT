import { expect, test } from '@playwright/test';

test('Phase 1 renders and accepts a complete mouse shot', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page).toHaveTitle('BREAKPOINT');
  await expect(page.locator('#game')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('AIM');
  await expect(page.locator('#spin-pad')).toBeVisible();

  const canvas = page.locator('#game');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width * 0.5;
  const y = box!.y + box!.height * 0.45;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 35, y + 8, { steps: 3 });
  await page.mouse.move(x + 38, y + 145, { steps: 6 });
  await expect(page.locator('#power-label')).not.toHaveText('0%');
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('WATCH');

  // Advance the same authoritative 120 Hz simulation without waiting wall-clock time.
  // Rendering still gets the next frame and must transition WATCH -> AIM itself.
  const settled = await page.evaluate(() => {
    const w = (window as Window & { breakpoint?: { world: { isMoving(): boolean; fixedStep(): void } } }).breakpoint!.world;
    let steps = 0;
    while (w.isMoving() && steps < 120 * 30) { w.fixedStep(); steps += 1; }
    return { moving: w.isMoving(), steps };
  });
  expect(settled.moving).toBe(false);
  expect(settled.steps).toBeLessThan(120 * 30);
  await expect(page.locator('#status')).toHaveText('AIM', { timeout: 3000 });

  const record = await page.evaluate(() => (window as Window & { lastBreakpointShot?: { finalBallStates?: unknown[] } }).lastBreakpointShot);
  expect(record).toBeTruthy();
  expect(record?.finalBallStates?.length).toBe(16);
  expect(errors).toEqual([]);
});
