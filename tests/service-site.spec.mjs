import { expect, test } from '@playwright/test';
import { startRelay } from '../packages/inceptionjs/src/server/index.js';

// A link locked to one site (isolation 'site'): the profile service keeps
// other sites' data from the content engine, whatever that engine asks. The
// engine here is made to ask as a subverted one would (debug.rawLoad goes
// straight to the link, past WebCore's own checks), or shows a page of a site
// its link is not locked to.
const harness = (page, method, ...args) => page.evaluate(([method, args]) => window.harness[method](...args), [method, args]);
const evaluate = (page, index, source) => harness(page, 'evaluate', index, source);

let relay;
test.beforeAll(async () => {
  relay = await startRelay({ port: 0 });
});
test.afterAll(async () => {
  await relay?.close?.();
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.harness?.stop()).catch(() => {});
});

async function open(page) {
  await page.goto(`/tests/fixtures/profile-service.html?relay=ws://127.0.0.1:${relay.port}/`);
  await page.waitForFunction(() => window.harness);
  await harness(page, 'startService');
}

async function content(page, policy = null) {
  const index = await harness(page, 'startContent');
  const link = await harness(page, 'connect', index);
  if (policy) await harness(page, 'serviceSend', 'link.policy', { link, ...policy });
  return index;
}

// A load made on the link itself: what the service hands the engine.
const rawLoad = (page, index, args) => page.evaluate(([index, args]) => new Promise((resolve) => {
  const runtime = window.harness.runtimeOf(index);
  const id = Math.random();
  const listener = (e) => {
    if (e.detail.id !== id) return;
    runtime.removeEventListener('debug.rawLoad.result', listener);
    resolve(e.detail);
  };
  runtime.addEventListener('debug.rawLoad.result', listener);
  runtime.send('debug.rawLoad', { id, ...args });
}), [index, args]);

// Runs `source` (an async function body) in the engine's page; JSON result.
const run = (page, index, source) => page.evaluate(async ([index, source]) => {
  await window.harness.evaluate(index, `window.__r = undefined; (async () => { ${source} })().then((v) => __r = JSON.stringify(v), (e) => __r = 'ERR ' + e.message); 1`);
  for (let i = 0; i < 120; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const value = await window.harness.evaluate(index, 'String(window.__r)');
    if (value !== 'undefined') return value.startsWith('ERR') ? value : JSON.parse(value);
  }
  return 'timeout';
}, [index, source]);

test('requests of a site-locked link carry no cookies of other sites; its own site keeps them', async ({ page }) => {
  await open(page);
  const free = await content(page);
  // The profile gets a cookie of httpbingo.org.
  await harness(page, 'navigate', free, 'https://httpbingo.org/cookies/set?secret=s3', 'location.pathname === "/cookies" && document.readyState === "complete"');
  const sent = (result) => JSON.parse(result.text || '{}').cookies ?? JSON.parse(result.text || '{}');
  const unlocked = await rawLoad(page, free, { url: 'https://httpbingo.org/cookies', mode: 'navigate' });
  expect(sent(unlocked)).toEqual({ secret: 's3' });
  // Locked to example.com: httpbingo.org is another site, so the service
  // sends none of its cookies, whatever first party the engine claims.
  const other = await content(page, { site: 'example.com' });
  const asked = await rawLoad(page, other, { url: 'https://httpbingo.org/cookies', mode: 'navigate', firstParty: 'https://httpbingo.org/' });
  expect(asked.status).toBe(200);
  expect(sent(asked)).toEqual({});
  // Locked to httpbingo.org: its own cookies go with its requests.
  const own = await content(page, { site: 'httpbingo.org' });
  expect(sent(await rawLoad(page, own, { url: 'https://httpbingo.org/cookies', mode: 'navigate' }))).toEqual({ secret: 's3' });
  // With thirdParty 'allow' the embedder hands other sites their cookies again.
  const allowed = await content(page, { site: 'example.com', thirdParty: 'allow' });
  expect(sent(await rawLoad(page, allowed, { url: 'https://httpbingo.org/cookies', mode: 'navigate' }))).toEqual({ secret: 's3' });
});

