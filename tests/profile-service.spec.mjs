import { expect, test } from '@playwright/test';

// A profile service and content engines joined to it by links: roles, the
// transport (asynchronous over ports, waiting calls over shared memory),
// one compiled module for every engine of the document, and what happens to
// links when an engine on either side crashes.
const harness = (page, method, ...args) => page.evaluate(([method, args]) => window.harness[method](...args), [method, args]);

async function open(page) {
  await page.goto('/tests/fixtures/profile-service.html');
  await page.waitForFunction(() => window.harness);
}

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.harness?.stop()).catch(() => {});
});

test('a service and two content engines start from one compiled module', async ({ page }) => {
  await open(page);
  const service = await harness(page, 'startService');
  expect(service.role).toBe('profile');
  expect(service.features).toContain('roles');
  const first = await harness(page, 'startContent');
  const second = await harness(page, 'startContent');
  expect((await harness(page, 'content', first)).ready.role).toBe('content');
  expect((await harness(page, 'content', second)).ready.role).toBe('content');
  // Three engines, one download of each file.
  const fetches = await harness(page, 'fetches');
  expect(fetches.filter((name) => name.endsWith('.wasm'))).toHaveLength(1);
  expect(fetches.filter((name) => name.endsWith('.data'))).toHaveLength(1);
  // Each content engine still runs its own pages.
  expect(await harness(page, 'evaluate', first, '1 + 1')).toBe('2');
  expect(await harness(page, 'evaluate', second, '"two"')).toBe('two');
});

test('messages cross a link both ways, waiting or not, small and large', async ({ page }) => {
  await open(page);
  await harness(page, 'startService');
  const content = await harness(page, 'startContent');
  // No link yet: calls fail at once rather than wait.
  expect((await harness(page, 'ping', content, { sync: true })).ok).toBe(false);
  await harness(page, 'connect', content);
  for (const sync of [false, true]) {
    for (const bytes of [0, 16, 64 * 1024, 3 * 1024 * 1024 + 17]) {
      const result = await harness(page, 'ping', content, { bytes, sync });
      expect(result, `${sync ? 'waiting' : 'asynchronous'} call of ${bytes} bytes`).toMatchObject({ ok: true, bytes });
    }
  }
});

test('two content engines have links of their own', async ({ page }) => {
  await open(page);
  await harness(page, 'startService');
  const first = await harness(page, 'startContent');
  const second = await harness(page, 'startContent');
  const links = [await harness(page, 'connect', first), await harness(page, 'connect', second)];
  expect(links[0]).not.toBe(links[1]);
  const results = await Promise.all([
    harness(page, 'ping', first, { bytes: 200000, sync: true }),
    harness(page, 'ping', second, { bytes: 200000 }),
    harness(page, 'ping', first, { bytes: 1000 }),
    harness(page, 'ping', second, { bytes: 1500000, sync: true }),
  ]);
  expect(results.map((r) => r.ok)).toEqual([true, true, true, true]);
});

test('a content engine that crashes leaves the service and the other engine working', async ({ page }) => {
  await open(page);
  await harness(page, 'startService');
  const first = await harness(page, 'startContent');
  const second = await harness(page, 'startContent');
  await harness(page, 'connect', first);
  await harness(page, 'connect', second);
  await harness(page, 'crashContent', first);
  expect((await harness(page, 'ping', second, { sync: true })).ok).toBe(true);
  expect((await harness(page, 'ping', second)).ok).toBe(true);
  expect(await harness(page, 'evaluate', second, '"alive"')).toBe('alive');
});

test('a service that crashes fails waiting calls, starts again and takes new links', async ({ page }) => {
  await open(page);
  await harness(page, 'startService');
  const content = await harness(page, 'startContent');
  await harness(page, 'connect', content);
  expect((await harness(page, 'ping', content, { sync: true })).ok).toBe(true);
  const restarted = page.evaluate(() => window.harness.waitRestart());
  await harness(page, 'crashService');
  // The content engine is not left waiting: its calls fail, it keeps running.
  const after = await harness(page, 'ping', content, { sync: true });
  expect(after.ok).toBe(false);
  expect(await harness(page, 'evaluate', content, '"still here"')).toBe('still here');
  expect((await harness(page, 'content', content)).closedReason).toBe('crash');
  await restarted;
  await harness(page, 'connect', content);
  expect((await harness(page, 'ping', content, { sync: true })).ok).toBe(true);
  expect((await harness(page, 'ping', content, { bytes: 100000 })).ok).toBe(true);
});
