import { expect, test } from '@playwright/test';

// Color emoji come from the bundled Noto Color Emoji (COLRv1): they paint in
// color, at any size, and a page full of them still paints quickly.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);
const write = (page, html) => evaluate(page, `document.open(); document.write(${JSON.stringify(html)}); document.close(); document.title`);

test.beforeEach(async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  await view(page).evaluate((el) => el.ready);
});

// Distinct, saturated colors in a box of the view's canvas.
const colorsIn = (page, box) => view(page).evaluate((el, box) => {
  const canvas = el.shadowRoot.querySelector('canvas');
  const scale = canvas.width / el.clientWidth;
  const copy = new OffscreenCanvas(canvas.width, canvas.height).getContext('2d');
  copy.drawImage(canvas, 0, 0);
  const data = copy.getImageData(box.x * scale, box.y * scale, box.width * scale, box.height * scale).data;
  const colors = new Set();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 60) colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
  }
  return colors.size;
}, box);

test('emoji paint in color, small and large', async ({ page }) => {
  await expect.poll(() => write(page, '<title>emoji</title><body style="margin:0;background:#fff"><div style="font-size:20px">😀🎉🚀</div><div style="font-size:160px;line-height:1">🦊</div></body>')).toBe('emoji');
  await page.waitForTimeout(500);
  expect(await colorsIn(page, { x: 0, y: 0, width: 90, height: 28 })).toBeGreaterThan(10);
  expect(await colorsIn(page, { x: 0, y: 30, width: 180, height: 180 })).toBeGreaterThan(30);
});

test('a page full of emoji paints in reasonable time', async ({ page }) => {
  const emoji = Array.from({ length: 600 }, (_, i) => String.fromCodePoint(0x1f600 + (i % 80))).join('');
  await expect.poll(() => write(page, `<title>many</title><body style="margin:0;font-size:24px;word-break:break-all">${emoji}</body>`)).toBe('many');
  await page.waitForTimeout(500);
  await view(page).evaluate((el) => el.debugFrames());
  await view(page).evaluate((el) => el.debugCommand('perf.configure', { damage: false }));
  await page.waitForTimeout(600);
  const stats = await view(page).evaluate((el) => el.debugFrames());
  await view(page).evaluate((el) => el.debugCommand('perf.configure', { damage: true }));
  console.log('emoji page full repaint', JSON.stringify(stats.paint));
  expect(stats.frames).toBeGreaterThan(0);
  expect(stats.paint.max).toBeLessThan(200);
});
