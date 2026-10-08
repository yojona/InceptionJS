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