test('responses of other sites that only a reader would want arrive empty at a site-locked link', async ({ page }) => {
  await open(page);
  const locked = await content(page, { site: 'example.com' });
  const free = await content(page);
  const cases = {
    json: { url: 'https://httpbingo.org/json', mode: 'no-cors' },
    html: { url: 'https://httpbingo.org/html', mode: 'no-cors' },
    jsonAsText: { url: 'https://httpbingo.org/response-headers?Content-Type=text/plain', mode: 'no-cors' },
    image: { url: 'https://httpbingo.org/image/png', mode: 'no-cors' },
    plainText: { url: 'https://httpbingo.org/robots.txt', mode: 'no-cors' },
    corsOpened: { url: 'https://httpbingo.org/get', mode: 'cors', origin: 'https://example.com' },
    corsClosed: { url: 'https://example.org/', mode: 'cors', origin: 'https://example.com' },
    frame: { url: 'https://example.org/', mode: 'navigate' },
  };
  const lockedResults = {};
  const freeResults = {};
  for (const [name, args] of Object.entries(cases)) {
    lockedResults[name] = await rawLoad(page, locked, args);
    freeResults[name] = await rawLoad(page, free, args);
  }
  // A link without a lock gets everything, as before.
  for (const name of Object.keys(cases)) expect(freeResults[name].length, name).toBeGreaterThan(0);
  for (const name of ['json', 'html', 'jsonAsText', 'corsClosed']) {
    expect(lockedResults[name].length, name).toBe(0);
    expect(lockedResults[name].status, name).toBe(200);
  }
  for (const name of ['image', 'plainText', 'corsOpened', 'frame']) expect(lockedResults[name].length, name).toBe(freeResults[name].length);
  // Its own site is not filtered.
  expect((await rawLoad(page, locked, { url: 'https://example.com/', mode: 'no-cors' })).length).toBeGreaterThan(0);
});

test('a page of another site in a site-locked engine gets none of the profile\'s cookies, localStorage or IndexedDB', async ({ page }) => {
  await open(page);
  const free = await content(page);
  await harness(page, 'navigate', free, 'https://example.com/');
  await evaluate(page, free, 'document.cookie = "kept=1; max-age=3600; path=/"; localStorage.setItem("kept", "yes"); 1');
  await run(page, free, `await new Promise((resolve) => { const r = indexedDB.open('kept', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { const t = r.result.transaction('s', 'readwrite'); t.objectStore('s').put('v', 'k'); t.oncomplete = resolve; }; }); return 'ok';`);
  // The engine shows example.com but its link is locked to example.org: a
  // subverted engine that ignores its lock gets this.
  const stray = await content(page, { site: 'example.org' });
  await harness(page, 'navigate', stray, 'https://example.com/?stray');
  const seen = await run(page, stray, `
    const cookie = document.cookie;
    const stored = localStorage.getItem('kept');
    localStorage.setItem('written', 'by-stray');
    document.cookie = 'stray=1; max-age=3600; path=/';
    const db = await new Promise((resolve) => { const r = indexedDB.open('kept'); r.onsuccess = () => resolve('opened'); r.onerror = () => resolve('refused'); });
    const names = await indexedDB.databases().then((list) => list.map((d) => d.name), () => 'refused');
    return { cookie, stored, local: localStorage.getItem('written'), db, names };`);
  expect(seen.cookie).toBe('');
  expect(seen.stored).toBe(null);
  // Its own writes stay in its page, as a partitioned area's would.
  expect(seen.local).toBe('by-stray');
  expect(seen.db).toBe('refused');
  expect(seen.names).toEqual([]);
  // Nothing it wrote reached the profile.
  await page.waitForTimeout(500);
  const profile = await run(page, free, `return [document.cookie, localStorage.getItem('written')];`);
  expect(profile).toEqual(['kept=1', null]);
});
