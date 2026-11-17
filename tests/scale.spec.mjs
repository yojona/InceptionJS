import { expect, test } from '@playwright/test';

// On a phone-like screen of 3.25 the engine paints at 3 (deviceScale
// 'integer', the default), so a scroll moves pixels; 'native' keeps 3.25.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);
const write = (page, html) => evaluate(page, `document.open(); document.write(${JSON.stringify(html)}); document.close(); document.title`);

test.use({ deviceScaleFactor: 3.25, viewport: { width: 500, height: 600 } });

const LONG = `<title>long</title><body style="margin:0;font:16px serif">${Array.from({ length: 200 }, (_, i) => `<p>Paragraph ${i}</p>`).join('')}</body>`;

async function scrollAndCount(page, query) {
  await page.goto(`${PAGE}?url=about:blank${query}`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => write(page, LONG)).toBe('long');
  await page.waitForTimeout(500);
  const box = await view(page).boundingBox();
  await page.mouse.move(box.x + 100, box.y + 100);
  await view(page).evaluate((el) => el.debugFrames());
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 60);
  await page.waitForTimeout(400);
  const stats = await view(page).evaluate((el) => el.debugFrames());
  const scale = await view(page).evaluate((el) => el.shadowRoot.querySelector('canvas').width / el.clientWidth);
  return { moved: stats.movedScrolls, scale };
}

test('a 3.25 screen paints at 3, and scrolls move pixels', async ({ page }) => {
  const { moved, scale } = await scrollAndCount(page, '');
  expect(scale).toBeCloseTo(3, 1);
  expect(moved).toBeGreaterThan(0);
});

test("deviceScale 'native' paints at 3.25, and scrolls repaint", async ({ page }) => {
  const { moved, scale } = await scrollAndCount(page, '&device-scale=native');
  expect(scale).toBeCloseTo(3.25, 1);
  expect(moved).toBe(0);
});
