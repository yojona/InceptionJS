import { expect, test } from '@playwright/test';

const PAGE = process.env.PAGE_PATH ?? '/';

const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);
const events = async (page) => JSON.parse(await evaluate(page, 'JSON.stringify(events)'));
// Center of an element of the engine's page, in view coordinates.
const center = async (page, selector) => JSON.parse(await evaluate(page, `(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
const clickAt = async (page, { x, y }) => {
  const box = await view(page).boundingBox();
  await page.mouse.click(box.x + x, box.y + y);
};

// The relay does not reach loopback addresses, so the fixture is written into
// a blank page instead of being loaded.
test.beforeEach(async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  const html = await (await page.request.get('/tests/fixtures/forms.html')).text();
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => evaluate(page, `document.open(); document.write(${JSON.stringify(html)}); document.close(); document.title`), { timeout: 60_000 }).toBe('Forms');
});

test('a select opens a host menu that the keyboard drives', async ({ page }) => {
  await clickAt(page, await center(page, '#fruit'));
  const menu = view(page).locator('.menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('li')).toHaveText(['Apple', 'Citrus', 'Lemon', 'Orange', 'Banana', 'Cherry']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect.poll(() => events(page)).toEqual(['change:Lemon']);
});

test('scrolling the page closes an open select list', async ({ page }) => {
  const anchor = await center(page, '#fruit');
  await clickAt(page, anchor);
  const menu = view(page).locator('.menu');
  await expect(menu).toBeVisible();
  const box = await view(page).boundingBox();
  await page.mouse.move(box.x + anchor.x + 300, box.y + anchor.y + 200);
  await page.mouse.wheel(0, 200);
  await expect(menu).toHaveCount(0);
  expect(await events(page)).toEqual([]);
});

test('dialogs wait for the host answer', async ({ page }) => {
  await view(page).evaluate((el) => el.addEventListener('dialog', (e) => {
    e.preventDefault();
    e.detail.respond(e.detail.type === 'prompt' ? `${e.detail.message}!` : e.detail.type === 'confirm');
  }));
  expect(await evaluate(page, 'String(confirm("sure?"))')).toBe('true');
  expect(await evaluate(page, 'prompt("name", "x")')).toBe('name!');
  expect(await evaluate(page, 'String(alert("hi"))')).toBe('undefined');
});

test('a file input receives files from the host picker', async ({ page }) => {
  await view(page).evaluate((el) => el.addEventListener('filechooser', (e) => {
    e.preventDefault();
    e.detail.choose([new File(['hello inception'], 'note.txt', { type: 'text/plain' })]);
  }));
  await clickAt(page, await center(page, '#file'));
  await expect.poll(() => events(page)).toEqual(['files:note.txt=15', 'content:hello inception']);
});

test('composed text reaches the page as a composition', async ({ page }) => {
  await clickAt(page, await center(page, '#text'));
  await view(page).evaluate((el) => {
    const input = el.shadowRoot.querySelector('textarea');
    input.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    input.dispatchEvent(new CompositionEvent('compositionupdate', { data: '´' }));
    input.dispatchEvent(new CompositionEvent('compositionend', { data: 'á' }));
  });
  await expect.poll(() => evaluate(page, 'document.getElementById("text").value')).toBe('á');
  expect(await events(page)).toEqual(['compositionstart', 'compositionend:á']);
});
