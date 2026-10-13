import { expect, test } from '@playwright/test';

// Public-embedder defaults: what a page can do to the person's browser when
// the embedder configured nothing. The example page is a browser and opts in
// to everything, so these tests load it with ?policy={} (the library's own
// defaults).
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);
const write = (page, html) => evaluate(page, `document.open(); document.write(${JSON.stringify(html)}); document.close(); document.title`);
const open = async (page, policy = {}) => {
  await page.goto(`${PAGE}?url=about:blank&policy=${encodeURIComponent(JSON.stringify(policy))}`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => write(page, '<title>ready</title><p>ready</p>'), { timeout: 60_000 }).toBe('ready');
};

test('debug methods are off unless the embedder enables them', async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank&policy={}&debug=0`);
  const errors = await view(page).evaluate(async (el) => {
    const outcomes = [];
    for (const call of [() => el.debugEvaluate('1'), () => el.debugHeap(), () => el.debugCommand('debug.inject', { source: '1' })])
      outcomes.push(await call().then(() => 'allowed', (error) => error.message));
    return outcomes;
  });
  for (const message of errors) expect(message).toMatch(/Debug methods are off/);
});

// Records whether the view tried to save a file to the person's disk (it does
// that by clicking a link with a download attribute) and what it reported.
const download = (page, url = 'https://www.iana.org/robots.txt') => view(page).evaluate((el, target) => new Promise((resolve) => {
  const saved = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute('download')) saved.push(this.download);
    else click.call(this);
  };
  const seen = [];
  for (const type of ['downloadstart', 'downloadblocked']) el.addEventListener(type, () => seen.push(type));
  el.addEventListener('downloadfinish', (e) => {
    // The view saves after the event has been dispatched.
    setTimeout(() => {
      HTMLAnchorElement.prototype.click = click;
      resolve({ seen, saved, error: e.detail.error, size: e.detail.blob?.size, filename: e.detail.filename });
    });
  });
  el.addEventListener('downloadblocked', () => setTimeout(() => resolve({ seen, saved }), 3000));
  el.download(target);
}), url);

test('a download is reported with its file but not saved to the disk by default', async ({ page }) => {
  await open(page);
  const result = await download(page);
  expect(result.error).toBeUndefined();
  expect(result.size).toBeGreaterThan(0);
  expect(result.filename).toBe('robots.txt');
  expect(result.saved).toEqual([]);
});

test('policy.downloads "save" saves the file to the disk', async ({ page }) => {
  await open(page, {"downloads":"save"});
  const result = await download(page);
  expect(result.saved).toEqual(['robots.txt']);
});

test('policy.downloads "block" cancels a download as it starts', async ({ page }) => {
  await open(page, {"downloads":"block"});
  const result = await download(page);
  expect(result.seen).toEqual(['downloadblocked']);
  expect(result.saved).toEqual([]);
});

test('a download larger than maxDownloadBytes is cancelled', async ({ page }) => {
  await open(page, {"maxDownloadBytes":10});
  const result = await download(page);
  expect(result.error).toMatch(/larger/);
  expect(result.size).toBeUndefined();
});

const LINK = '<title>links</title><a target="_blank" href="about:blank#opened" style="display:block;font-size:40px">open</a>';
const tabIds = (page) => view(page).evaluate((el) => el.tabs.map((tab) => tab.id));
const click = async (page) => {
  const box = await view(page).boundingBox();
  await page.mouse.click(box.x + 40, box.y + 30);
};

test('a window a page opens is closed and reported by default', async ({ page }) => {
  await open(page);
  const first = await view(page).evaluate((el) => el.activeTab);
  const blocked = view(page).evaluate((el) => new Promise((resolve) => el.addEventListener('popupblocked', (e) => resolve(e.detail), { once: true })));
  await write(page, LINK);
  await click(page);
  const detail = await blocked;
  expect(detail.userGesture).toBe(true);
  expect(detail.url).toContain('about:blank');
  await expect.poll(() => tabIds(page)).toEqual([first]);
  expect(await view(page).evaluate((el) => el.activeTab)).toBe(first);
});

test('the embedder can accept one popup from the newtab event', async ({ page }) => {
  await open(page);
  const first = await view(page).evaluate((el) => el.activeTab);
  await view(page).evaluate((el) => el.addEventListener('newtab', (e) => e.detail.allow('foreground')));
  await write(page, LINK);
  await click(page);
  await expect.poll(() => view(page).evaluate((el) => el.activeTab)).not.toBe(first);
});

test('policy.newTabs "foreground" shows a popup that follows a gesture', async ({ page }) => {
  await open(page, { newTabs: 'foreground' });
  const first = await view(page).evaluate((el) => el.activeTab);
  await write(page, LINK);
  await click(page);
  await expect.poll(() => view(page).evaluate((el) => el.activeTab)).not.toBe(first);
});

const ask = (page) => evaluate(page, "JSON.stringify([alert('a'), confirm('c'), prompt('p', 'd')])");

test('page dialogs are answered without showing any by default', async ({ page }) => {
  const native = [];
  page.on('dialog', (dialog) => {
    native.push(dialog.type());
    dialog.dismiss();
  });
  await open(page);
  const blocked = view(page).evaluate((el) => new Promise((resolve) => {
    const types = [];
    el.addEventListener('dialogblocked', (e) => types.push(e.detail.type));
    el.addEventListener('dialogblocked', () => types.length === 3 && resolve(types));
  }));
  expect(await ask(page)).toBe('[null,false,null]');
  expect(await blocked).toEqual(['alert', 'confirm', 'prompt']);
  expect(native).toEqual([]);
});

test('policy.dialogs "native" uses the browser dialogs', async ({ page }) => {
  const native = [];
  page.on('dialog', (dialog) => {
    native.push(dialog.type());
    dialog.accept(dialog.type() === 'prompt' ? 'typed' : undefined);
  });
  await open(page, { dialogs: 'native' });
  expect(await ask(page)).toBe('[null,true,"typed"]');
  expect(native).toEqual(['alert', 'confirm', 'prompt']);
});

test('the embedder can draw its own dialog from the event', async ({ page }) => {
  await open(page);
  await view(page).evaluate((el) => el.addEventListener('dialog', (e) => {
    e.preventDefault();
    e.detail.respond(e.detail.type === 'confirm' ? true : e.detail.type === 'prompt' ? 'mine' : null);
  }));
  expect(await ask(page)).toBe('[null,true,"mine"]');
});

// The page asks to put text on the clipboard; the host's clipboard API calls are recorded.
const hostClipboardWrites = async (page) => page.evaluate(() => {
  window.clipboardWrites = [];
  const record = (text) => window.clipboardWrites.push(text);
  const write = navigator.clipboard.write.bind(navigator.clipboard);
  const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.write = async (items) => {
    record(await Promise.all(items.map((item) => item.getType('text/plain').then((blob) => blob.text()).catch(() => ''))));
    return write(items).catch(() => {});
  };
  navigator.clipboard.writeText = async (text) => {
    record([text]);
    return writeText(text).catch(() => {});
  };
});
const pageCopies = async (page, text) => {
  await view(page).evaluate((el) => el.focusInput());
  await evaluate(page, `document.body.innerHTML = '<input id="c" value="${text}">'; var c = document.getElementById('c'); c.focus(); c.select(); 1`);
  // The raw command, which does not count as the person's input the way edit() does.
  await view(page).evaluate((el) => el.debugCommand('edit', { command: 'Copy' }));
  await page.waitForTimeout(500);
  return page.evaluate(() => window.clipboardWrites.flat());
};

test('a page cannot write the system clipboard on its own by default, only after the person acts', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'only Chromium in Playwright has clipboard permissions to grant');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page);
  await hostClipboardWrites(page);
  expect(await pageCopies(page, 'poison')).toEqual([]);
  const box = await view(page).boundingBox();
  await page.mouse.click(box.x + 20, box.y + 20);
  expect(await pageCopies(page, 'wanted')).toContain('wanted');
});

test('policy.clipboard true lets a page write it at any time, false never', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'only Chromium in Playwright has clipboard permissions to grant');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, { clipboard: true });
  await hostClipboardWrites(page);
  expect(await pageCopies(page, 'always')).toContain('always');
  await open(page, { clipboard: false });
  await hostClipboardWrites(page);
  const box = await view(page).boundingBox();
  await page.mouse.click(box.x + 20, box.y + 20);
  expect(await pageCopies(page, 'never')).toEqual([]);
});

test('a connection served to another client gets navigation only; the view itself still finds and reads history', async ({ page }) => {
  await open(page);
  expect(await view(page).evaluate((el) => el.find('ready'))).toMatchObject({ found: true });
  expect(Array.isArray(await view(page).evaluate((el) => el.history()))).toBe(true);
  const remote = await view(page).evaluate(async (el) => {
    const { ProtocolClient, createInPagePair } = await import('/host/protocol.js');
    const [near, far] = createInPagePair();
    el.serve(near);
    const client = new ProtocolClient(far);
    const { capabilities } = await client.hello(['view', 'find', 'history', 'observe']);
    const code = (promise) => promise.then(() => 'allowed', (error) => error.code);
    return { capabilities, find: await code(client.request('view.find', { text: 'ready' })), history: await code(client.request('history.query')), state: await code(client.request('view.state')) };
  });
  expect(remote).toEqual({ capabilities: ['view'], find: -32002, history: -32002, state: 'allowed' });
});

test('a page cannot make the person\'s browser request an address the relay refuses', async ({ page }) => {
  await open(page);
  const requested = [];
  page.on('request', (request) => requested.push(request.url()));
  await write(page, '<video id="v" src="http://10.255.255.1:8999/probe.mp4"></video><audio id="a" src="http://192.168.254.254:8998/probe.mp3"></audio>');
  // Both elements fail the way an unusable file does.
  await expect.poll(() => evaluate(page, "[document.getElementById('v').error?.code ?? 0, document.getElementById('a').error?.code ?? 0].join()"), { timeout: 30_000 }).toBe('4,4');
  expect(requested.filter((url) => /10\.255\.255\.1|192\.168\.254\.254/.test(url))).toEqual([]);
});

test('a download the embedder asks for arrives flagged as the person\'s, so the gesture rule lets it through', async ({ page }) => {
  await open(page);
  const flagged = await view(page).evaluate((el) => new Promise((resolve) => {
    el.addEventListener('downloadstart', (e) => resolve(e.detail.userGesture), { once: true });
    el.download('https://www.iana.org/robots.txt');
  }));
  expect(flagged).toBe(true);
});
