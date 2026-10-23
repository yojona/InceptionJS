import { expect, test } from '@playwright/test';

const PAGE = process.env.PAGE_PATH ?? '/';

const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);
const tabs = (page) => view(page).evaluate((el) => el.tabs.map(({ id, title, url, active, opener }) => ({ id, title, url, active, opener })));
const activeTab = (page) => view(page).evaluate((el) => el.activeTab);

// The relay does not reach loopback addresses, so pages are written into
// blank documents instead of being loaded.
const write = (page, html) => evaluate(page, `document.open(); document.write(${JSON.stringify(html)}); document.close(); document.title`);

test.beforeEach(async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => write(page, '<title>first</title><p>first tab</p>'), { timeout: 60_000 }).toBe('first');
});

test('tabs are separate pages and only the active one runs script from the host', async ({ page }) => {
  const first = await activeTab(page);
  await view(page).evaluate((el) => el.createTab('about:blank'));
  await expect.poll(() => activeTab(page)).not.toBe(first);
  await expect.poll(() => write(page, '<title>second</title>')).toBe('second');
  expect((await tabs(page)).length).toBe(2);

  await view(page).evaluate((el, id) => el.activateTab(id), first);
  await expect.poll(() => activeTab(page)).toBe(first);
  await expect.poll(() => evaluate(page, 'document.title')).toBe('first');
});

test('a link with target=_blank opens a new tab the host shows', async ({ page }) => {
  const first = await activeTab(page);
  const opened = view(page).evaluate((el) => new Promise((resolve) => el.addEventListener('newtab', (e) => resolve(e.detail), { once: true })));
  await write(page, '<title>links</title><a id="go" target="_blank" href="about:blank#opened" style="display:block;font-size:40px">open</a>');
  const box = await view(page).boundingBox();
  await page.mouse.click(box.x + 40, box.y + 30);
  const detail = await opened;
  expect(detail.opener).toBe(first);
  expect(detail.userGesture).toBe(true);
  await expect.poll(() => activeTab(page)).toBe(detail.tab);
  await expect.poll(() => evaluate(page, 'location.hash')).toBe('#opened');
});

test('window.open without a gesture is blocked; window.close closes the tab', async ({ page }) => {
  expect(await evaluate(page, 'String(window.open("about:blank") === null)')).toBe('true');
  expect((await tabs(page)).length).toBe(1);

  const first = await activeTab(page);
  await view(page).evaluate((el) => el.createTab('about:blank'));
  await expect.poll(() => activeTab(page)).not.toBe(first);
  const second = await activeTab(page);
  await evaluate(page, 'window.close(), "closing"');
  await expect.poll(async () => (await tabs(page)).map((t) => t.id)).toEqual([first]);
  expect(await activeTab(page)).toBe(first);
  expect(second).not.toBe(first);
});

test('the last tab cannot be closed', async ({ page }) => {
  const first = await activeTab(page);
  await view(page).evaluate((el, id) => el.closeTab(id), first);
  await page.waitForTimeout(500);
  expect((await tabs(page)).map((t) => t.id)).toEqual([first]);
});

test('hidden tabs report their own title', async ({ page }) => {
  // Tabs a page opens stay in the background with this policy.
  await page.evaluate(async () => (await import('/host/inception-view.js')).Inception.configure({ policy: { newTabs: 'background' } }));
  const first = await activeTab(page);
  await write(page, '<title>opener</title><button id="b" style="font-size:40px" onclick="window.open(\'https://example.com/\')">open</button>');
  const box = await view(page).boundingBox();
  await page.mouse.click(box.x + 40, box.y + 30);
  await expect.poll(async () => (await tabs(page)).find((t) => t.id !== first)?.title, { timeout: 30_000 }).toBe('Example Domain');
  const hidden = (await tabs(page)).find((t) => t.id !== first);
  expect(hidden.active).toBe(false);
  expect(hidden.opener).toBe(first);
  // The view itself still shows the first tab.
  expect(await activeTab(page)).toBe(first);
  expect(await view(page).evaluate((el) => el.title)).toBe('opener');
});

test('a download can be paused and resumed', async ({ page }) => {
  const result = await view(page).evaluate((el) => new Promise((resolve, reject) => {
    const seen = [];
    let paused = false;
    el.addEventListener('downloadprogress', (e) => {
      if (paused) return;
      paused = true;
      el.pauseDownload(e.detail.id);
    });
    el.addEventListener('downloadpause', (e) => { seen.push(`pause:${e.detail.received > 0}`); el.resumeDownload(e.detail.id); });
    el.addEventListener('downloadresume', (e) => seen.push(`resume:${e.detail.received > 0}`));
    el.addEventListener('downloadfinish', (e) => {
      e.preventDefault();
      resolve({ seen, size: e.detail.blob?.size ?? 0, error: e.detail.error ?? null });
    }, { once: true });
    el.download('https://proof.ovh.net/files/1Mb.dat').catch(reject);
  }));
  expect(result.error).toBeNull();
  expect(result.seen[0]).toBe('pause:true');
  expect(result.seen[1]).toMatch(/^resume:/);
  expect(result.size).toBe(1024 * 1024);
});

test('a page without a title does not keep the previous page\'s', async ({ page }) => {
  await view(page).evaluate((el) => el.navigate('https://example.com/'));
  await expect.poll(() => view(page).evaluate((el) => el.title), { timeout: 60_000 }).toBe('Example Domain');
  await view(page).evaluate((el) => el.navigate('https://www.iana.org/robots.txt'));
  await expect.poll(() => view(page).evaluate((el) => el.url), { timeout: 60_000 }).toBe('https://www.iana.org/robots.txt');
  await expect.poll(() => view(page).evaluate((el) => el.title)).toBe('');
});
