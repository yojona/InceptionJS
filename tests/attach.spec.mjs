import { expect, test } from '@playwright/test';

// Documents of one site sharing a profile: the one that holds the profile's
// lock runs the engine (the host); the others attach and show windows of it
// (clients), and take the profile over one after another when the host goes
// away.
const PAGE = process.env.ATTACH_PAGE ?? '/examples/attach.html';
const view = (page) => page.locator('inception-view');
const profileName = () => `attach-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const evaluateIn = (host, window, source) => view(host).evaluate((el, [w, s]) => el.debugEvaluate(s, { window: w }), [window, source]);

async function open(context, profile, query = '') {
  const page = await context.newPage();
  await page.goto(`${PAGE}?profile=${profile}${query}`);
  return page;
}

// Waits for the view to start and returns its role and the id of its window on the host.
async function started(page) {
  return view(page).evaluate((el) => el.ready.then(() => ({ role: el.role, window: el.windowId })));
}

const loaded = (host, window, url) => expect.poll(() => evaluateIn(host, window, 'location.href + " " + document.readyState'), { timeout: 60_000 }).toBe(`${url} complete`);

for (const isolation of ['shared', 'window']) {
  test.describe(`isolation ${isolation}`, () => {
    test('a second tab attaches and shares cookies, storage and IndexedDB with the first', async ({ context }) => {
      const profile = profileName();
      const first = await open(context, profile, `&isolation=${isolation}&persist=clear&url=https://example.com/`);
      expect(await started(first)).toEqual({ role: 'host', window: 1 });
      const second = await open(context, profile, `&isolation=${isolation}&url=https://example.com/?second`);
      const { role, window: id } = await started(second);
      expect(role).toBe('client');
      expect(id).toBeGreaterThan(1);
      await loaded(first, 1, 'https://example.com/');
      await loaded(first, id, 'https://example.com/?second');
      expect(await view(first).evaluate((el) => el.windows.map((w) => w.window))).toEqual([1, id]);
      expect(await view(second).evaluate((el) => el.url)).toBe('https://example.com/?second');

      // Cookies and localStorage, both ways, with a storage event.
      await evaluateIn(first, id, 'window.seen = ""; addEventListener("storage", (e) => { seen = e.key + "=" + e.newValue; }); localStorage.length');
      await evaluateIn(first, 1, 'document.cookie = "shared=yes; path=/"; localStorage.setItem("color", "teal"); "ok"');
      await expect.poll(() => evaluateIn(first, id, 'document.cookie')).toContain('shared=yes');
      await expect.poll(() => evaluateIn(first, id, 'seen')).toBe('color=teal');
      await evaluateIn(first, id, 'document.cookie = "back=yes; path=/"; "ok"');
      await expect.poll(() => evaluateIn(first, 1, 'document.cookie')).toContain('back=yes');

      // IndexedDB written by the attached window, read by the host's.
      await evaluateIn(first, id, `window.idb = "pending"; const r = indexedDB.open("shared", 1); r.onupgradeneeded = () => r.result.createObjectStore("s"); r.onsuccess = () => { const t = r.result.transaction("s", "readwrite"); t.objectStore("s").put("from the second tab", "k"); t.oncomplete = () => { r.result.close(); idb = "written"; }; }; "ok"`);
      await expect.poll(() => evaluateIn(first, id, 'idb')).toBe('written');
      await evaluateIn(first, 1, `window.idb = "pending"; const r = indexedDB.open("shared", 1); r.onsuccess = () => { const g = r.result.transaction("s").objectStore("s").get("k"); g.onsuccess = () => { idb = String(g.result); r.result.close(); }; }; "ok"`);
      await expect.poll(() => evaluateIn(first, 1, 'idb')).toBe('from the second tab');

      // The history is the profile's: the attached tab sees what the host visited.
      const visited = await view(second).evaluate((el) => el.history({ limit: 20 }).then((entries) => entries.map((e) => e.url)));
      expect(visited).toContain('https://example.com/');

      // The window follows the tab that asked for it.
      await second.close();
      await expect.poll(() => view(first).evaluate((el) => el.windows.map((w) => w.window))).toEqual([1]);
    });

    test('the attached tab navigates and sees its tabs and state', async ({ context }) => {
      const profile = profileName();
      const first = await open(context, profile, `&isolation=${isolation}&persist=clear&url=about:blank`);
      await started(first);
      const second = await open(context, profile, `&isolation=${isolation}&url=about:blank`);
      const { window: id } = await started(second);
      await view(second).evaluate((el) => el.navigate('https://example.com/'));
      await expect.poll(() => view(second).evaluate((el) => `${el.url} ${el.title} ${el.loading}`), { timeout: 60_000 }).toBe('https://example.com/ Example Domain false');
      await view(second).evaluate((el) => el.navigate('https://example.com/?next'));
      await expect.poll(() => view(second).evaluate((el) => el.url), { timeout: 60_000 }).toBe('https://example.com/?next');
      await expect.poll(() => view(second).evaluate((el) => el.canGoBack)).toBe(true);
      await view(second).evaluate((el) => el.back());
      await expect.poll(() => view(second).evaluate((el) => el.url)).toBe('https://example.com/');
      expect(await view(second).evaluate((el) => el.securityState?.secure)).toBe(true);
      // Tabs of the attached window.
      await view(second).evaluate((el) => el.createTab('about:blank', { activate: false }));
      await expect.poll(() => view(second).evaluate((el) => el.tabs.length)).toBe(2);
      const tabs = await view(second).evaluate((el) => el.tabs);
      expect(tabs.filter((t) => t.active)).toHaveLength(1);
      await view(second).evaluate((el) => el.closeTab(el.tabs.find((t) => !t.active).id));
      await expect.poll(() => view(second).evaluate((el) => el.tabs.length)).toBe(1);
      expect(await evaluateIn(first, id, 'location.href')).toBe('https://example.com/');
    });

    test('when the host goes away the next tab takes the profile and the others follow with their windows', async ({ context, browserName }) => {
      const profile = profileName();
      const query = `&isolation=${isolation}`;
      const host = await open(context, profile, `${query}&persist=clear&url=about:blank`);
      await started(host);
      const next = await open(context, profile, `${query}&url=about:blank`);
      const other = await open(context, profile, `${query}&url=https://example.com/?other`);
      expect((await started(next)).role).toBe('client');
      const { window: otherId } = await started(other);
      await loaded(host, otherId, 'https://example.com/?other');
      // Something the profile must still have afterwards.
      await evaluateIn(host, otherId, 'document.cookie = "kept=yes; max-age=3600; path=/"; localStorage.setItem("kept", "yes"); "ok"');
      await view(other).evaluate((el) => el.navigate('https://example.com/?moved'));
      await loaded(host, otherId, 'https://example.com/?moved');
      const events = await other.evaluateHandle(() => {
        const log = [];
        const el = document.querySelector('inception-view');
        for (const name of ['hostlost', 'reattached']) el.addEventListener(name, () => log.push(name));
        return log;
      });
      // The profile's files are not closed cleanly: the host just disappears.
      await host.close();

      await expect.poll(() => view(next).evaluate((el) => el.role), { timeout: 60_000 }).toBe('host');
      await expect.poll(() => events.jsonValue(), { timeout: 60_000 }).toEqual(['hostlost', 'reattached']);
      expect(await view(other).evaluate((el) => el.role)).toBe('client');
      // The client's window is back, where it was, on the new host.
      const newId = await view(other).evaluate((el) => el.windowId);
      expect(await view(next).evaluate((el) => el.windows.map((w) => w.window))).toContain(newId);
      await loaded(next, newId, 'https://example.com/?moved');
      // The profile's files came with it (Playwright's WebKit has no usable
      // origin-private file system: its engine keeps the profile in memory and
      // nothing outlives the host).
      if (browserName !== 'webkit') {
        await expect.poll(() => evaluateIn(next, newId, 'document.cookie')).toContain('kept=yes');
        await expect.poll(() => evaluateIn(next, newId, 'localStorage.getItem("kept")')).toBe('yes');
      }
      await expect.poll(() => view(other).evaluate((el) => el.title), { timeout: 30_000 }).toBe('Example Domain');
      // And the new host runs its own window.
      await view(next).evaluate((el) => el.navigate('https://example.com/?host'));
      await loaded(next, 1, 'https://example.com/?host');
    });
  });
}

