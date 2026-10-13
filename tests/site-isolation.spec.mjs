import { expect, test } from '@playwright/test';
import { startRelay } from '../packages/inceptionjs/src/server/index.js';

// isolation 'site': each engine shows one site. A window that navigates to
// another site moves to an engine of that site and keeps its id, display,
// handle and history; the profile service keeps other sites' data from it.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluateIn = (page, window, source) => view(page).evaluate((el, [w, s]) => el.debugEvaluate(s, { window: w }), [window, source]);
const engines = (page) => view(page).evaluate((el) => el.debugEngines());

let relay;
test.beforeAll(async () => {
  relay = await startRelay({ port: 0 });
});
test.afterAll(async () => {
  await relay?.close?.();
});

// `landing`: where `url` ends up (after its redirects).
async function start(page, { url = 'https://example.com/', landing = url, query = '' } = {}) {
  await page.goto(`${PAGE}?url=${encodeURIComponent(url)}&isolation=site&persist=clear&profile=site-${Date.now()}&relay=ws://127.0.0.1:${relay.port}/${query}`);
  await view(page).evaluate((el) => el.ready);
  await waitFor(page, 1, landing);
}

// Waits until window `id` shows `url` (its page finished loading).
async function waitFor(page, id, url) {
  await expect.poll(() => evaluateIn(page, id, 'location.href + " " + document.readyState').catch(() => ''), { timeout: 60_000 }).toBe(`${url} complete`);
}

const state = (page, id = 1) => view(page).evaluate((el, id) => {
  const target = id === 1 ? el : el.window(id);
  return { url: target.url, canGoBack: target.canGoBack, canGoForward: target.canGoForward };
}, id);

async function openWindow(page, url, { show = true, width = 400, height = 300 } = {}) {
  const id = await view(page).evaluate(async (el, [url, show, width, height]) => {
    const handle = await el.openWindow({ width, height, url });
    if (show) {
      const element = document.createElement('inception-window');
      element.id = `window-${handle.id}`;
      element.style.cssText = `position: fixed; right: 0; bottom: 0; z-index: 10; width: ${width}px; height: ${height}px; display: block`;
      element.view = el;
      element.setAttribute('window', String(handle.id));
      document.body.append(element);
    }
    return handle.id;
  }, [url, show, width, height]);
  await waitFor(page, id, url);
  return id;
}

test('window 1 moves to an engine of the site it navigates to, and back and forward cross engines', async ({ page }) => {
  await start(page);
  const first = await engines(page);
  expect(first.map((e) => [e.site, e.windows])).toEqual([['example.com', [1]]]);
  await evaluateIn(page, 1, 'window.mark = "example"; 1');
  await view(page).evaluate((el) => el.navigate('https://www.iana.org/help/example-domains'));
  await waitFor(page, 1, 'https://www.iana.org/help/example-domains');
  // Another engine, and the one it left has stopped.
  const second = await engines(page);
  expect(second.map((e) => [e.site, e.windows])).toEqual([['iana.org', [1]]]);
  expect(second[0].engine).not.toBe(first[0].engine);
  expect(await evaluateIn(page, 1, 'String(window.mark)')).toBe('undefined');
  expect(await state(page)).toMatchObject({ canGoBack: true, canGoForward: false });
  // A navigation inside the site stays in its engine.
  await evaluateIn(page, 1, 'location.href = "https://www.iana.org/domains"; 1');
  await waitFor(page, 1, 'https://www.iana.org/domains');
  expect((await engines(page))[0].engine).toBe(second[0].engine);
  // Back within the site, then back across sites, then forward again.
  await view(page).evaluate((el) => el.back());
  await waitFor(page, 1, 'https://www.iana.org/help/example-domains');
  expect((await engines(page))[0].engine).toBe(second[0].engine);
  await view(page).evaluate((el) => el.back());
  await waitFor(page, 1, 'https://example.com/');
  expect(await state(page)).toMatchObject({ canGoBack: false, canGoForward: true });
  expect((await engines(page))[0].site).toBe('example.com');
  await view(page).evaluate((el) => el.forward());
  await waitFor(page, 1, 'https://www.iana.org/help/example-domains');
  await view(page).evaluate((el) => el.forward());
  await waitFor(page, 1, 'https://www.iana.org/domains');
  expect(await state(page)).toMatchObject({ canGoBack: true, canGoForward: false });
  // A new navigation from the middle of the history drops what was ahead.
  await view(page).evaluate((el) => el.back());
  await waitFor(page, 1, 'https://www.iana.org/help/example-domains');
  await view(page).evaluate((el) => el.navigate('https://example.org/'));
  await waitFor(page, 1, 'https://example.org/');
  expect(await state(page)).toMatchObject({ canGoBack: true, canGoForward: false });
});

test('a link and a form posted to another site arrive in the other site\'s engine', async ({ page }) => {
  await start(page);
  await evaluateIn(page, 1, `document.body.innerHTML = '<form id="f" method="POST" action="https://httpbingo.org/anything"><input name="who" value="from-example"></form>'; document.getElementById('f').submit(); 1`);
  await expect.poll(() => evaluateIn(page, 1, 'location.href').catch(() => ''), { timeout: 60_000 }).toBe('https://httpbingo.org/anything');
  await expect.poll(() => evaluateIn(page, 1, 'document.body?.innerText ?? ""').catch(() => ''), { timeout: 30_000 }).toContain('from-example');
  const echoed = JSON.parse(await evaluateIn(page, 1, 'document.body.innerText'));
  expect(echoed.method).toBe('POST');
  expect(echoed.form).toEqual({ who: ['from-example'] });
  expect((await engines(page)).map((e) => e.site)).toEqual(['httpbingo.org']);
});

