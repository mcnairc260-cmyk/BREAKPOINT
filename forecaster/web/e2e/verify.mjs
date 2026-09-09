/**
 * Browser verification.
 *
 * Drives the production build in real Chromium at a desktop and an iPhone
 * viewport, exercises the complete forecast flow, records every console message
 * and page error, and captures screenshots. Any console error fails the run.
 *
 * This exists because a build that typechecks, lints and passes unit tests can
 * still render a blank screen, and because the specific things this product must
 * get right — the simulated-data banner appearing, both probabilities being
 * visible, a target below the current price behaving differently from one above,
 * no horizontal scrolling on a phone — are only observable in a browser.
 *
 *   node e2e/verify.mjs            (against a running production server)
 */
import { chromium, devices } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3220';
const OUT = process.env.SHOT_DIR ?? '/tmp/forecaster-shots';

const problems = [];
const notes = [];
const note = (m) => {
  notes.push(m);
  console.log(`  ${m}`);
};

function watch(page, label) {
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      problems.push(`[${label}] console.${msg.type()}: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => problems.push(`[${label}] pageerror: ${err.message}`));
  page.on('response', (res) => {
    // 409 is the engine declining to forecast and saying why. That is a state
    // the interface is designed to render, not a failure.
    if (res.status() >= 400 && res.status() !== 409) {
      problems.push(`[${label}] HTTP ${res.status()}: ${res.url()}`);
    }
  });
  page.on('requestfailed', (req) => {
    const error = req.failure()?.errorText ?? '';
    if (req.url().includes('_rsc=') && error === 'net::ERR_ABORTED') return;
    problems.push(`[${label}] requestfailed: ${req.url()} ${error}`);
  });
}

/** Horizontal overflow is the defect that hides everything else on mobile. */
async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scroll: doc.scrollWidth, client: doc.clientWidth };
  });
  if (overflow.scroll > overflow.client + 1) {
    problems.push(
      `[${label}] page scrolls horizontally: ${overflow.scroll}px of content in ${overflow.client}px`,
    );
  }
}

async function readNumber(page, selector) {
  const text = await page.locator(selector).first().textContent();
  return Number.parseFloat((text ?? '').replace(/[^0-9.]/g, ''));
}

async function run() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();

  for (const [label, context] of [
    ['desktop', { viewport: { width: 1280, height: 900 } }],
    ['iphone', devices['iPhone 13']],
  ]) {
    console.log(`\n${label}`);
    const ctx = await browser.newContext(context);
    const page = await ctx.newPage();
    watch(page, label);

    // --- the forecast page ------------------------------------------------
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Live price', { timeout: 15_000 });
    await assertNoHorizontalOverflow(page, label);

    const banner = await page.locator('text=SIMULATED MARKET').count();
    if (banner === 0) {
      problems.push(`[${label}] the simulated-data banner is missing`);
    } else {
      note('simulated-data banner is shown');
    }

    // Wait for a live price to arrive.
    await page.waitForFunction(
      () => /\$[\d,]+\.\d\d/.test(document.body.innerText),
      { timeout: 20_000 },
    );
    const spotText = await page.locator('.tnum').first().textContent();
    const spot = Number.parseFloat((spotText ?? '').replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(spot) || spot <= 0) {
      problems.push(`[${label}] no live price rendered (read "${spotText}")`);
      await ctx.close();
      continue;
    }
    note(`live price ${spot}`);

    // --- a target ABOVE the current price ---------------------------------
    const input = page.locator('input[type="number"]');
    await input.fill((spot * 1.002).toFixed(2));
    await page.getByRole('button', { name: 'Both' }).click();
    await page.getByRole('button', { name: 'Predict' }).click();
    await page.waitForSelector('text=5 MIN', { timeout: 20_000 });
    await assertNoHorizontalOverflow(page, label);

    const cards = await page.locator('text=/^\\d+ MIN$/').count();
    if (cards < 2) problems.push(`[${label}] expected both horizons, found ${cards}`);
    else note('both horizons rendered');

    const aboveCount = await page.locator('text=Above').count();
    const belowCount = await page.locator('text=Below').count();
    if (aboveCount < 2 || belowCount < 2) {
      problems.push(`[${label}] both probabilities must be visible on both cards`);
    } else {
      note('above and below shown on both cards');
    }

    const highTargetProb = await readNumber(page, '.tnum.font-semibold.leading-none');

    if ((await page.locator('text=/to go/').count()) === 0) {
      problems.push(`[${label}] no countdown to expiry`);
    } else {
      note('countdown to expiry is running');
    }

    await page.getByRole('button', { name: /Show how this number was made/ }).first().click();
    await page.waitForSelector('text=Distance in σ', { timeout: 5_000 });
    note('advanced panel opens');
    await assertNoHorizontalOverflow(page, label);
    await page.screenshot({ path: `${OUT}/${label}-forecast.png`, fullPage: true });

    // --- a target BELOW the current price ---------------------------------
    await input.fill((spot * 0.998).toFixed(2));
    await page.getByRole('button', { name: 'Predict' }).click();
    await page.waitForTimeout(1500);
    const lowTargetProb = await readNumber(page, '.tnum.font-semibold.leading-none');

    if (Number.isFinite(highTargetProb) && Number.isFinite(lowTargetProb)) {
      if (!(lowTargetProb > highTargetProb)) {
        problems.push(
          `[${label}] a lower target must have a HIGHER chance of being exceeded ` +
            `(got ${lowTargetProb}% for the low target vs ${highTargetProb}% for the high one)`,
        );
      } else {
        note(`ordering holds: ${lowTargetProb}% for the low target > ${highTargetProb}% for the high one`);
      }
    }

    // --- history ----------------------------------------------------------
    await page.getByRole('link', { name: 'History' }).click();
    await page.waitForSelector('text=Prediction history', { timeout: 10_000 });
    await assertNoHorizontalOverflow(page, label);
    const rows = await page.locator('text=Target').count();
    if (rows === 0) problems.push(`[${label}] history shows no forecasts after making some`);
    else note(`history shows ${rows} forecasts`);
    await page.screenshot({ path: `${OUT}/${label}-history.png`, fullPage: true });

    // --- performance ------------------------------------------------------
    await page.getByRole('link', { name: 'Performance' }).click();
    await page.waitForSelector('text=Model performance', { timeout: 10_000 });
    await assertNoHorizontalOverflow(page, label);
    note('performance page renders');
    await page.screenshot({ path: `${OUT}/${label}-performance.png`, fullPage: true });

    await ctx.close();
  }

  await browser.close();

  console.log('\n' + '='.repeat(60));
  if (problems.length) {
    console.log(`FAILED — ${problems.length} problem(s):\n`);
    for (const problem of problems) console.log(`  · ${problem}`);
    process.exit(1);
  }
  console.log(`PASSED — ${notes.length} checks, screenshots in ${OUT}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
