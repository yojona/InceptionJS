import { expect, test } from '@playwright/test';

const PAGE = process.env.PAGE_PATH ?? '/';

const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);

test.beforeEach(async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  await view(page).evaluate((el) => el.ready);
});

test('the view names the site that embeds it', async ({ page }) => {
  const host = new URL(page.url()).hostname;
  await expect(view(page).locator('.provenance')).toHaveText(`InceptionJS on ${host}`);
  await view(page).evaluate((el) => el.setAttribute('provenance-corner', 'top-left'));
  await expect(view(page).locator('.provenance')).toHaveClass(/top-left/);
});

test('a password or card field brings up the notice, leaving it hides it', async ({ page }) => {
  const notice = view(page).locator('.notice');
  await expect(notice).toBeHidden();
  await evaluate(page, `document.body.innerHTML = '<input id="user"><input id="pass" type="password"><input id="card" autocomplete="cc-number">'; 'ok'`);
  await evaluate(page, `document.getElementById('pass').focus(), 'ok'`);
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('password');
  await evaluate(page, `document.getElementById('card').focus(), 'ok'`);
  await expect(notice).toContainText('card details');
  await evaluate(page, `document.getElementById('user').focus(), 'ok'`);
  await expect(notice).toBeHidden();
});

test('hiding the badge from the embedding page covers the view until it is shown again', async ({ page }) => {
  const tamper = view(page).locator('.tamper');
  await expect(tamper).toHaveCount(0);
  for (const css of [
    'inception-view::part(provenance) { display: none !important }',
    'inception-view::part(provenance) { opacity: 0 !important }',
    'inception-view::part(provenance) { visibility: hidden !important }',
    'inception-view::part(provenance) { transform: translate(-9999px, 0) !important }',
    'inception-view::part(provenance) { width: 0 !important; padding: 0 !important; overflow: hidden !important }',
  ]) {
    const style = await page.addStyleTag({ content: css });
    await expect(tamper, css).toHaveCount(1, { timeout: 5000 });
    await style.evaluate((node) => node.remove());
    await expect(tamper, css).toHaveCount(0, { timeout: 5000 });
  }
});

test('restyling the badge is fine; provenance="off" is the explicit way to remove it', async ({ page }) => {
  await page.addStyleTag({ content: 'inception-view::part(provenance) { background: #123; font-size: 14px; margin: 12px }' });
  await page.waitForTimeout(2500);
  await expect(view(page).locator('.tamper')).toHaveCount(0);
  await view(page).evaluate((el) => el.setAttribute('provenance', 'off'));
  await page.addStyleTag({ content: 'inception-view::part(provenance) { display: none !important }' });
  await page.waitForTimeout(2500);
  await expect(view(page).locator('.tamper')).toHaveCount(0);
});

test('sensitivepage reports password and card fields with their origin, and can replace the built-in notice', async ({ page }) => {
  await view(page).evaluate((el) => {
    window.sensitive = [];
    el.addEventListener('sensitivepage', (e) => {
      window.sensitive.push(`${e.detail.kind}:${e.detail.reason}:${e.detail.origin}`);
      if (window.takeOver) e.preventDefault();
    });
  });
  await evaluate(page, `document.body.innerHTML = '<input id="user"><input id="pass" type="password"><input id="card" autocomplete="cc-number">'; 'ok'`);
  await evaluate(page, `document.getElementById('pass').focus(), 'ok'`);
  await expect(view(page).locator('.notice')).toBeVisible();
  await evaluate(page, `document.getElementById('user').focus(), 'ok'`);
  await expect(view(page).locator('.notice')).toBeHidden();
  await page.evaluate(() => (window.takeOver = true));
  await evaluate(page, `document.getElementById('card').focus(), 'ok'`);
  await expect.poll(() => page.evaluate(() => window.sensitive.length)).toBe(3);
  await expect(view(page).locator('.notice')).toBeHidden();
  const seen = await page.evaluate(() => window.sensitive);
  expect(seen[0]).toMatch(/^password:field:/);
  expect(seen[1]).toMatch(/^::/);
  expect(seen[2]).toMatch(/^payment:field:/);
});

test('sensitivepage fires with provenance="off" too', async ({ page }) => {
  await view(page).evaluate((el) => {
    el.setAttribute('provenance', 'off');
    window.sensitive = [];
    el.addEventListener('sensitivepage', (e) => window.sensitive.push(e.detail.kind));
  });
  await evaluate(page, `document.body.innerHTML = '<input id="pass" type="password">'; document.getElementById('pass').focus(), 'ok'`);
  await expect.poll(() => page.evaluate(() => window.sensitive)).toEqual(['password']);
  await expect(view(page).locator('.notice')).toBeHidden();
});

test('a badge made unreadable by its colours, or covered by the page for a while, counts as hidden', async ({ page }) => {
  const tamper = view(page).locator('.tamper');
  for (const css of [
    'inception-view::part(provenance) { color: transparent !important }',
    'inception-view::part(provenance) { color: rgb(20 20 28) !important; background: rgb(20 20 28) !important }',
  ]) {
    const style = await page.addStyleTag({ content: css });
    await expect(tamper, css).toHaveCount(1, { timeout: 5000 });
    await style.evaluate((node) => node.remove());
    await expect(tamper, css).toHaveCount(0, { timeout: 5000 });
  }
  // An element of the page over the badge's corner.
  const cover = await page.evaluate(() => {
    const badge = document.querySelector('inception-view').shadowRoot.querySelector('.provenance').getBoundingClientRect();
    const box = document.createElement('div');
    box.id = 'cover';
    box.style.cssText = `position: fixed; z-index: 100; background: #fff; left: ${badge.left - 4}px; top: ${badge.top - 4}px; width: ${badge.width + 8}px; height: ${badge.height + 8}px`;
    document.body.append(box);
    return true;
  });
  expect(cover).toBe(true);
  // Briefly is fine (a menu passing over it); for a while it is not.
  await page.waitForTimeout(1500);
  await expect(tamper).toHaveCount(0);
  await expect(tamper).toHaveCount(1, { timeout: 6000 });
  await page.evaluate(() => document.getElementById('cover').remove());
  await expect(tamper).toHaveCount(0, { timeout: 5000 });
});
