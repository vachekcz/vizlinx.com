import { defineConfig, devices } from '@playwright/test';

// Screenshot tour config: runs only tests/tour/, once per viewport project.
// The main playwright.config.ts ignores the same directory (testIgnore), so
// the tour never runs (and never writes screenshots) during ordinary e2e runs.
//
// The tour needs the Worker, not just the static build: /scan talks to
// /api/v1 (session, config, saved maps), which only `wrangler dev` serves.
// The port is deliberately neither Vite's 5173 nor the 8797 of
// `npm run dev:api`, so a developer's running servers are never reused by
// mistake (reuseExistingServer would otherwise pick up a server without /api).

const PORT = 8798;
const baseURL = `http://127.0.0.1:${PORT}`;

// Local mode (wrangler's default) needs no Cloudflare token; D1 and the queue
// run in Miniflare. --env-file=/dev/null keeps a developer's .env out of it.
const wranglerDev = `npx wrangler dev --port ${PORT} --env-file=/dev/null`;

// CI builds the app and applies the local D1 migrations in the workflow's
// APP SETUP block; locally the same two steps run here so that
// `npm run screenshots:tour` works from a clean checkout.
const webServerCommand = process.env.CI
  ? wranglerDev
  : `npm run build && npm run db:local && ${wranglerDev}`;

export default defineConfig({
  testDir: './tests/tour',
  // The tour is a narrative: states build on each other within a spec, and
  // parallel workers competing over one local D1 produce flaky captures.
  fullyParallel: false,
  timeout: 90_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 1,
  workers: 2,
  reporter: process.env.CI ? [['list'], ['html']] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    // Pages without ?theme= follow prefers-color-scheme; pin it so the
    // "system" fallback renders the same on every machine.
    colorScheme: 'light',
    // Animations would otherwise land mid-transition in the screenshots.
    // reducedMotion only exists inside contextOptions — as a bare `use` key it
    // is silently ignored (and rejected by tsc, which is why this config is
    // part of tsconfig.node.json's include).
    contextOptions: { reducedMotion: 'reduce' },
  },
  // Project names become the top-level folder in screenshots-output/ and the
  // viewport toggle in the gallery, in this order. Viewports mirror
  // playwright.config.ts so the gallery shows what the e2e suite tests.
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1600, height: 1000 },
      },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command: webServerCommand,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    // Locally the command also builds the app (tsc + Vite + extension).
    timeout: 180_000,
  },
});
