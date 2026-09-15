import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the local Vite dev server and its in-process
 * fixture API. No Netlify or Cloudflare account is involved.
 *
 * Chromium and WebKit only. Firefox is deliberately absent for the admin
 * flows (decisions.md #20), and the display site's behaviour is engine-
 * independent enough that two engines is honest coverage.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: 'npm run dev:display',
      url: 'http://localhost:5173/dev-display-path/',
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
    },
    {
      command: 'npm run dev:admin',
      url: 'http://localhost:5174/dev-admin-path/',
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
    },
    /*
     * The family app again, once per desktop project, for display.spec.ts's
     * "the family can curate" tests. Those upload, edit, trash, and restore,
     * and the fixture library is one in-memory store per dev server: on the
     * shared :5173 they would race the display tests that count the library
     * exactly, and each other across the two engines. A server of their own
     * per project makes every count they assert exact.
     */
    ...['chromium', 'webkit'].map((project, index) => ({
      command: `npx vite --config vite.display.config.ts --port ${5176 + index} --strictPort`,
      url: `http://localhost:${5176 + index}/dev-display-path/`,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore' as const,
      name: `family-${project}`,
    })),
    {
      // The pipeline needs a real engine: createImageBitmap, OffscreenCanvas,
      // and WebAssembly cannot be exercised meaningfully under a DOM shim.
      command: 'npm run dev:harness',
      url: 'http://localhost:5175/',
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
    },
  ],
});
