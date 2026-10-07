import { expect, test } from '@playwright/test';

const PAGE = process.env.PAGE_PATH ?? '/';

const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);

test.beforeEach(async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  await view(page).evaluate((el) => el.ready);
});

test('a cross-origin iframe loads and stays cross-origin', async ({ page }) => {
  await evaluate(page, `window.loaded = 0; document.body.innerHTML = '<iframe id="f" src="https://example.com/" width="400" height="300" onload="loaded++"></iframe>'; 'ok'`);
  await expect.poll(() => evaluate(page, 'String(loaded)'), { timeout: 60_000 }).toBe('1');
  expect(await evaluate(page, `(() => { try { return frames[0].document.title; } catch (e) { return e.name; } })()`)).toBe('SecurityError');
});

test('frames talk with postMessage', async ({ page }) => {
  await evaluate(page, `window.got = ''; addEventListener('message', (e) => { got = e.data; });
    document.body.innerHTML = '<iframe srcdoc="<script>parent.postMessage(\\'hello from the frame\\', \\'*\\')<\\/script>"></iframe>'; 'ok'`);
  await expect.poll(() => evaluate(page, 'got'), { timeout: 30_000 }).toBe('hello from the frame');
});
