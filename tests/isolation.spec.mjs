import { expect, test } from '@playwright/test';
import { requirePersistentStorage } from './persistence.mjs';

// isolation 'window': a profile service holds the profile, the view's
// window 1 and every window opened with openWindow() run in engines of
// their own, and they share cookies, storage, IndexedDB and history.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluateIn = (page, window, source) => view(page).evaluate((el, [w, s]) => el.debugEvaluate(s, { window: w }), [window, source]);

async function start(page, query = '') {
  await page.goto(`${PAGE}?url=about:blank&isolation=window&persist=clear&profile=isolation-${Date.now()}${query}`);
  await view(page).evaluate((el) => el.ready);
}

async function openWindow(page, { show = true, width = 400, height = 300, url = 'about:blank' } = {}) {
  return view(page).evaluate(async (el, [show, width, height, url]) => {
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
  }, [show, width, height, url]);
}

async function navigate(page, window, url) {
  await view(page).evaluate((el, [w, u]) => (w === 1 ? el.navigate(u) : el.window(w).navigate(u)), [window, url]);
  await expect.poll(() => evaluateIn(page, window, 'location.href + " " + document.readyState'), { timeout: 60_000 }).toBe(`${url} complete`);
}

test('window 1 and an opened window run in separate engines of one profile', async ({ page }) => {
  await start(page);
  const second = await openWindow(page);
  expect(second).toBe(2);
  await navigate(page, 1, 'https://example.com/');
  await navigate(page, second, 'https://example.com/?second');
  // Separate engines: script state is not shared, a global set in one is
  // absent in the other.
  await evaluateIn(page, 1, 'window.mark = "one"; 1');
  expect(await evaluateIn(page, second, 'String(window.mark)')).toBe('undefined');
  // One profile: cookies, localStorage with its events, IndexedDB, history.
  await evaluateIn(page, second, 'window.seen = ""; addEventListener("storage", (e) => { seen = e.key + "=" + e.newValue; }); localStorage.length');
  await evaluateIn(page, 1, 'document.cookie = "shared=yes; path=/"; localStorage.setItem("color", "teal"); "ok"');
  await expect.poll(() => evaluateIn(page, second, 'document.cookie')).toContain('shared=yes');
  await expect.poll(() => evaluateIn(page, second, 'seen')).toBe('color=teal');
  await evaluateIn(page, 1, `window.idb = "pending"; const r = indexedDB.open("shared", 1); r.onupgradeneeded = () => r.result.createObjectStore("s"); r.onsuccess = () => { const t = r.result.transaction("s", "readwrite"); t.objectStore("s").put("from one", "k"); t.oncomplete = () => { r.result.close(); idb = "written"; }; }; "ok"`);
  await expect.poll(() => evaluateIn(page, 1, 'idb')).toBe('written');
  await evaluateIn(page, second, `window.idb = "pending"; const r = indexedDB.open("shared", 1); r.onsuccess = () => { const g = r.result.transaction("s").objectStore("s").get("k"); g.onsuccess = () => { idb = String(g.result); r.result.close(); }; }; "ok"`);
  await expect.poll(() => evaluateIn(page, second, 'idb')).toBe('from one');
  const visited = await view(page).evaluate((el) => el.history({ limit: 20 }).then((entries) => entries.map((e) => e.url)));
  expect(visited).toContain('https://example.com/');
  expect(visited).toContain('https://example.com/?second');
});

test('each window paints its own page', async ({ page }) => {
  await start(page);
  const second = await openWindow(page);
  const colored = (color) => `document.open(); document.write('<title>${color}</title><style>html,body{margin:0;height:100%;background:${color}}</style>'); document.close(); document.title`;
  await expect.poll(() => evaluateIn(page, 1, colored('rgb(255, 0, 0)')), { timeout: 30_000 }).toBe('rgb(255, 0, 0)');
  await expect.poll(() => evaluateIn(page, second, colored('rgb(0, 0, 255)')), { timeout: 30_000 }).toBe('rgb(0, 0, 255)');
  const pixel = (window) => page.evaluate(async (window) => {
    const host = window === 1 ? document.querySelector('inception-view') : document.getElementById(`window-${window}`);
    const canvas = host.shadowRoot.querySelector('canvas');
    if (!canvas.width) return null;
    const bitmap = await createImageBitmap(canvas);
    const copy = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    copy.drawImage(bitmap, 0, 0);
    return Array.from(copy.getImageData(10, 10, 1, 1).data.slice(0, 3));
  }, window);
  await expect.poll(() => pixel(1), { timeout: 20_000 }).toEqual([255, 0, 0]);
  await expect.poll(() => pixel(second), { timeout: 20_000 }).toEqual([0, 0, 255]);
});

