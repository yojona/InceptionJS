import { expect, test } from '@playwright/test';

// Several windows of one engine: one profile, each window with its own tabs,
// size, input, frames and agent state.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluateIn = (page, window, source) => view(page).evaluate((el, [w, s]) => el.debugEvaluate(s, { window: w }), [window, source]);
const write = (page, window, html) => evaluateIn(page, window, `document.open(); document.write(${JSON.stringify(html)}); document.close(); document.title`);

async function start(page, query = '') {
  await page.goto(`${PAGE}?url=about:blank${query}`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => write(page, 1, '<title>one</title><p>window one</p>'), { timeout: 60_000 }).toBe('one');
}

// Opens a window and, unless `show` is false, an <inception-window> for it.
async function openWindow(page, { show = true, width = 400, height = 300 } = {}) {
  const id = await view(page).evaluate(async (el, [show, width, height]) => {
    const handle = await el.openWindow({ width, height, url: 'about:blank' });
    if (show) {
      const element = document.createElement('inception-window');
      element.id = `window-${handle.id}`;
      // Inside the viewport, over the view's right side, so the pointer reaches it.
      element.style.cssText = `position: fixed; right: 0; bottom: 0; z-index: 10; width: ${width}px; height: ${height}px; display: block`;
      element.view = el;
      element.setAttribute('window', String(handle.id));
      document.body.append(element);
    }
    return handle.id;
  }, [show, width, height]);
  await expect.poll(() => evaluateIn(page, id, 'document.readyState'), { timeout: 30_000 }).toBe('complete');
  return id;
}

// The colour at (x, y) CSS pixels of the canvas that shows `window`.
const pixel = (page, window, x, y) => page.evaluate(async ([window, x, y]) => {
  const host = window === 1 ? document.querySelector('inception-view') : document.getElementById(`window-${window}`);
  const canvas = host.shadowRoot.querySelector('canvas');
  if (!canvas.width) return null;
  const bitmap = await createImageBitmap(canvas);
  const copy = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
  copy.drawImage(bitmap, 0, 0);
  const scale = bitmap.width / canvas.getBoundingClientRect().width;
  const [r, g, b] = copy.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
  return [r, g, b];
}, [window, x, y]);

const colored = (color) => `<title>${color}</title><style>html,body{margin:0;height:100%;background:${color}}</style>`;

test('two windows show their own pages and paint independently', async ({ page }) => {
  await start(page);
  const second = await openWindow(page);
  expect(second).toBe(2);
  await write(page, 1, colored('rgb(255, 0, 0)'));
  await write(page, second, colored('rgb(0, 0, 255)'));
  await expect.poll(() => pixel(page, 1, 50, 50), { timeout: 20_000 }).toEqual([255, 0, 0]);
  await expect.poll(() => pixel(page, second, 50, 50), { timeout: 20_000 }).toEqual([0, 0, 255]);
  expect(await evaluateIn(page, 1, 'document.title')).toBe('rgb(255, 0, 0)');
  expect(await evaluateIn(page, second, 'document.title')).toBe('rgb(0, 0, 255)');
  const windows = await view(page).evaluate((el) => el.windows.map((w) => ({ window: w.window, visible: w.visible })));
  expect(windows).toEqual([{ window: 1, visible: true }, { window: 2, visible: true }]);
});

test('input in one window never reaches the other', async ({ page }) => {
  await start(page);
  const second = await openWindow(page);
  const counter = '<title>input</title><body style="margin:0;height:100vh"><script>window.downs = 0; addEventListener("mousedown", () => downs++); addEventListener("keydown", () => downs += 100)</script></body>';
  await write(page, 1, counter);
  await write(page, second, counter);
  const box = await page.locator(`#window-${second}`).boundingBox();
  await page.mouse.click(box.x + 40, box.y + 40);
  await page.keyboard.press('a');
  await expect.poll(() => evaluateIn(page, second, 'String(downs)')).toBe('101');
  expect(await evaluateIn(page, 1, 'String(downs)')).toBe('0');
  const viewBox = await view(page).boundingBox();
  await page.mouse.click(viewBox.x + 40, viewBox.y + 40);
  await expect.poll(() => evaluateIn(page, 1, 'String(downs)')).toBe('1');
  expect(await evaluateIn(page, second, 'String(downs)')).toBe('101');
  // Focus moved with the click: the second window's page lost it.
  expect(await evaluateIn(page, second, 'String(document.hasFocus())')).toBe('false');
});

