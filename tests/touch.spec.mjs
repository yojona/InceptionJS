import { expect, test } from '@playwright/test';

// Touch input, as on a phone: a tap clicks, one finger scrolls, two fingers
// pinch-zoom the page and a long press opens the context menu. The host
// page itself neither scrolls nor zooms.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);
const write = (page, html) => evaluate(page, `document.open(); document.write(${JSON.stringify(html)}); document.close(); document.title`);

test.use({ hasTouch: true });

const PAGE_HTML = `<title>touch</title>
<style>body { margin: 0; height: 4000px } button { position: absolute; left: 40px; top: 40px; width: 120px; height: 60px }</style>
<button>Tap</button>
<script>
  window.events = [];
  const button = document.querySelector('button');
  button.addEventListener('click', (event) => events.push('click:' + event.detail));
  document.addEventListener('contextmenu', (event) => events.push('contextmenu:' + event.button));
</script>`;

test.beforeEach(async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => write(page, PAGE_HTML), { timeout: 60_000 }).toBe('touch');
});

// Raw touch points through the DevTools protocol, in page coordinates
// relative to the view.
async function touch(page) {
  const session = await page.context().newCDPSession(page);
  const box = await view(page).boundingBox();
  const points = (list) => list.map(([x, y], id) => ({ x: box.x + x, y: box.y + y, id }));
  return {
    start: (...list) => session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(list) }),
    move: (...list) => session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(list) }),
    end: () => session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
  };
}

test('a tap clicks, and two quick taps make a double click', async ({ page }) => {
  const box = await view(page).boundingBox();
  await page.touchscreen.tap(box.x + 100, box.y + 70);
  await expect.poll(() => evaluate(page, 'events.join()')).toBe('click:1');
  await page.waitForTimeout(400);
  await page.touchscreen.tap(box.x + 100, box.y + 70);
  await page.touchscreen.tap(box.x + 100, box.y + 70);
  await expect.poll(() => evaluate(page, 'events.join()')).toBe('click:1,click:1,click:2');
});

test('one finger scrolls the page, and the host page stays put', async ({ page }) => {
  const finger = await touch(page);
  await finger.start([200, 500]);
  for (let y = 480; y >= 100; y -= 20) await finger.move([200, y]);
  await finger.end();
  await expect.poll(async () => Number(await evaluate(page, 'scrollY')), { timeout: 10_000 }).toBeGreaterThan(300);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  expect(await evaluate(page, 'events.join()')).toBe('');
});

test('two fingers pinch-zoom the page', async ({ page }) => {
  const zoomed = view(page).evaluate((el) => new Promise((resolve) => el.addEventListener('zoom', (event) => resolve(event.detail.factor), { once: true })));
  const fingers = await touch(page);
  await fingers.start([300, 300], [400, 300]);
  for (let d = 60; d <= 200; d += 20) await fingers.move([350 - d, 300], [350 + d, 300]);
  await fingers.end();
  expect(await zoomed).toBeGreaterThan(1.5);
  expect(await view(page).evaluate((el) => el.shadowRoot.querySelector('canvas').style.transform)).toBe('');
});

test('a long press opens the context menu instead of clicking', async ({ page }) => {
  const finger = await touch(page);
  await finger.start([100, 70]);
  await page.waitForTimeout(700);
  await finger.end();
  await expect.poll(() => evaluate(page, 'events.join()')).toBe('contextmenu:2');
});
