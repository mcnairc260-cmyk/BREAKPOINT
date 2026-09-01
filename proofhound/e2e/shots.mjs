import { chromium, devices } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const BASE = 'http://127.0.0.1:3210';
const OUT = '/tmp/proofhound-sections';
await mkdir(OUT, { recursive: true });
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
await p.goto(BASE, { waitUntil: 'networkidle' });
await p.getByRole('button', { name: /view demo case/i }).click();
await p.waitForURL(/investigations/);
await p.waitForSelector('#source-dna');
await p.waitForTimeout(500);

await p.screenshot({ path: `${OUT}/a-top.png` });
for (const [name, sel] of [['b-dna', '#source-dna'], ['c-map', '#evidence-map'], ['d-ledger', '#ledger'], ['e-contradictions', '#contradictions'], ['f-missing', '#missing-evidence'], ['g-timeline', '#timeline'], ['h-summary', '#summary']]) {
  await p.locator(sel).screenshot({ path: `${OUT}/${name}.png` });
}
// Score breakdown open + a selected source in the rail.
await p.getByRole('button', { name: /show how this score was reached/i }).click();
await p.locator('#source-dna button').nth(1).click();
await p.waitForTimeout(300);
await p.locator('aside').screenshot({ path: `${OUT}/i-rail.png` });
await ctx.close();

const m = await b.newContext({ ...devices['iPhone 13'] });
const mp = await m.newPage();
await mp.goto(BASE, { waitUntil: 'networkidle' });
await mp.getByRole('button', { name: /view demo case/i }).click();
await mp.waitForURL(/investigations/);
await mp.waitForSelector('#source-dna');
await mp.waitForTimeout(400);
await mp.screenshot({ path: `${OUT}/m1-top.png` });
await mp.locator('#source-dna').scrollIntoViewIfNeeded();
await mp.screenshot({ path: `${OUT}/m2-dna.png` });
await mp.locator('#evidence-map').scrollIntoViewIfNeeded();
await mp.waitForTimeout(200);
await mp.screenshot({ path: `${OUT}/m3-map.png` });
await mp.locator('#ledger').scrollIntoViewIfNeeded();
await mp.waitForTimeout(200);
await mp.screenshot({ path: `${OUT}/m4-ledger.png` });
await m.close();
await b.close();
console.log('sections captured');
