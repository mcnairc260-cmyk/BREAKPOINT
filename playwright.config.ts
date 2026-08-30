import { defineConfig, devices } from '@playwright/test';

/**
 * Browser acceptance tests.
 *
 * These run against the *built* application served by `vite preview`, not
 * against the dev server: the thing shipped is the thing verified. The build
 * is a prerequisite, so CI runs `npm run build` before `npm run e2e`.
 *
 * Each viewport is a separate project rather than a loop inside one spec, so a
 * failure names the viewport it happened on and desktop, portrait and landscape
 * results are individually visible in CI.
 */
export default defineConfig({
  testDir: './e2e',
  // Software-rendered WebGL in CI is slow; a whole shot has to fit inside this.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // SwiftShader gives headless Chromium a working WebGL implementation. It is
    // slow, so these tests prove correctness and layout — never frame rate.
    //
    // `BREAKPOINT_CHROMIUM` points at an already-installed browser, for
    // sandboxes that ship one for a different Playwright build than the one
    // pinned here. CI leaves it unset and uses `npx playwright install
    // chromium`, so nothing environment-specific is baked into the config.
    launchOptions: {
      executablePath: process.env.BREAKPOINT_CHROMIUM || undefined,
      args: [
        '--enable-unsafe-swiftshader',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--no-sandbox',
      ],
    },
  },

  projects: [
    {
      name: 'desktop-1280x800',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile-portrait-390x844',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'mobile-portrait-430x932',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 430, height: 932 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'mobile-landscape-844x390',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 844, height: 390 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],

  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
