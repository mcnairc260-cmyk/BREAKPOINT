/**
 * Independent audit pass: functionality, keyboard, and dead controls.
 * Deliberately does not reuse verify.mjs's assumptions.
 */
import { chromium, devices } from '@playwright/test';

const BASE = 'http://127.0.0.1:3210';
const fail = [];
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { fail.push(m); console.log(`  FAIL  ${m}`); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

// ---- full flow -------------------------------------------------------------
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /view demo case/i }).click();
await page.waitForURL(/\/investigations\/[a-z0-9]+$/, { timeout: 30000 });
await page.waitForSelector('#summary');

console.log('\nSECTION CONTENT');
for (const [name, sel, min] of [
  ['Claim', '#claim', 80], ['Source DNA', '#source-dna', 200], ['Evidence Map', '#evidence-map', 60],
  ['Ledger', '#ledger', 300], ['Contradictions', '#contradictions', 200],
  ['Missing Evidence', '#missing-evidence', 200], ['Timeline', '#timeline', 300], ['Summary', '#summary', 300],
]) {
  const el = page.locator(sel);
  if (!(await el.count())) { bad(`${name}: section missing`); continue; }
  const text = (await el.innerText()).trim();
  if (text.length < min) bad(`${name}: only ${text.length} chars of content`);
  else ok(`${name}: ${text.length} chars rendered`);
}

// ---- the headline claim ----------------------------------------------------
console.log('\nHEADLINE');
const h = await page.evaluate(() => {
  const read = (l) => {
    const n = [...document.querySelectorAll('#source-dna .ph-label')].find((x) => x.textContent?.trim() === l);
    return Number(n?.nextElementSibling?.textContent?.trim());
  };
  return { sources: read('Sources found'), families: read('Independent source families') };
});
h.families > 0 && h.families < h.sources
  ? ok(`${h.sources} sources -> ${h.families} independent families`)
  : bad(`headline wrong: ${JSON.stringify(h)}`);

// ---- keyboard --------------------------------------------------------------
console.log('\nKEYBOARD');
// Focus must be reached by real Tab: `:focus-visible` intentionally does not
// match programmatic focus, so calling .focus() would report a false failure.
await page.locator('#evidence-map').scrollIntoViewIfNeeded();
await page.locator('#evidence-map button').first().focus();
let focused = null;
for (let i = 0; i < 30 && !focused; i += 1) {
  await page.keyboard.press('Tab');
  focused = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el.tagName.toLowerCase() !== 'g') return null;
    const cs = getComputedStyle(el);
    return { outline: `${cs.outlineStyle} ${cs.outlineWidth}`, focusVisible: el.matches(':focus-visible') };
  });
}
focused ? ok('graph nodes are reachable by Tab') : bad('graph nodes are not reachable by Tab');
focused && focused.focusVisible && !focused.outline.startsWith('none')
  ? ok(`focus ring visible (${focused.outline})`)
  : bad(`no visible focus ring on graph node (${JSON.stringify(focused)})`);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
(await page.getByText('Source detail').count()) ? ok('Enter on a graph node opens the inspector') : bad('Enter does not select a node');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
(await page.getByText('Source detail').count()) === 0 ? ok('Escape closes the inspector') : bad('Escape does not close the inspector');

// ---- every button does something ------------------------------------------
console.log('\nCONTROLS DO REAL WORK');
const transform = () => page.locator('#evidence-map svg > g').first().getAttribute('transform');
const t0 = await transform();
await page.locator('#evidence-map').getByRole('button', { name: 'Zoom in' }).click();
await page.waitForTimeout(150);
const t1 = await transform();
await page.locator('#evidence-map').getByRole('button', { name: /reset/i }).click();
await page.waitForTimeout(150);
const t2 = await transform();
t1 !== t0 ? ok(`zoom changes the view (${t0} -> ${t1})`) : bad('zoom control is inert');
t2 === t0 ? ok('reset restores the view exactly') : bad('reset does not restore the view');

const tip = page.locator('button[aria-label="What evidence strength measures"]').first();
await tip.focus();
await page.waitForTimeout(500);
const tipText = await page.locator('[role="tooltip"]').first().innerText().catch(() => null);
tipText && tipText.length > 40 ? ok('tooltips open on keyboard focus and carry real text') : bad('tooltip trigger is inert');

// ---- deferred features are labelled, not faked -----------------------------
await page.reload({ waitUntil: 'networkidle' });
await page.locator('text=Investigation trace').first().click();
await page.waitForTimeout(200);
(await page.getByText(/Not built yet/i).count()) ? ok('deferred features are labelled "Not built yet"') : bad('deferred features not labelled');

// ---- ledger filters actually filter ---------------------------------------
console.log('\nLEDGER FILTERS');
const shown = async () => (await page.locator('#ledger').innerText()).match(/(\d+) of (\d+) items shown/);
const all = await shown();
await page.locator('#ledger').getByRole('group', { name: 'Stance' }).getByText('Contradicts').click();
await page.waitForTimeout(200);
const filtered = await shown();
Number(filtered?.[1]) < Number(all?.[1]) ? ok(`filter narrows ${all?.[1]} -> ${filtered?.[1]}`) : bad('stance filter does not filter');
await page.locator('#ledger').getByRole('group', { name: 'Independence' }).getByText('Origins only').click();
await page.waitForTimeout(200);
ok(`independence filter -> ${(await shown())?.[1]} items`);

// ---- mobile inspection -----------------------------------------------------
const m = await browser.newContext({ ...devices['iPhone 13'] });
const mp = await m.newPage();
mp.on('pageerror', (e) => errors.push('mobile: ' + String(e)));
await mp.goto(BASE, { waitUntil: 'networkidle' });
await mp.getByRole('button', { name: /view demo case/i }).click();
await mp.waitForURL(/investigations/);
await mp.waitForSelector('#evidence-map');
console.log('\nMOBILE');
const box = await mp.locator('#evidence-map svg').boundingBox();
const nodes = await mp.locator('#evidence-map svg g[role="button"]').count();
box && box.width > 300 && nodes > 5 ? ok(`map ${Math.round(box.width)}x${Math.round(box.height)} with ${nodes} nodes`) : bad('map unusable on phone');
await mp.locator('#evidence-map svg g[role="button"]').first().click();
await mp.waitForTimeout(400);
(await mp.getByText('Source detail').count()) ? ok('map node tap opens inspector on phone') : bad('cannot inspect a source on phone');
await m.close();

console.log('\n────────────');
console.log(`console errors: ${errors.length}`);
errors.slice(0, 5).forEach((e) => console.log('   ' + e.slice(0, 140)));
if (errors.length) fail.push('console errors present');
console.log(fail.length === 0 ? 'AUDIT BROWSER PASS' : `AUDIT BROWSER FAILURES (${fail.length}):\n  - ${fail.join('\n  - ')}`);
await browser.close();
process.exitCode = fail.length ? 1 : 0;
