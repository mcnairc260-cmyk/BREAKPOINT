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

  await expect.poll(async () => page.locator('#status').textContent(), { timeout: 20000 }).toBe('AIM');
  const record = await page.evaluate(() => (window as Window & { lastBreakpointShot?: { finalBallStates?: unknown[] } }).lastBreakpointShot);
  expect(record).toBeTruthy();
  expect(record?.finalBallStates?.length).toBe(16);
  expect(errors).toEqual([]);
});
