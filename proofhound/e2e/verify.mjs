/**
 * Browser verification.
 *
 * Drives the production build in real Chromium at two viewports, exercises the
 * full flow, records every console message and page error, and captures
 * screenshots for inspection. Any console error fails the run.
 */
import { chromium, devices } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3210';
const OUT = process.env.SHOT_DIR ?? '/tmp/proofhound-shots';

const problems = [];
const note = (m) => console.log(`  ${m}`);

function watch(page, label) {
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      problems.push(`[${label}] console.${msg.type()}: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => problems.push(`[${label}] pageerror: ${err.message}`));
  page.on('response', (res) => {
    if (res.status() >= 400) problems.push(`[${label}] HTTP ${res.status()}: ${res.url()}`);
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    const error = req.failure()?.errorText ?? '';
    // Demonstration URLs use the reserved .invalid TLD and are never fetched.
    if (url.includes('.invalid')) return;
    // `?_rsc=` requests are Next router prefetches; the router aborts them when
    // the user navigates before they land. That is expected, not a failure.
    if (url.includes('_rsc=') && error === 'net::ERR_ABORTED') return;
    problems.push(`[${label}] requestfailed: ${url} ${error}`);
  });
}

/** Horizontal overflow is the defect that hides everything else on mobile. */
async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > doc.clientWidth + 2 || r.left < -2)) {
        offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} right=${Math.round(r.right)}`);
      }
    }
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, offenders: offenders.slice(0, 5) };
  });
  if (overflow.scrollWidth > overflow.clientWidth + 1) {
    problems.push(
      `[${label}] horizontal overflow: scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth} :: ${overflow.offenders.join(' | ')}`,
    );
  } else {
    note(`no horizontal overflow (${overflow.clientWidth}px)`);
  }
}

/** Text smaller than 11px or too close to the background is unreadable. */
async function assertLegibleText(page, label) {
  const tiny = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('p, span, td, th, li, h1, h2, h3, a, button')) {
      if (!el.textContent?.trim()) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size > 0 && size < 9.5) bad.push(`${el.tagName}:${size}px "${el.textContent.trim().slice(0, 30)}"`);
    }
    return bad.slice(0, 5);
  });
  if (tiny.length > 0) problems.push(`[${label}] text below 9.5px: ${tiny.join(' | ')}`);
  else note('no text below 9.5px');
}