test('a crash in one window\'s engine takes only its windows down', async ({ page }) => {
  await start(page);
  const second = await openWindow(page);
  const third = await openWindow(page, { show: false });
  await navigate(page, 1, 'https://example.com/');
  await view(page).evaluate((el) => { window.viewCrashes = 0; el.addEventListener('crash', () => window.viewCrashes++); });
  const crashed = page.evaluate((id) => new Promise((resolve) => document.querySelector('inception-view').window(id).addEventListener('crash', (e) => resolve(e.detail), { once: true })), second);
  await view(page).evaluate((el, id) => el.debugCommand('debug.crash', { window: id }), second);
  expect((await crashed).windows).toEqual([second]);
  await expect.poll(() => view(page).evaluate((el) => el.windows.map((w) => w.window))).toEqual([1, third]);
  expect(await evaluateIn(page, 1, 'location.host')).toBe('example.com');
  expect(await evaluateIn(page, third, '"alive"')).toBe('alive');
  expect(await page.evaluate(() => window.viewCrashes)).toBe(0);
});

test('closing a window stops its engine; the service and the other windows stay', async ({ page }) => {
  await start(page);
  const second = await openWindow(page);
  await navigate(page, second, 'https://example.com/');
  await evaluateIn(page, second, 'localStorage.setItem("before", "close"); "ok"');
  await view(page).evaluate((el, id) => el.window(id).close(), second);
  await expect.poll(() => view(page).evaluate((el) => el.windows.map((w) => w.window))).toEqual([1]);
  await navigate(page, 1, 'https://example.com/?after');
  expect(await evaluateIn(page, 1, 'localStorage.getItem("before")')).toBe('close');
  const third = await openWindow(page);
  expect(third).toBeGreaterThan(second);
  await navigate(page, third, 'https://example.com/?third');
  expect(await evaluateIn(page, third, 'localStorage.getItem("before")')).toBe('close');
});

test('the profile service restarts after a crash and every window gets its profile back', async ({ page }) => {
  await requirePersistentStorage(test, page);
  await start(page);
  const second = await openWindow(page);
  await navigate(page, 1, 'https://example.org/');
  await navigate(page, second, 'https://example.org/?second');
  await evaluateIn(page, 1, 'document.cookie = "kept=yes; max-age=3600; path=/"; localStorage.setItem("kept", "yes"); "ok"');
  await expect.poll(() => evaluateIn(page, second, 'document.cookie')).toContain('kept=yes');
  const restarted = view(page).evaluate((el) => el.debugProfileService().then((service) => new Promise((resolve) => {
    service.addEventListener('restart', () => resolve(true), { once: true });
    service.send('debug.crash');
  })));
  expect(await restarted).toBe(true);
  // Pages loaded after the restart load through the new service.
  await navigate(page, second, 'https://example.org/?again');
  expect(await evaluateIn(page, second, 'document.cookie + " " + localStorage.getItem("kept")')).toBe('kept=yes yes');
});

test('a window opened with a host list reaches only those hosts; the others are not limited', async ({ page }) => {
  await start(page);
  const limited = await view(page).evaluate(async (el) => (await el.openWindow({ width: 300, height: 200, hosts: { allow: ['example.com'] } })).id);
  await navigate(page, limited, 'https://example.com/');
  const fetchFrom = (window, url) => evaluateIn(page, window, `window.out = 'pending'; fetch(${JSON.stringify(url)}, { mode: "no-cors" }).then(() => out = 'loaded', () => out = 'refused'); 1`)
    .then(() => expect.poll(() => evaluateIn(page, window, 'out'), { timeout: 30_000 }).not.toBe('pending'))
    .then(() => evaluateIn(page, window, 'out'));
  expect(await fetchFrom(limited, 'https://example.org/')).toBe('refused');
  await navigate(page, 1, 'https://example.com/');
  expect(await fetchFrom(1, 'https://example.org/')).toBe('loaded');
});

test('a window that never read localStorage still hears another window\'s change', async ({ page }) => {
  await start(page);
  const second = await openWindow(page);
  await navigate(page, 1, 'https://example.com/');
  await navigate(page, second, 'https://example.com/?second');
  await evaluateIn(page, second, 'window.seen = ""; addEventListener("storage", (e) => { seen = e.key + "=" + e.newValue; }); "ok"');
  await evaluateIn(page, 1, 'localStorage.setItem("fresh", "yes"); "ok"');
  await expect.poll(() => evaluateIn(page, second, 'seen')).toBe('fresh=yes');
  expect(await evaluateIn(page, second, 'localStorage.getItem("fresh")')).toBe('yes');
});
