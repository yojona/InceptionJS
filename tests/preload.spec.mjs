import { expect, test } from '@playwright/test';

// Inception.preload() fetches and compiles the engine ahead of the first view,
// which then starts from what was preloaded.
const PAGE = process.env.PAGE_PATH ?? '/';

test('preload fetches the engine once, and a view started afterwards uses it', async ({ page }) => {
  const fetched = [];
  page.on('request', (request) => {
    if (/inception-engine\.(wasm|data)$/.test(request.url())) fetched.push(new URL(request.url()).pathname);
  });
  // A page with no view yet: nothing has loaded the engine.
  await page.goto('/tests/fixtures/preload.html');
  await page.evaluate(async () => {
    const { Inception } = await import('/host/inception-view.js');
    window.Inception = Inception;
    await Inception.preload({ engineUrl: '/engine/inception-engine.js' });
  });
  expect(fetched.sort()).toEqual(['/engine/inception-engine.data', '/engine/inception-engine.wasm']);
  const renderer = await page.evaluate(async () => {
    window.Inception.configure({ engineUrl: new URL('/engine/inception-engine.js', location.href).href, relayUrl: 'ws://127.0.0.1:5001/' });
    const view = document.createElement('inception-view');
    view.setAttribute('src', 'about:blank');
    view.setAttribute('profile', `preload-${Date.now()}`);
    document.body.append(view);
    await view.ready;
    return view.dataset.renderer;
  });
  expect(renderer).toBeTruthy();
  // The view started from what preload fetched.
  expect(fetched).toHaveLength(2);
});

test('preload without an engine URL says so', async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  const message = await page.evaluate(async () => {
    const { Inception } = await import('/host/inception-view.js');
    return Inception.preload({ engineUrl: '' }).then(() => 'resolved', (error) => error.message);
  });
  expect(message).toMatch(/no engineUrl/);
});
