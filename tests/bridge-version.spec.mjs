import { expect, test } from '@playwright/test';

// Engine files of another release than the host: the view fails with a reason
// instead of waiting forever.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');

test('engine files that speak another bridge version fail the view with a reason', async ({ page }) => {
  await page.route('**/host/runtime.js', async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace('export const BRIDGE_VERSION = 1;', 'export const BRIDGE_VERSION = 99;');
    await route.fulfill({ response, body });
  });
  await page.goto(`${PAGE}?url=about:blank`);
  const crash = view(page).evaluate((el) => new Promise((resolve) => el.addEventListener('crash', (e) => resolve(e.detail.reason), { once: true })));
  const outcome = await view(page).evaluate((el) => el.ready.then(() => 'ready', (error) => error.message));
  expect(outcome).toMatch(/bridge v1 and the inceptionjs package v99/);
  expect(await crash).toMatch(/same release/);
});