test('resizing one window leaves the other alone', async ({ page }) => {
  await start(page);
  const second = await openWindow(page, { width: 400, height: 300 });
  const before = await evaluateIn(page, 1, 'innerWidth + "x" + innerHeight');
  await expect.poll(() => evaluateIn(page, second, 'innerWidth + "x" + innerHeight')).toBe('400x300');
  await page.locator(`#window-${second}`).evaluate((el) => (el.style.width = '320px'));
  await expect.poll(() => evaluateIn(page, second, 'innerWidth + "x" + innerHeight')).toBe('320x300');
  expect(await evaluateIn(page, 1, 'innerWidth + "x" + innerHeight')).toBe(before);
});

test('a window no display shows does not paint but keeps running', async ({ page }) => {
  await start(page);
  const hidden = await openWindow(page, { show: false });
  await evaluateIn(page, hidden, `window.ticks = 0; window.frames_ = 0; setInterval(() => ticks++, 50); (function f() { frames_++; requestAnimationFrame(f); })(); 'ok'`);
  await page.waitForTimeout(1500);
  const state = JSON.parse(await evaluateIn(page, hidden, 'JSON.stringify({ ticks, frames: frames_, visibility: document.visibilityState })'));
  expect(state.ticks).toBeGreaterThan(5);
  expect(state.frames).toBeLessThanOrEqual(1);
  expect(state.visibility).toBe('hidden');
  const info = await view(page).evaluate((el, id) => el.windows.find((w) => w.window === id), hidden);
  expect(info.visible).toBe(false);
});

test('closing a window closes its tabs; window 1 cannot be closed', async ({ page }) => {
  await start(page);
  const second = await openWindow(page);
  const closed = view(page).evaluate((el, id) => new Promise((resolve) => el.window(id).addEventListener('close', () => resolve(true), { once: true })), second);
  await view(page).evaluate((el, id) => el.window(id).createTab('about:blank'), second);
  await expect.poll(() => view(page).evaluate((el, id) => el.window(id).tabs.length, second)).toBe(2);
  await view(page).evaluate((el, id) => el.window(id).close(), second);
  expect(await closed).toBe(true);
  expect(await view(page).evaluate((el) => el.windows.map((w) => w.window))).toEqual([1]);
  expect(await view(page).evaluate((el) => el.tabs.length)).toBe(1);
  // Through the protocol: window 1 is refused, as is a window that is gone.
  const refused = await view(page).evaluate(async (el, id) => {
    const { ProtocolClient, createInPagePair } = await import('/host/protocol.js');
    const [server, client] = createInPagePair();
    el.serve(server, { capabilities: ['view', 'windows'] });
    const protocol = new ProtocolClient(client);
    await protocol.hello(['view', 'windows']);
    const reasons = [];
    for (const window of [1, id]) {
      try {
        await protocol.request('windows.close', { window });
        reasons.push('ok');
      } catch (error) {
        reasons.push(error.data?.reason);
      }
    }
    return reasons;
  }, second);
  expect(refused).toEqual(['invalid_params', 'not_ready']);
  expect(await evaluateIn(page, 1, 'document.title')).toBe('one');
});

test('with popups set to windows, window.open opens a window the policy keeps', async ({ page }) => {
  await start(page, `&policy=${encodeURIComponent(JSON.stringify({ popups: 'window', newTabs: 'foreground' }))}`);
  const opened = view(page).evaluate((el) => new Promise((resolve) => el.addEventListener('windowopen', (e) => resolve({ window: e.detail.window.id, opener: e.detail.opener, userGesture: e.detail.userGesture }), { once: true })));
  await write(page, 1, '<title>opener</title><a id="go" target="_blank" href="about:blank#popup" style="display:block;font-size:40px">open</a>');
  const box = await view(page).boundingBox();
  await page.mouse.click(box.x + 40, box.y + 30);
  const detail = await opened;
  expect(detail.window).toBe(2);
  expect(detail.userGesture).toBe(true);
  await expect.poll(() => evaluateIn(page, detail.window, 'location.hash')).toBe('#popup');
  expect(await view(page).evaluate((el) => el.tabs.length)).toBe(1);
  // The embedder can refuse one: it is closed again.
  await view(page).evaluate((el) => {
    window.refusedWindow = 0;
    el.addEventListener('windowopen', (e) => {
      e.preventDefault();
      e.detail.window.addEventListener('close', () => (window.refusedWindow = e.detail.window.id), { once: true });
    }, { once: true });
  });
  await page.mouse.click(box.x + 40, box.y + 30);
  await expect.poll(() => page.evaluate(() => window.refusedWindow)).toBeGreaterThan(2);
  await expect.poll(() => view(page).evaluate((el) => el.windows.map((w) => w.window))).toEqual([1, 2]);
});

