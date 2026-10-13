import { expect, test } from '@playwright/test';

const PAGE = process.env.PAGE_PATH ?? '/';

test.use({ deviceScaleFactor: 2 });

// At a device pixel ratio of 2, with no resize, the view's backing store must
// keep the size its box asks for, and the page must stay painted.
test('view size is stable at dpr 2 without resizes', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', 'Playwright\'s Firefox does not emulate the device pixel ratio');
  test.setTimeout(150_000);
  await page.goto(`${PAGE}?url=${encodeURIComponent('https://www.wikipedia.org/')}`);
  await expect(page).toHaveTitle('Wikipedia', { timeout: 60_000 });

  const sample = () => page.evaluate(() => {
    const canvases = [...document.querySelectorAll('*')].flatMap((el) => [el, ...(el.shadowRoot ? el.shadowRoot.querySelectorAll('canvas') : [])]).filter((el) => el instanceof HTMLCanvasElement);
    const canvas = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const box = canvas.getBoundingClientRect();
    return { width: canvas.width, height: canvas.height, cssWidth: Math.round(box.width), cssHeight: Math.round(box.height) };
  });

  const first = await sample();
  expect(first.width).toBe(first.cssWidth * 2);
  expect(first.height).toBe(first.cssHeight * 2);
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(10_000);
    expect(await sample()).toEqual(first);
  }
});