test('a tab that opts out keeps the old error', async ({ context }) => {
  const profile = profileName();
  const first = await open(context, profile, '&persist=clear&url=about:blank');
  await started(first);
  const second = await open(context, profile, '&attach=off&url=about:blank');
  const reason = await second.evaluate(() => new Promise((resolve) => {
    const el = document.querySelector('inception-view');
    el.ready.then(() => resolve('started'), (error) => resolve(error.message));
  }));
  expect(reason).toContain('already open in another tab');
});

test('without a shared worker the second tab says what it needs', async ({ context }) => {
  const profile = profileName();
  const first = await open(context, profile, '&persist=clear&url=about:blank');
  await started(first);
  const second = await context.newPage();
  await second.addInitScript(() => { delete window.SharedWorker; });
  await second.goto(`${PAGE}?profile=${profile}&url=about:blank`);
  const reason = await second.evaluate(() => new Promise((resolve) => {
    const el = document.querySelector('inception-view');
    el.ready.then(() => resolve('started'), (error) => resolve(`${error.name}: ${error.message}`));
  }));
  expect(reason).toMatch(/^AttachUnavailableError: .*SharedWorker/);
});

test('a popup of the host attaches through its opener, with no shared worker', async ({ context }) => {
  // No document of this context has a shared worker: the popup can only reach
  // the host that opened it.
  await context.addInitScript(() => { delete window.SharedWorker; });
  const profile = profileName();
  const host = await open(context, profile, '&persist=clear&url=about:blank');
  await started(host);
  const [popup] = await Promise.all([context.waitForEvent('page'), host.locator('#popup').click()]);
  await popup.waitForLoadState();
  expect(await popup.evaluate(() => !!window.opener && typeof SharedWorker)).toBe('undefined');
  const { role, window: id } = await started(popup);
  expect(role).toBe('client');
  await view(popup).evaluate((el) => el.navigate('https://example.com/?popup'));
  await loaded(host, id, 'https://example.com/?popup');
  expect(await view(host).evaluate((el) => el.windows.map((w) => w.window))).toEqual([1, id]);
  await popup.close();
  await expect.poll(() => view(host).evaluate((el) => el.windows.map((w) => w.window))).toEqual([1]);
});

