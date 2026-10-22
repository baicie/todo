import { defineConfig } from '@playwright/test';

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:4173';

/**
 * These tests always run against a production preview (`vite preview`), never
 * the dev server: the service worker is only registered when `import.meta.env.PROD`.
 *
 * The preview server is started automatically when APP_URL is not supplied.
 * Build first with `pnpm --filter @todo/app build`.
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]],
  use: {
    baseURL: APP_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    // Keep theme/contrast assertions deterministic: CSS transitions are
    // disabled by the app's prefers-reduced-motion rule.
    reducedMotion: 'reduce',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: process.env.APP_URL
    ? undefined
    : {
        command:
          'pnpm --dir ../.. --filter @todo/app preview --host 127.0.0.1 --port 4173 --strictPort',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