test('by default a window a page opens is closed and reported, even after a click', async ({ page }) => {
  await start(page, `&policy=${encodeURIComponent(JSON.stringify({ popups: 'window' }))}`);
  const blocked = view(page).evaluate((el) => new Promise((resolve) => el.addEventListener('popupblocked', (e) => resolve(e.detail), { once: true })));
  await write(page, 1, '<title>opener</title><a target="_blank" href="about:blank#popup" style="display:block;font-size:40px">open</a>');
  const box = await view(page).boundingBox();
  await page.mouse.click(box.x + 40, box.y + 30);
  const detail = await blocked;
  expect(detail.window).toBe(2);
  expect(detail.userGesture).toBe(true);
  await expect.poll(() => view(page).evaluate((el) => el.windows.map((w) => w.window))).toEqual([1]);
});

test('windows share the profile: cookies, localStorage with its events, IndexedDB, history', async ({ page }) => {
  test.setTimeout(180_000);
  await start(page);
  const second = await openWindow(page);
  const url = 'https://example.com/';
  await view(page).evaluate((el, u) => el.navigate(u), url);
  await view(page).evaluate((el, [id, u]) => el.window(id).navigate(u + '?second'), [second, url]);
  await expect.poll(() => evaluateIn(page, 1, 'location.host'), { timeout: 60_000 }).toBe('example.com');
  await expect.poll(() => evaluateIn(page, second, 'location.host'), { timeout: 60_000 }).toBe('example.com');

  await evaluateIn(page, 1, 'document.cookie = "shared=yes; path=/"; "ok"');
  await expect.poll(() => evaluateIn(page, second, 'document.cookie')).toContain('shared=yes');

  await evaluateIn(page, second, 'window.seen = ""; addEventListener("storage", (e) => { seen = e.key + "=" + e.newValue; }); "ok"');
  await evaluateIn(page, 1, 'localStorage.setItem("color", "teal"); "ok"');
  await expect.poll(() => evaluateIn(page, second, 'seen')).toBe('color=teal');
  expect(await evaluateIn(page, second, 'localStorage.getItem("color")')).toBe('teal');

  await evaluateIn(page, 1, `window.idb = "pending"; const r = indexedDB.open("shared", 1); r.onupgradeneeded = () => r.result.createObjectStore("s"); r.onsuccess = () => { const t = r.result.transaction("s", "readwrite"); t.objectStore("s").put("from one", "k"); t.oncomplete = () => { r.result.close(); idb = "written"; }; }; "ok"`);
  await expect.poll(() => evaluateIn(page, 1, 'idb')).toBe('written');
  await evaluateIn(page, second, `window.idb = "pending"; const r = indexedDB.open("shared", 1); r.onsuccess = () => { const g = r.result.transaction("s").objectStore("s").get("k"); g.onsuccess = () => { idb = String(g.result); r.result.close(); }; }; "ok"`);
  await expect.poll(() => evaluateIn(page, second, 'idb')).toBe('from one');

  const visited = await view(page).evaluate((el) => el.history({ limit: 20 }).then((entries) => entries.map((e) => e.url)));
  expect(visited).toContain(url);
  expect(visited).toContain(url + '?second');
});

test('a forced crash reaches every window', async ({ page }) => {
  await start(page, '&agent=1');
  const second = await openWindow(page);
  const events = page.evaluate(async (id) => {
    const el = document.querySelector('inception-view');
    const handle = el.window(id);
    const crashes = [];
    const done = new Promise((resolve) => {
      handle.addEventListener('crash', (e) => { crashes.push(['window', e.detail.windows]); resolve(); }, { once: true });
    });
    el.addEventListener('crash', (e) => e.detail.windows && crashes.push(['view', e.detail.windows]));
    const pending = handle.agent.waitFor({ text: 'never there', timeoutMs: 60_000 }).then(() => 'ok', (error) => error.data?.reason);
    await new Promise((resolve) => setTimeout(resolve, 300));
    el.debugCommand('debug.crash', {});
    await done;
    return { crashes, pending: await pending };
  }, second);
  const result = await events;
  expect(result.crashes).toContainEqual(['view', [1, 2]]);
  expect(result.crashes).toContainEqual(['window', [1, 2]]);
  expect(result.pending).toBe('engine_crashed');
});

