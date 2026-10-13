import { expect, test } from '@playwright/test';

// Public-embedder defaults: what a page can do to the person's browser when
// the embedder configured nothing. The example page is a browser and opts in
// to everything, so these tests load it with ?policy={} (the library's own
// defaults).
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);
const write = (page, html) => evaluate(page, `document.open(); document.write(${JSON.stringify(html)}); document.close(); document.title`);
const open = async (page, query = '') => {
  await page.goto(`${PAGE}?url=about:blank&policy={}${query}`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => write(page, '<title>ready</title><p>ready</p>'), { timeout: 60_000 }).toBe('ready');
};

test('debug methods are off unless the embedder enables them', async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank&policy={}&debug=0`);
  const errors = await view(page).evaluate(async (el) => {
    const outcomes = [];
    for (const call of [() => el.debugEvaluate('1'), () => el.debugHeap(), () => el.debugCommand('debug.inject', { source: '1' })])
      outcomes.push(await call().then(() => 'allowed', (error) => error.message));
    return outcomes;
  });
  for (const message of errors) expect(message).toMatch(/Debug methods are off/);
});
