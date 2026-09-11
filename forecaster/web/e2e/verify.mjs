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
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Find a Chromium to drive.
 *
 * Some environments ship a Chromium whose build number does not match the
 * Playwright package's expectation. Playwright then refuses to launch and tells
 * you to download another one — which is the wrong answer when a perfectly good
 * browser is already installed, and impossible where the network is blocked.
 * So an existing binary is preferred and Playwright's own is the fallback.
 */
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const candidates = readdirSync(root)
    .filter((name) => name.startsWith('chromium-'))
    .map((name) => join(root, name, 'chrome-linux', 'chrome'))
    .filter((path) => existsSync(path));
  return candidates[0];
}

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

/** The ABOVE probability on the first forecast card, as a percentage. */
async function readAboveProbability(page) {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('div')) {
      if (el.textContent?.trim() === 'Above') {
        const value = el.nextElementSibling?.textContent?.trim() ?? '';
        if (value.startsWith('<')) return 0.5;
        if (value.startsWith('>')) return 99.5;
        const parsed = Number.parseFloat(value.replace('%', ''));
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return Number.NaN;
  });
}

async function run() {
  await mkdir(OUT, { recursive: true });
  const executablePath = findChromium();
  if (executablePath) console.log(`using ${executablePath}`);
  const browser = await chromium.launch(executablePath ? { executablePath } : {});

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

    // --- choosing the asset ------------------------------------------------
    // Both assets must be reachable and must show different prices. A selector
    // that renders but does not switch would pass every other check here.
    await page.getByRole('button', { name: /Ethereum|ETH/ }).first().click();
    await page.waitForFunction(
      (btcPrice) => {
        const match = document.body.innerText.match(/\$([\d,]+\.\d\d)/);
        if (!match) return false;
        const shown = Number.parseFloat(match[1].replace(/,/g, ''));
        return Number.isFinite(shown) && Math.abs(shown - btcPrice) / btcPrice > 0.1;
      },
      spot,
      { timeout: 20_000 },
    );
    note('switching to ETH shows a different live price');
    await page.getByRole('button', { name: /Bitcoin|BTC/ }).first().click();
    await page.waitForFunction(
      (btcPrice) => {
        const match = document.body.innerText.match(/\$([\d,]+\.\d\d)/);
        if (!match) return false;
        const shown = Number.parseFloat(match[1].replace(/,/g, ''));
        return Number.isFinite(shown) && Math.abs(shown - btcPrice) / btcPrice < 0.1;
      },
      spot,
      { timeout: 20_000 },
    );
    note('switching back to BTC restores the BTC price');
    await assertNoHorizontalOverflow(page, label);

    // --- a target ABOVE the current price ---------------------------------
    const input = page.locator('input[type="number"]');
    await input.fill((spot * 1.002).toFixed(2));
    await page.getByRole('button', { name: 'Both' }).click();
    await page.getByRole('button', { name: 'Predict' }).click();
    // Wait for the forecast CARD, not the "5 min" horizon button. Playwright's
    // text engine is case-insensitive, so `text=5 MIN` matches the button too —
    // which made every check below run before any result had rendered, and
    // report three failures that were entirely this line's fault.
    await page.getByRole('heading', { level: 3, name: '5 MIN' }).waitFor({ timeout: 20_000 });
    await assertNoHorizontalOverflow(page, label);

    const cards = await page.getByRole('heading', { level: 3 }).count();
    if (cards < 2) problems.push(`[${label}] expected both horizons, found ${cards}`);
    else note(`both horizons rendered (${cards} cards)`);

    const aboveCount = await page.locator('text=Above').count();
    const belowCount = await page.locator('text=Below').count();
    if (aboveCount < 2 || belowCount < 2) {
      problems.push(`[${label}] both probabilities must be visible on both cards`);
    } else {
      note('above and below shown on both cards');
    }

    const highTargetProb = await readAboveProbability(page);

    if ((await page.getByText('to go').count()) === 0) {
      problems.push(`[${label}] no countdown to expiry`);
    } else {
      note('countdown to expiry is running');
    }

    // A countdown alone is not enough: "4:58 to go" does not say when, and a
    // user who leaves the page needs the clock time to come back to.
    if ((await page.getByText('Scores at').count()) < 2) {
      problems.push(`[${label}] no absolute expiry time shown on both cards`);
    } else {
      const scoresAt = await page.getByText(/^\d{1,2}:\d{2}(:\d{2})?( ?[ap]m)?$/i).count();
      if (scoresAt === 0) {
        problems.push(`[${label}] "Scores at" is shown without a clock time`);
      } else {
        note('absolute expiry time shown alongside the countdown');
      }
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
    const lowTargetProb = await readAboveProbability(page);

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
    // The heading is server-rendered and the rows are fetched afterwards, so
    // counting immediately measures how fast the machine is, not whether the
    // page works. Counting without this wait passed by luck until the checks
    // above changed the timing.
    await page
      .locator('text=Target')
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => {});
    const rows = await page.locator('text=Target').count();
    if (rows === 0) problems.push(`[${label}] history shows no forecasts after making some`);
    else note(`history shows ${rows} forecasts`);

    // A forecast the user can inspect AFTER it expired. The whole product rests
    // on outcomes being visible, so a history that only ever showed "pending"
    // would be a serious functional gap however well the rest worked.
    //
    // Read the page's own SCORED counter rather than grepping for the word
    // "resolved": the explanatory copy on this page contains "scored" and
    // "resolved" in prose, so a text match is true whether or not anything has
    // actually been scored.
    const scored = await page.evaluate(() => {
      const labels = [...document.querySelectorAll('*')].filter(
        (el) => el.children.length === 0 && /^SCORED$/i.test((el.textContent ?? '').trim()),
      );
      for (const el of labels) {
        const block = el.parentElement?.textContent ?? '';
        const match = block.replace(/SCORED/i, '').match(/\d+/);
        if (match) return Number.parseInt(match[0], 10);
      }
      return null;
    });
    if (scored === null) {
      problems.push(`[${label}] the history page does not report how many forecasts were scored`);
    } else if (scored > 0) {
      // A resolved row must show both halves of the result: whether the forecast
      // was right, and the price it was settled at. The badge alone would let a
      // user see a verdict with no way to check it.
      const body = await page.innerText('body');
      const badges = (body.match(/[✓✗]\s*(CORRECT|WRONG)/gi) ?? []).length;
      const settled = (body.match(/SETTLED AT\n\$[\d,]+/g) ?? []).length;
      if (badges === 0) {
        problems.push(
          `[${label}] ${scored} forecasts are scored but no row shows a correct/wrong verdict`,
        );
      } else if (settled === 0) {
        problems.push(
          `[${label}] ${scored} forecasts are scored but no row shows the settlement price`,
        );
      } else {
        note(
          `resolved forecasts are inspectable: ${badges} verdicts, ` +
            `${settled} settlement prices`,
        );
      }
      // And the page must not let a tiny sample read as a track record.
      if (!/far too few|too few|not enough/i.test(body)) {
        problems.push(`[${label}] a ${scored}-forecast sample is shown without a caveat`);
      } else {
        note('small-sample caveat is shown next to the accuracy figure');
      }
    } else {
      note(
        'nothing had expired yet in this run, and the page says so rather than ' +
          'showing a blank — expiry and scoring are covered by the engine suite',
      );
    }
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