test('an opened window moves between engines and its display follows', async ({ page }) => {
  await start(page);
  const id = await openWindow(page, 'https://example.org/');
  const before = await engines(page);
  expect(before.find((e) => e.windows.includes(id)).site).toBe('example.org');
  await view(page).evaluate((el, id) => el.window(id).navigate('https://www.iana.org/help/example-domains'), id);
  await waitFor(page, id, 'https://www.iana.org/help/example-domains');
  const after = await engines(page);
  expect(after.map((e) => [e.site, e.windows]).sort()).toEqual([['example.com', [1]], ['iana.org', [id]]]);
  expect(await view(page).evaluate((el) => el.windows.map((w) => w.window))).toEqual([1, id]);
  // The <inception-window> shows the new engine's page.
  await expect.poll(() => page.evaluate(async (id) => {
    const canvas = document.getElementById(`window-${id}`).shadowRoot.querySelector('canvas');
    if (!canvas.width) return 0;
    const bitmap = await createImageBitmap(canvas);
    const copy = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    copy.drawImage(bitmap, 0, 0);
    const data = copy.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 100) dark++;
    return dark;
  }, id), { timeout: 20_000 }).toBeGreaterThan(100);
  expect(await state(page, id)).toMatchObject({ canGoBack: true });
});

test('another site gets none of the profile\'s cookies from a page of this site', async ({ page }) => {
  await start(page, { url: 'https://httpbingo.org/cookies/set?secret=s3', landing: 'https://httpbingo.org/cookies' });
  // Back on example.com, a credentialed request to httpbingo.org (which
  // answers CORS for any origin) carries no cookie of the profile.
  await view(page).evaluate((el) => el.navigate('https://example.com/'));
  await waitFor(page, 1, 'https://example.com/');
  await evaluateIn(page, 1, `window.seen = 'pending'; fetch('https://httpbingo.org/cookies', { credentials: 'include' }).then((r) => r.json()).then((j) => seen = JSON.stringify(j), (e) => seen = 'failed ' + e.message); 1`);
  await expect.poll(() => evaluateIn(page, 1, 'seen'), { timeout: 30_000 }).not.toBe('pending');
  const cookiesOf = (text) => { const value = JSON.parse(text); return value.cookies ?? value; };
  expect(cookiesOf(await evaluateIn(page, 1, 'seen'))).toEqual({});
  // httpbingo.org's own pages still have it.
  await view(page).evaluate((el) => el.navigate('https://httpbingo.org/cookies'));
  await waitFor(page, 1, 'https://httpbingo.org/cookies');
  expect(cookiesOf(await evaluateIn(page, 1, 'document.body.innerText'))).toEqual({ secret: 's3' });
});

test('a window has one tab, and what a page opens is a window, in the engine of its site', async ({ page }) => {
  await start(page);
  await expect(view(page).evaluate((el) => el.createTab('https://example.com/'))).rejects.toThrow(/one tab/);
  await evaluateIn(page, 1, `document.body.innerHTML = '<a id="go" href="https://www.iana.org/help/example-domains" target="_blank" style="position:fixed;left:0;top:0;width:400px;height:300px;display:block">open</a>'; 1`);
  const box = await view(page).boundingBox();
  await page.mouse.click(box.x + 50, box.y + 50);
  await expect.poll(() => view(page).evaluate((el) => el.windows.length), { timeout: 20_000 }).toBe(2);
  const popup = await view(page).evaluate((el) => el.windows[1].window);
  await waitFor(page, popup, 'https://www.iana.org/help/example-domains');
  const list = await engines(page);
  expect(list.find((e) => e.windows.includes(popup)).site).toBe('iana.org');
  expect(list.find((e) => e.windows.includes(1)).site).toBe('example.com');
  expect(await view(page).evaluate((el) => el.tabs.length)).toBe(1);
});

test('past the engine budget, windows of a site share its engine and sites still never share one', async ({ page }) => {
  await start(page, { query: '&engines=2' });
  const a = await openWindow(page, 'https://example.com/?a', { show: false });
  // Two engines are the budget: a third window of example.com joins the one
  // that shows it; a window of another site still gets its own.
  const shared = await engines(page);
  expect(shared.filter((e) => e.site === 'example.com').length).toBeLessThanOrEqual(2);
  const b = await openWindow(page, 'https://example.com/?b', { show: false });
  const list = await engines(page);
  const ofExample = list.filter((e) => e.site === 'example.com');
  expect(ofExample.flatMap((e) => e.windows).sort()).toEqual([1, a, b].sort());
  expect(ofExample.length).toBe(2);
  const c = await openWindow(page, 'https://example.org/?c', { show: false });
  const withOther = await engines(page);
  expect(withOther.find((e) => e.windows.includes(c)).site).toBe('example.org');
  expect(withOther.find((e) => e.windows.includes(c)).windows).toEqual([c]);
});
