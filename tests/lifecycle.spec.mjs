import { expect, test } from '@playwright/test';

// A view removed from the page stops its engines and lets go of its profile;
// one moved elsewhere in the page keeps running.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const heldLocks = (page) => page.evaluate(async () => (await navigator.locks.query()).held.map((lock) => lock.name).sort());

async function start(page, isolation) {
  const profile = `life-${isolation}-${Date.now()}`;
  await page.goto(`${PAGE}?url=about:blank&isolation=${isolation}&persist=clear&profile=${profile}`);
  await view(page).evaluate((el) => el.ready);
  return profile;
}

async function remount(page, profile) {
  await page.evaluate((profile) => {
    const el = document.createElement('inception-view');
    el.setAttribute('profile', profile);
    el.setAttribute('src', 'about:blank');
    document.body.append(el);
  }, profile);
  return view(page).evaluate(async (el) => {
    await el.ready;
    const second = await el.openWindow({ url: 'about:blank' });
    return { role: el.dataset.role, second: second.id };
  });
}

for (const isolation of ['shared', 'window']) {
  test(`a removed view lets go of its profile, and a new view of it runs it again (${isolation})`, async ({ page }) => {
    const profile = await start(page, isolation);
    expect(await heldLocks(page)).toContain(`inception-profile:${profile}`);
    const removed = await view(page).elementHandle();
    await removed.evaluate((el) => el.remove());
    await expect.poll(() => removed.evaluate((el) => el.closed)).toBe(true);
    await expect.poll(() => heldLocks(page)).not.toContain(`inception-profile:${profile}`);
    expect((await heldLocks(page)).filter((name) => name.startsWith(`inception-host:${profile}:`))).toEqual([]);
    const again = await remount(page, profile);
    expect(again.role).toBe('host');
    expect(again.second).toBeGreaterThan(1);
  });
}

test('a view moved elsewhere in the page keeps running', async ({ page }) => {
  await start(page, 'shared');
  await page.evaluate(() => {
    const el = document.querySelector('inception-view');
    const box = document.createElement('div');
    document.body.append(box);
    box.append(el);
  });
  await page.waitForTimeout(200);
  const state = await view(page).evaluate(async (el) => ({ closed: el.closed, role: el.dataset.role, title: await el.debugEvaluate('1 + 1') }));
  expect(state).toEqual({ closed: false, role: 'host', title: '2' });
});
