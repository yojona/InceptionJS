import { expect, test } from '@playwright/test';

// A window of an engine shown by another document through the display
// channel: an isolated frame, and a page with no cross-origin isolation.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluateIn = (page, window, source) => view(page).evaluate((el, [w, s]) => el.debugEvaluate(s, { window: w }), [window, source]);
const write = (page, window, html) => evaluateIn(page, window, `document.open(); document.write(${JSON.stringify(html)}); document.close(); document.title`);
const scene = '<title>shown elsewhere</title><style>html,body{margin:0;height:100%;background:rgb(0,128,0)}</style><script>window.downs = 0; addEventListener("mousedown", () => downs++)</script>';

async function start(page) {
  await page.goto(`${PAGE}?url=about:blank`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => write(page, 1, '<title>one</title>'), { timeout: 60_000 }).toBe('one');
  const id = await view(page).evaluate(async (el) => (await el.openWindow({ width: 300, height: 200, url: 'about:blank' })).id);
  await expect.poll(() => evaluateIn(page, id, 'document.readyState'), { timeout: 30_000 }).toBe('complete');
  await write(page, id, scene);
  return id;
}

const canvasColor = (target) => target.evaluate(async () => {
  const canvas = document.querySelector('canvas');
  if (!canvas?.width) return null;
  const bitmap = await createImageBitmap(canvas);
  const copy = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
  copy.drawImage(bitmap, 0, 0);
  const [r, g, b] = copy.getImageData(10, 10, 1, 1).data;
  return [r, g, b];
});

test('an isolated frame shows a window and drives it; removing it leaves the engine alone', async ({ page }) => {
  const id = await start(page);
  await page.evaluate(() => {
    const frame = Object.assign(document.createElement('iframe'), { src: '/examples/window-display.html', id: 'display' });
    frame.style.cssText = 'width: 300px; height: 200px; border: 0; display: block';
    document.body.append(frame);
    return new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
  });
  await view(page).evaluate((el, w) => document.getElementById('display').contentWindow.postMessage({}, location.origin, [el.exportWindow(w)]), id);
  const frame = page.frameLocator('#display');
  const frameHandle = page.frames().find((f) => f.url().includes('window-display.html'));
  await expect.poll(() => canvasColor(frameHandle), { timeout: 20_000 }).toEqual([0, 128, 0]);
  expect(await view(page).evaluate((el, w) => el.windows.find((x) => x.window === w).visible, id)).toBe(true);
  await frame.locator('canvas').click({ position: { x: 30, y: 30 } });
  await expect.poll(() => evaluateIn(page, id, 'String(downs)')).toBe('1');
  await expect.poll(() => evaluateIn(page, id, 'innerWidth + "x" + innerHeight')).toBe('300x200');

  await page.evaluate(() => document.getElementById('display').remove());
  expect(await evaluateIn(page, 1, 'document.title')).toBe('one');
  expect(await evaluateIn(page, id, 'document.title')).toBe('shown elsewhere');
});

test('a page without cross-origin isolation shows a window through a shared worker', async ({ page, context }) => {
  const id = await start(page);
  const display = await context.newPage();
  await display.goto('/plain/examples/window-display.html?broker=/tests/fixtures/port-broker.js');
  expect(await display.evaluate(() => crossOriginIsolated)).toBe(false);
  await view(page).evaluate((el, w) => {
    const worker = new SharedWorker('/tests/fixtures/port-broker.js');
    const port = el.exportWindow(w);
    worker.port.postMessage({ offer: true }, [port]);
  }, id);
  await expect.poll(() => canvasColor(display), { timeout: 30_000 }).toEqual([0, 128, 0]);
  await display.locator('canvas').click({ position: { x: 30, y: 30 } });
  await expect.poll(() => evaluateIn(page, id, 'String(downs)')).toBe('1');
  await display.close();
  expect(await evaluateIn(page, 1, 'document.title')).toBe('one');
});
