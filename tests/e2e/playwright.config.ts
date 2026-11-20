import { defineConfig, devices } from '@playwright/test';

/**
 * Tutr end-to-end workflow suite. Each test starts its own hub (fixtures/hub.ts) on a copy of a library with the
 * AI and speech models faked (harness/fake_hub.py), so tests are independent and can run in parallel.
 */
export default defineConfig({
  testDir: './specs',
  outputDir: './.runs/results',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: './.runs/report', open: 'never' }]],
  use: {
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['microphone', 'clipboard-read', 'clipboard-write'],
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } }, testIgnore: /\.mobile\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /\.mobile\.spec\.ts/ },
  ],
});
