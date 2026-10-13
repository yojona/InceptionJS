import { defineConfig } from '@playwright/test';

// BASE_URL points the suite at any deployment that accepts ?url= and mirrors
// the page title into document.title; without it, the dev server starts here.
const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:8085';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs/,
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1024, height: 700 },
  },
  // `npm test` runs Chrome; pick the others with --project=firefox / --project=webkit.
  projects: [
    {
      name: 'chrome',
      use: { channel: 'chrome', launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'] } },
    },
    { name: 'firefox', use: { browserName: 'firefox', launchOptions: { firefoxUserPrefs: { 'media.volume_scale': '0.0' } } } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: process.env.BASE_URL
    ? undefined
    : { command: 'node tests/serve.mjs', url: baseURL, reuseExistingServer: true, cwd: '..' },
});
