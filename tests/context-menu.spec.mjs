import { expect, test } from '@playwright/test';

// A right-click asks the host for a context menu ("contextmenurequest"),
// with what is under the pointer, unless the page cancels "contextmenu".
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);
const write = (page, html) => evaluate(page, `document.open(); document.write(${JSON.stringify(html)}); document.close(); document.title`);

const PAGE_HTML = `<title>menu</title>
<style>body { margin: 0 } a, p { position: absolute; left: 40px; width: 200px; height: 40px; margin: 0 }</style>
<a href="https://example.com/next" style="top: 40px">Next page</a>
<p id="own" style="top: 140px">Own menu</p>
<script>
  window.events = [];
  document.addEventListener('contextmenu', (event) => events.push('contextmenu'));
  document.getElementById('own').addEventListener('contextmenu', (event) => event.preventDefault());
</script>`;

const nextRequest = (page) => view(page).evaluate((el) => new Promise((resolve) => {
  el.addEventListener('contextmenurequest', (event) => resolve(event.detail), { once: true });
  setTimeout(() => resolve(null), 1500);
}));

test.beforeEach(async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => write(page, PAGE_HTML), { timeout: 60_000 }).toBe('menu');
});

test('a right-click on a link asks the host for a menu with the link', async ({ page }) => {
  const box = await view(page).boundingBox();
  const request = nextRequest(page);
  await page.mouse.click(box.x + 60, box.y + 55, { button: 'right' });
  expect(await request).toMatchObject({ x: 60, y: 55, link: 'https://example.com/next', linkText: 'Next page', editable: false });
});

test('a page that cancels contextmenu keeps the host menu away', async ({ page }) => {
  const box = await view(page).boundingBox();
  const request = nextRequest(page);
  await page.mouse.click(box.x + 60, box.y + 155, { button: 'right' });
  expect(await request).toBe(null);
  expect(await evaluate(page, 'events.join()')).toBe('contextmenu');
});
