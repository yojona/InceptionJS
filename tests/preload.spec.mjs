import { expect, test } from '@playwright/test';

// Inception.preload() fetches and compiles the engine ahead of the first view,
// which then starts from what was preloaded.
const PAGE = process.env.PAGE_PATH ?? '/';

test('preload fetches the engine once, and a view started afterwards uses it', async ({ page }) => {
  const fetched = [];
  page.on('request', (request) => {
    if (/inception-engine\.(wasm|data)$/.test(request.url())) fetched.push(new URL(request.url()).pathname);
  });
  await page.goto(`${PAGE}?url=about:blank`);
  await page.locator('inception-view').evaluate((el) => el.ready);
  const before = fetched.length;
  const outcome = await page.evaluate(async () => {
    const { Inception } = await import('/host/inception-view.js');
    const view = document.querySelector('inception-view');
    const engineUrl = new URL('/engine/inception-engine.js', location.href).href;
    await Inception.preload({ engineUrl });
    // A second view of another profile starts a second engine from the same files.
    const second = document.createElement('inception-view');
    second.setAttribute('profile', `preload-${Date.now()}`);
    second.setAttribute('src', 'about:blank');
    second.style.cssText = 'width: 200px; height: 150px';
    document.body.append(second);
    await second.ready;
    return { first: view.dataset.renderer, second: second.dataset.renderer };
  });
  expect(outcome.second).toBeTruthy();
  // The page's own view already loaded the engine: neither the preload nor the
  // second view fetched it again.
  expect(fetched.length).toBe(before);
});

test('preload without an engine URL says so', async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  const message = await page.evaluate(async () => {
    const { Inception } = await import('/host/inception-view.js');
    return Inception.preload({ engineUrl: '' }).then(() => 'resolved', (error) => error.message);
  });
  expect(message).toMatch(/no engineUrl/);
});
