import { expect, test } from '@playwright/test';

// Until its first frame, a view says it is loading instead of staying blank.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const loadingText = (page) => view(page).evaluate((el) => el.shadowRoot.querySelector('[part="loading"]')?.textContent ?? null);

test('a starting view shows a loading indicator until its first frame', async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => loadingText(page)).toMatch(/Starting the engine|Loading/);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => loadingText(page), { timeout: 30_000 }).toBe(null);
});
