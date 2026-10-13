import { expect, test } from '@playwright/test';

const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');

test('the view reports the security state of the page it shows', async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => view(page).evaluate((el) => el.securityState?.scheme), { timeout: 60_000 }).toBe('about');
  expect(await view(page).evaluate((el) => el.securityState.secure)).toBe(false);
});