test('a window a page of an attached window opens is shown by the attached tab', async ({ context }) => {
  const profile = profileName();
  const host = await open(context, profile, '&persist=clear&url=about:blank&popups=window');
  await started(host);
  const second = await open(context, profile, '&url=about:blank&popups=window');
  const { window: id } = await started(second);
  // The attached tab shows each window a page opens on a canvas of its own.
  await second.evaluate(() => {
    window.opened = [];
    document.querySelector('inception-view').addEventListener('windowopen', (e) => {
      const canvas = Object.assign(document.createElement('canvas'), { id: `popup-${e.detail.window.id}` });
      canvas.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 200px; height: 150px; z-index: 5';
      document.body.append(canvas);
      e.detail.window.show(canvas);
      window.opened.push({ id: e.detail.window.id, opener: e.detail.opener });
    });
  });
  // A click in the attached tab opens a window from a page that had the person's gesture.
  await evaluateIn(host, id, 'document.open(); document.write(\'<title>opener</title><body style="margin:0"><button id=b style="width:300px;height:200px" onclick="window.open(\\\'about:blank\\\')">open</button>\'); document.close(); document.title');
  await second.mouse.click(100, 100);
  await expect.poll(() => second.evaluate(() => window.opened.length), { timeout: 20_000 }).toBe(1);
  const [popup] = await second.evaluate(() => window.opened);
  expect(popup.opener).toBe('w1');
  await expect.poll(() => evaluateIn(host, popup.id, 'document.readyState'), { timeout: 30_000 }).toBe('complete');
  await evaluateIn(host, popup.id, 'document.open(); document.write("<style>html,body{margin:0;height:100%;background:rgb(0,160,0)}</style>"); document.close(); document.readyState');
  const color = () => second.evaluate(async (id) => {
    const canvas = document.getElementById(`popup-${id}`);
    if (!canvas?.width) return null;
    const bitmap = await createImageBitmap(canvas);
    const copy = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    copy.drawImage(bitmap, 0, 0);
    return Array.from(copy.getImageData(10, 10, 1, 1).data.slice(0, 3));
  }, popup.id);
  await expect.poll(color, { timeout: 20_000 }).toEqual([0, 160, 0]);
  // Closing the attached tab closes the windows it was given, popups included.
  await second.close();
  await expect.poll(() => view(host).evaluate((el) => el.windows.map((w) => w.window))).toEqual([1]);
});
