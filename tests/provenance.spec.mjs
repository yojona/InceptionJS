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
