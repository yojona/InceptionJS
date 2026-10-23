import { expect, test } from '@playwright/test';

// A view whose engine cannot start lets go of the profile: another tab opens
// it at once instead of waiting on a host that will never answer.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');

test('a tab whose engine fails to start does not keep the profile from another tab', async ({ context }) => {
  const profile = `failed-start-${Date.now()}`;
  const broken = await context.newPage();
  await broken.route('**/inception-engine.js', (route) => route.fulfill({ status: 404, body: 'gone' }));
  await broken.goto(`${PAGE}?url=about:blank&profile=${profile}`);
  const failure = await view(broken).evaluate((el) => el.ready.then(() => 'ready', (error) => error.message));
  expect(failure).not.toBe('ready');

  const healthy = await context.newPage();
  await healthy.goto(`${PAGE}?url=about:blank&profile=${profile}`);
  const started = Date.now();
  const role = await view(healthy).evaluate(async (el) => { await el.ready; return el.dataset.role; });
  expect(role).toBe('host');
  expect(Date.now() - started).toBeLessThan(30_000);
});
