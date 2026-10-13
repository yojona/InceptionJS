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
