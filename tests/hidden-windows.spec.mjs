import { expect, test } from '@playwright/test';

// Windows nobody shows: a hidden window gives its render target back, and a
// headless view (an engine host with no picture of its own) shows window 1
// only where it is exported.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluateIn = (page, window, source) => view(page).evaluate((el, [w, s]) => el.debugEvaluate(s, { window: w }), [window, source]);
const surfaces = (page) => view(page).evaluate((el) => el.debugHeap().then((heap) => heap.surfaces));

test('a hidden window releases its render target and paints again when shown', async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  await view(page).evaluate((el) => el.ready);
  const id = await view(page).evaluate(async (el) => {
    const handle = await el.openWindow({ width: 300, height: 200, url: 'about:blank' });
    const element = document.createElement('inception-window');
    element.id = 'second';
    element.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 300px; height: 200px; display: block';
    element.view = el;
    element.setAttribute('window', String(handle.id));
    document.body.append(element);
    return handle.id;
  });
  await evaluateIn(page, id, 'document.body.style.background = "rgb(0, 0, 255)"; 1');
  await evaluateIn(page, 1, 'document.body.style.background = "rgb(255, 0, 0)"; 1');
  // Both windows painted: two render targets.
  await expect.poll(() => surfaces(page), { timeout: 20_000 }).toBe(2);
  await page.evaluate(() => document.getElementById('second').remove());
  await expect.poll(() => surfaces(page), { timeout: 10_000 }).toBe(1);
  // Shown again: it paints, with a new target.
  await view(page).evaluate((el, id) => {
    const element = document.createElement('inception-window');
    element.id = 'second';
    element.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 300px; height: 200px; display: block';
    element.view = el;
    element.setAttribute('window', String(id));
    document.body.append(element);
  }, id);
  await expect.poll(() => surfaces(page), { timeout: 20_000 }).toBe(2);
  await expect.poll(() => page.evaluate(async () => {
    const canvas = document.getElementById('second').shadowRoot.querySelector('canvas');
    if (!canvas.width) return null;
    const bitmap = await createImageBitmap(canvas);
    const copy = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    copy.drawImage(bitmap, 0, 0);
    return Array.from(copy.getImageData(20, 20, 1, 1).data.slice(0, 3));
  }), { timeout: 20_000 }).toEqual([0, 0, 255]);
});

test('a headless view shows nothing itself, and its window 1 is shown where it is exported', async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank&headless`);
  await view(page).evaluate((el) => el.ready);
  await evaluateIn(page, 1, 'document.body.style.background = "rgb(0, 128, 0)"; document.title = "headless"; 1');
  expect(await evaluateIn(page, 1, 'document.visibilityState')).toBe('hidden');
  await page.waitForTimeout(500);
  expect(await surfaces(page)).toBe(0);
  expect(await view(page).evaluate((el) => el.shadowRoot.querySelector('canvas').width)).toBe(300);
  // A canvas elsewhere shows window 1 through the display channel.
  await page.evaluate(async () => {
    const { createDisplay } = await import('/host/display.js');
    const canvas = document.createElement('canvas');
    canvas.id = 'elsewhere';
    canvas.style.cssText = 'position: fixed; left: 0; top: 0; width: 320px; height: 240px; display: block';
    document.body.append(canvas);
    window.display = createDisplay(canvas, document.querySelector('inception-view').exportWindow(1));
  });
  await expect.poll(() => evaluateIn(page, 1, 'document.visibilityState')).toBe('visible');
  await expect.poll(() => page.evaluate(async () => {
    const canvas = document.getElementById('elsewhere');
    if (!canvas.width) return null;
    const bitmap = await createImageBitmap(canvas);
    const copy = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    copy.drawImage(bitmap, 0, 0);
    return Array.from(copy.getImageData(20, 20, 1, 1).data.slice(0, 3));
  }), { timeout: 20_000 }).toEqual([0, 128, 0]);
  expect(await evaluateIn(page, 1, 'innerWidth + "x" + innerHeight')).toBe('320x240');
  // The view's own canvas never drew.
  expect(await view(page).evaluate((el) => el.shadowRoot.querySelector('canvas').width)).toBe(300);
});