test('the agent is bound to its window: snapshots, control and logs are per window', async ({ page }) => {
  await start(page, '&agent=1');
  const second = await openWindow(page);
  await write(page, 1, '<title>first</title><button>Only in one</button>');
  await write(page, second, '<title>second</title><button>Only in two</button>');
  const names = await view(page).evaluate(async (el, id) => {
    const text = (s) => JSON.stringify(s);
    return { one: text(await el.agent.snapshot()), two: text(await el.window(id).agent.snapshot()) };
  }, second);
  expect(names.one).toContain('Only in one');
  expect(names.one).not.toContain('Only in two');
  expect(names.two).toContain('Only in two');
  expect(names.two).not.toContain('Only in one');

  // A connection served for window 2 cannot bind to window 1.
  const refused = await view(page).evaluate(async (el, id) => {
    const { ProtocolClient, createInPagePair } = await import('/host/protocol.js');
    const [server, client] = createInPagePair();
    el.window(id).serve(server, { capabilities: ['agent'] });
    const protocol = new ProtocolClient(client);
    try {
      await protocol.hello(['agent'], { window: 1 });
      return 'bound';
    } catch (error) {
      return error.data?.reason;
    }
  }, second);
  expect(refused).toBe('denied_by_policy');

  await view(page).evaluate((el, id) => el.window(id).requestControl(), second);
  const control = await view(page).evaluate((el, id) => ({ one: el.control, two: el.window(id).control }), second);
  expect(control).toEqual({ one: 'human', two: 'agent' });
  const logs = await view(page).evaluate(async (el, id) => ({ one: (await el.agent.log()).map((e) => e.action), two: (await el.window(id).agent.log()).map((e) => e.action) }), second);
  expect(logs.two).toContain('control');
  expect(logs.one).not.toContain('control');
  expect(logs.one).toContain('snapshot');
});

test('a window the agent opens is not under its control', async ({ page }) => {
  await start(page, `&agent=1&policy=${encodeURIComponent(JSON.stringify({ popups: 'window', newTabs: 'foreground' }))}`);
  await write(page, 1, '<title>opener</title><button onclick="window.open(\'about:blank#agent\')">Open</button>');
  const opened = view(page).evaluate((el) => new Promise((resolve) => el.addEventListener('windowopen', (e) => resolve(e.detail.window.id), { once: true })));
  await view(page).evaluate(async (el) => {
    await el.requestControl();
    const { matches } = await el.agent.find({ role: 'button', name: 'Open' });
    await el.agent.click({ ref: matches[0].ref });
  });
  const id = await opened;
  expect(await view(page).evaluate((el) => el.control)).toBe('agent');
  expect(await view(page).evaluate((el, w) => el.window(w).control, id)).toBe('human');
});

test('GPU: WebGL in two windows, context loss repaints both, alternating sizes stay intact', async ({ page }) => {
  await start(page);
  const second = await openWindow(page, { width: 300, height: 200 });
  const scene = (color) => `<title>gl</title><style>html,body{margin:0}</style><canvas width="120" height="120"></canvas><script>
    const gl = document.querySelector('canvas').getContext('webgl');
    window.lost = 0;
    document.querySelector('canvas').addEventListener('webglcontextlost', () => lost++);
    (function draw() { if (gl) { gl.clearColor(${color}, 1); gl.clear(gl.COLOR_BUFFER_BIT); } requestAnimationFrame(draw); })();
  </script>`;
  await write(page, 1, scene('1, 0, 0'));
  await write(page, second, scene('0, 1, 0'));
  expect(await evaluateIn(page, 1, 'String(!!document.querySelector("canvas").getContext("webgl"))')).toBe('true');
  expect(await evaluateIn(page, second, 'String(!!document.querySelector("canvas").getContext("webgl"))')).toBe('true');
  // Both animate at once at different sizes: each frame stays its own.
  for (let i = 0; i < 3; i++) {
    await expect.poll(() => pixel(page, 1, 60, 60), { timeout: 20_000 }).toEqual([255, 0, 0]);
    await expect.poll(() => pixel(page, second, 60, 60), { timeout: 20_000 }).toEqual([0, 255, 0]);
    await page.waitForTimeout(300);
  }
  await view(page).evaluate((el) => el.debugCommand('debug.loseGPU', { restoreAfterMs: 300 }));
  await page.waitForTimeout(1500);
  await write(page, 1, colored('rgb(255, 0, 255)'));
  await write(page, second, colored('rgb(0, 255, 255)'));
  await expect.poll(() => pixel(page, 1, 60, 60), { timeout: 20_000 }).toEqual([255, 0, 255]);
  await expect.poll(() => pixel(page, second, 60, 60), { timeout: 20_000 }).toEqual([0, 255, 255]);
});
