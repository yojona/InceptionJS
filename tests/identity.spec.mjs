import { expect, test } from '@playwright/test';

const PAGE = process.env.PAGE_PATH ?? '/';

const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);
const read = async (page) => JSON.parse(await evaluate(page, `JSON.stringify({
  userAgent: navigator.userAgent, platform: navigator.platform, languages: navigator.languages,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  dark: matchMedia('(prefers-color-scheme: dark)').matches,
  userAgentData: 'userAgentData' in navigator })`));

test.use({ locale: 'es-MX', timezoneId: 'America/Hermosillo', colorScheme: 'dark' });

test.beforeEach(async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  await view(page).evaluate((el) => el.ready);
});

test('the page sees WebKit on the host platform, with the InceptionJS token', async ({ page }) => {
  const seen = await read(page);
  expect(seen.userAgent).toMatch(/^Mozilla\/5\.0 \(.+\) AppleWebKit\/605\.1\.15 \(KHTML, like Gecko\) Version\/18\.0 .*Safari\/[\d.]+ InceptionJS\/\S+$/);
  const expected = { MacIntel: 'Macintosh', Win32: 'Windows', 'Linux x86_64': 'X11; Linux' };
  expect(seen.userAgent).toContain(expected[seen.platform]);
  expect(seen.userAgentData).toBe(false);
});

test('preferences follow the host unless set', async ({ page }) => {
  let seen = await read(page);
  expect(seen.languages[0]).toBe('es-MX');
  expect(seen.timeZone).toBe('America/Hermosillo');
  await view(page).evaluate((el) => { el.preferences = { languages: ['en-GB'], timeZone: 'Europe/Madrid' }; });
  await expect.poll(async () => { seen = await read(page); return [seen.languages[0], seen.timeZone]; }).toEqual(['en-GB', 'Europe/Madrid']);
});

test('the color scheme follows the host unless set', async ({ page }) => {
  expect((await read(page)).dark).toBe(true);
  await view(page).evaluate((el) => { el.preferences = { colorScheme: 'light' }; });
  await expect.poll(async () => (await read(page)).dark).toBe(false);
});

test('navigator.inception names the engine, read-only, in every frame', async ({ page }) => {
  await page.goto(`${PAGE}?url=https://example.com/`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => evaluate(page, 'location.host + " " + document.readyState'), { timeout: 30_000 }).toBe('example.com complete');
  const result = JSON.parse(await evaluate(page, `(() => {
    const signal = navigator.inception;
    try { navigator.inception = null; } catch {}
    try { signal.engine = 'x'; } catch {}
    const frame = document.createElement('iframe');
    document.body.append(frame);
    return JSON.stringify({ signal, frozen: Object.isFrozen(signal), same: navigator.inception === signal, ownKey: Object.keys(navigator).includes('inception'), inFrame: frame.contentWindow.navigator.inception?.engine ?? null });
  })()`));
  expect(result).toEqual({ signal: { engine: 'InceptionJS', version: expect.stringMatching(/^\d+\.\d+/) }, frozen: true, same: true, ownKey: false, inFrame: 'InceptionJS' });
});