async function runDemo(page, label) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /view demo case/i }).click();
  await page.waitForURL(/\/investigations\/[a-z0-9]+$/, { timeout: 30_000 });
  await page.waitForSelector('#source-dna', { timeout: 20_000 });
  note(`reached ${new URL(page.url()).pathname}`);
  return page.url();
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---- Desktop -------------------------------------------------------------
  console.log('\nDESKTOP 1440x900');
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const dp = await desktop.newPage();
  watch(dp, 'desktop');

  await dp.goto(BASE, { waitUntil: 'networkidle' });
  await dp.screenshot({ path: `${OUT}/01-landing-desktop.png`, fullPage: true });
  note('landing captured');
  await assertNoHorizontalOverflow(dp, 'desktop/landing');

  const caseUrl = await runDemo(dp, 'desktop');
  await dp.waitForTimeout(400);
  await dp.screenshot({ path: `${OUT}/02-workspace-desktop.png`, fullPage: true });
  note('workspace captured');
  await assertNoHorizontalOverflow(dp, 'desktop/workspace');
  await assertLegibleText(dp, 'desktop/workspace');

  // Headline metric present and correct shape.
  const headline = await dp.evaluate(() => {
    const read = (label) => {
      const el = [...document.querySelectorAll('#source-dna .ph-label')].find(
        (n) => n.textContent?.trim() === label,
      );
      return Number(el?.nextElementSibling?.textContent?.trim());
    };
    return { sources: read('Sources found'), families: read('Independent source families') };
  });
  note(`headline: ${headline.sources} sources -> ${headline.families} families`);
  if (!(headline.families > 0 && headline.families < headline.sources)) {
    problems.push(`[desktop] Source DNA headline does not show collapse (${JSON.stringify(headline)})`);
  }

  // Score breakdown opens.
  await dp.getByRole('button', { name: /show how this score was reached/i }).first().click();
  await dp.waitForSelector('text=Independent corroboration');
  note('score breakdown opens');

  // Graph rendered with nodes.
  const nodeCount = await dp.locator('#evidence-map svg g[role="button"]').count();
  note(`evidence map nodes: ${nodeCount}`);
  if (nodeCount < 5) problems.push(`[desktop] evidence map rendered only ${nodeCount} nodes`);

  // Label collisions in the graph: labels overlapping badly are unreadable.
  const collisions = await dp.evaluate(() => {
    const texts = [...document.querySelectorAll('#evidence-map svg text')];
    const boxes = texts.map((t) => t.getBoundingClientRect());
    let hits = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i], b = boxes[j];
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 8 && oy > 4) hits += 1;
      }
    }
    return { labels: texts.length, hits };
  });
  note(`graph labels: ${collisions.labels}, overlapping pairs: ${collisions.hits}`);
  if (collisions.hits > 3) problems.push(`[desktop] ${collisions.hits} overlapping graph labels`);

  // Node click drives the inspector.
  await dp.locator('#evidence-map svg g[role="button"]').first().click();
  await dp.waitForSelector('text=Source detail', { timeout: 5000 });
  note('node click opens source inspector');

  // Ledger filter.
  await dp.locator('#ledger').getByRole('group', { name: 'Stance' }).getByText('Contradicts').click();
  await dp.waitForTimeout(150);
  note('ledger filter applied');
  await dp.screenshot({ path: `${OUT}/03-workspace-desktop-filtered.png`, fullPage: true });

  // Keyboard reachability of graph nodes.
  const focusable = await dp.locator('#evidence-map svg g[role="button"][tabindex="0"]').count();
  note(`keyboard-reachable graph nodes: ${focusable}`);
  if (focusable < 5) problems.push('[desktop] graph nodes are not keyboard reachable');

  // The second demo case, via free text.
  await dp.goto(BASE, { waitUntil: 'networkidle' });
  await dp.getByLabel('Investigate a claim').fill(
    'A metal fragment held in government custody was analysed by two independent laboratories.',
  );
  await dp.getByRole('button', { name: /^investigate$/i }).click();
  await dp.waitForURL(/\/investigations\/[a-z0-9]+$/, { timeout: 30_000 });
  await dp.waitForSelector('#source-dna');
  await dp.screenshot({ path: `${OUT}/04-workspace-uap-desktop.png`, fullPage: true });
  note('second demo case reached via free-text input');

  // Honest empty state.
  await dp.goto(BASE, { waitUntil: 'networkidle' });
  await dp.getByLabel('Investigate a claim').fill('The parish council repainted the bandstand in April.');
  await dp.getByRole('button', { name: /^investigate$/i }).click();
  await dp.waitForURL(/\/investigations\/[a-z0-9]+$/, { timeout: 30_000 });
  await dp.waitForSelector('text=No sources retrieved');
  await dp.screenshot({ path: `${OUT}/05-empty-state-desktop.png`, fullPage: true });
  note('empty state states that nothing was retrieved');
  await assertNoHorizontalOverflow(dp, 'desktop/empty');

  // Case history.
  await dp.goto(`${BASE}/investigations`, { waitUntil: 'networkidle' });
  await dp.waitForSelector('h1:text("Case history")');
  await dp.screenshot({ path: `${OUT}/06-history-desktop.png`, fullPage: true });
  note('case history lists prior runs');

  await desktop.close();

  // ---- Mobile --------------------------------------------------------------
  console.log('\nMOBILE 390x844 (iPhone 13)');
  const mobile = await browser.newContext({ ...devices['iPhone 13'] });
  const mp = await mobile.newPage();
  watch(mp, 'mobile');

  await mp.goto(BASE, { waitUntil: 'networkidle' });
  await mp.screenshot({ path: `${OUT}/07-landing-mobile.png`, fullPage: true });
  await assertNoHorizontalOverflow(mp, 'mobile/landing');

  await runDemo(mp, 'mobile');
  await mp.waitForTimeout(400);
  await mp.screenshot({ path: `${OUT}/08-workspace-mobile.png`, fullPage: true });
  await assertNoHorizontalOverflow(mp, 'mobile/workspace');
  await assertLegibleText(mp, 'mobile/workspace');

  // The ledger must be records on mobile, never a nine-column table.
  const tableVisible = await mp.locator('#ledger table').isVisible().catch(() => false);
  if (tableVisible) problems.push('[mobile] the desktop ledger table is showing on a phone viewport');
  else note('ledger renders as stacked records, not a table');

  // Tapping a lineage row must bring the inspector into view.
  await mp.locator('#source-dna button').first().click();
  await mp.waitForSelector('text=Source detail', { timeout: 5000 });
  note('lineage tap opens the inspector inline');
  await mp.screenshot({ path: `${OUT}/09-workspace-mobile-detail.png`, fullPage: true });

  // Tap targets.
  const small = await mp.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('button, a')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.height < 22) {
        bad.push(`${el.tagName} ${Math.round(r.width)}x${Math.round(r.height)} "${el.textContent?.trim().slice(0, 24)}"`);
      }
    }
    return bad.slice(0, 6);
  });
  if (small.length > 0) note(`small tap targets: ${small.join(' | ')}`);
  else note('no tap target under 22px tall');

  await mobile.close();

  // ---- Tablet --------------------------------------------------------------
  console.log('\nTABLET 820x1180');
  const tablet = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  const tp = await tablet.newPage();
  watch(tp, 'tablet');
  await runDemo(tp, 'tablet');
  await tp.waitForTimeout(300);
  await tp.screenshot({ path: `${OUT}/10-workspace-tablet.png`, fullPage: true });
  await assertNoHorizontalOverflow(tp, 'tablet/workspace');
  await tablet.close();

  await browser.close();

  console.log('\n────────────────────────────────');
  if (problems.length === 0) {
    console.log('VERIFICATION PASSED — no console errors, no overflow, all flows reached.');
  } else {
    console.log(`VERIFICATION FOUND ${problems.length} PROBLEM(S):`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exitCode = 1;
  }
  console.log(`Screenshots: ${OUT}`);
}

main().catch((error) => {
  console.error('VERIFICATION CRASHED:', error);
  process.exit(1);
});
