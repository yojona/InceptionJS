import { expect, test } from '@playwright/test';

// Cookies of a profile with a service: one store, in the service; content
// engines keep a copy per host (without HttpOnly cookies), read it without
// waiting after the first time, and hear every change.
const harness = (page, method, ...args) => page.evaluate(([method, args]) => window.harness[method](...args), [method, args]);
const evaluate = (page, index, source) => harness(page, 'evaluate', index, source);

async function open(page, contents = 2) {
  await page.goto('/tests/fixtures/profile-service.html');
  await page.waitForFunction(() => window.harness);
  await harness(page, 'startService');
  const indexes = [];
  for (let i = 0; i < contents; i++) {
    const index = await harness(page, 'startContent');
    await harness(page, 'connect', index);
    indexes.push(index);
  }
  return indexes;
}

async function run(page, index, source, timeout = 60_000) {
  const key = `r${Math.random().toString(36).slice(2)}`;
  await evaluate(page, index, `window.${key} = undefined; (async () => { ${source} })().then((v) => { window.${key} = JSON.stringify({ value: v }); }, (e) => { window.${key} = JSON.stringify({ error: String(e && e.message || e) }); }); "started"`);
  let text = 'undefined';
  await expect.poll(async () => (text = await evaluate(page, index, `String(window.${key})`)), { timeout }).not.toBe('undefined');
  return JSON.parse(text);
}

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.harness?.stop()).catch(() => {});
});

test('a cookie script sets in one content engine reaches the other, before and after it looked', async ({ page }) => {
  const [first, second] = await open(page);
  await harness(page, 'navigate', first, 'https://example.com/');
  await harness(page, 'navigate', second, 'https://example.com/');
  // The second engine holds the host's cookies already (none).
  expect(await evaluate(page, second, 'document.cookie')).toBe('');
  await evaluate(page, first, 'document.cookie = "early=1; path=/"; "ok"');
  expect(await evaluate(page, first, 'document.cookie')).toBe('early=1');
  await expect.poll(() => evaluate(page, second, 'document.cookie')).toBe('early=1');
  // And both ways.
  await evaluate(page, second, 'document.cookie = "early=; max-age=0; path=/"; document.cookie = "late=2; path=/"; "ok"');
  await expect.poll(() => evaluate(page, first, 'document.cookie')).toBe('late=2');
  // A third engine that never looked gets the current list on first read.
  const third = await harness(page, 'startContent');
  await harness(page, 'connect', third);
  await harness(page, 'navigate', third, 'https://example.com/?third');
  expect(await evaluate(page, third, 'document.cookie')).toBe('late=2');
});

test('a cookie a response sets is the service\'s, and every content engine sees it', async ({ page }) => {
  const [first, second] = await open(page);
  await harness(page, 'navigate', first, 'https://httpbingo.org/html');
  await harness(page, 'navigate', second, 'https://httpbingo.org/html');
  expect(await evaluate(page, second, 'document.cookie')).toBe('');
  const sent = await run(page, first, `await fetch('/response-headers?Set-Cookie=' + encodeURIComponent('fromserver=3; Path=/')); return (await (await fetch('/cookies')).json()).cookies;`);
  expect(sent.value).toMatchObject({ fromserver: '3' });
  await expect.poll(() => evaluate(page, first, 'document.cookie')).toBe('fromserver=3');
  await expect.poll(() => evaluate(page, second, 'document.cookie')).toBe('fromserver=3');
});

test('HttpOnly cookies go with requests but never reach a content engine', async ({ page }) => {
  const [first, second] = await open(page);
  await harness(page, 'navigate', first, 'https://httpbingo.org/html');
  const result = await run(page, first, `await fetch('/cookies/set?secret=s3'); return (await (await fetch('/cookies')).json()).cookies;`);
  expect(result.value).toMatchObject({ secret: 's3' });
  expect(await evaluate(page, first, 'document.cookie')).not.toContain('secret');
  await harness(page, 'navigate', second, 'https://httpbingo.org/html');
  expect(await evaluate(page, second, 'document.cookie')).not.toContain('secret');
  // Script cannot overwrite it either: the service keeps the HttpOnly one.
  await evaluate(page, second, 'document.cookie = "secret=forged; path=/"; "ok"');
  const after = await run(page, second, `return (await (await fetch('/cookies')).json()).cookies;`);
  expect(after.value.secret).toBe('s3');
});

test('cookies outlive a service crash; content engines ask again after it restarts', async ({ page }) => {
  const [first, second] = await open(page);
  await harness(page, 'navigate', first, 'https://example.org/');
  await evaluate(page, first, 'document.cookie = "kept=yes; max-age=3600; path=/"; "ok"');
  await harness(page, 'navigate', second, 'https://example.org/');
  expect(await evaluate(page, second, 'document.cookie')).toBe('kept=yes');
  const restarted = page.evaluate(() => window.harness.waitRestart());
  await harness(page, 'crashService');
  // Until it is back, pages read what their engine held.
  expect(await evaluate(page, second, 'document.cookie')).toBe('kept=yes');
  await restarted;
  await harness(page, 'connect', first);
  await harness(page, 'connect', second);
  expect(await evaluate(page, second, 'document.cookie')).toBe('kept=yes');
  expect(await evaluate(page, first, 'document.cookie')).toBe('kept=yes');
});
