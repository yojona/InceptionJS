import { expect, test } from '@playwright/test';

// overscan="N": the engine paints N CSS pixels of the page above and below
// the viewport, and the canvas reaches past the view by as much. Input,
// what shows in the viewport, and scrolling stay as without it.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);
const write = (page, html) => evaluate(page, `document.open(); document.write(${JSON.stringify(html)}); document.close(); document.title`);
const OVERSCAN = 150;

test.use({ hasTouch: true });

const PAGE_HTML = `<title>overscan</title>
<style>body { margin: 0; font: 16px serif } p { margin: 0; padding: 8px 12px; border-bottom: 1px solid #ccc } p:nth-child(3n) { background: #eef }
  button { position: absolute; left: 40px; top: 40px; width: 120px; height: 60px }</style>
<button>Tap</button>
${Array.from({ length: 200 }, (_, i) => `<p>Paragraph ${i}</p>`).join('')}
<script>window.clicks = 0; document.querySelector('button').addEventListener('click', () => clicks++);</script>`;

test.beforeEach(async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank&overscan=${OVERSCAN}`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => write(page, PAGE_HTML), { timeout: 60_000 }).toBe('overscan');
});

// The viewport's pixels in the canvas, as the person sees them.
const viewportPixels = (page) => view(page).evaluate((el, overscan) => {
  const canvas = el.shadowRoot.querySelector('canvas');
  const scale = canvas.width / el.clientWidth;
  const copy = new OffscreenCanvas(canvas.width, canvas.height).getContext('2d');
  copy.drawImage(canvas, 0, 0);
  return Array.from(copy.getImageData(0, Math.round(overscan * scale), canvas.width, Math.round(el.clientHeight * scale)).data);
}, OVERSCAN);

test('the canvas reaches past the view by the overscan, and taps land where they did', async ({ page }) => {
  await expect.poll(() => view(page).evaluate((el) => el.shadowRoot.querySelector('canvas').style.top)).toBe(`-${OVERSCAN}px`);
  const sizes = await view(page).evaluate((el) => {
    const canvas = el.shadowRoot.querySelector('canvas');
    return { view: el.clientHeight, canvas: canvas.getBoundingClientRect().height, pixels: canvas.height / devicePixelRatio };
  });
  expect(Math.round(sizes.canvas)).toBe(sizes.view + 2 * OVERSCAN);
  expect(Math.round(sizes.pixels)).toBe(sizes.view + 2 * OVERSCAN);
  const box = await view(page).boundingBox();
  await page.touchscreen.tap(box.x + 100, box.y + 70);
  await expect.poll(() => evaluate(page, 'clicks')).toBe('1');
});

test('after scrolls, the viewport shows what a full repaint shows', async ({ page }) => {
  const box = await view(page).boundingBox();
  await page.mouse.move(box.x + 300, box.y + 300);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 120);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(400);
  const partial = await viewportPixels(page);
  await view(page).evaluate((el) => el.debugCommand('perf.configure', { damage: false }));
  await page.waitForTimeout(400);
  const full = await viewportPixels(page);
  await view(page).evaluate((el) => el.debugCommand('perf.configure', { damage: true }));
  let changed = 0;
  for (let i = 0; i < full.length; i += 4) if (full[i] !== partial[i] || full[i + 1] !== partial[i + 1] || full[i + 2] !== partial[i + 2]) changed++;
  expect(changed).toBeLessThan(20);
});

test('a finger scroll ends lined up: the right scroll position, the canvas back in place', async ({ page }) => {
  const session = await page.context().newCDPSession(page);
  const box = await view(page).boundingBox();
  const touch = (type, y) => session.send('Input.dispatchTouchEvent', { type, touchPoints: y === undefined ? [] : [{ x: box.x + 200, y: box.y + y, id: 0 }] });
  await touch('touchStart', 500);
  for (let y = 480; y >= 100; y -= 20) await touch('touchMove', y);
  await touch('touchEnd');
  // 400 pixels under the finger, and momentum after.
  await expect.poll(async () => Number(await evaluate(page, 'scrollY'))).toBeGreaterThanOrEqual(400);
  await page.waitForTimeout(1500);
  expect(await view(page).evaluate((el) => el.shadowRoot.querySelector('canvas').style.transform)).toBe('');
});
