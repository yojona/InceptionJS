import { expect, test } from '@playwright/test';

// The engine repaints only what changed since the last frame. What it shows
// must match a full repaint, and small changes (a caret) must stay small.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);
const write = (page, html) => evaluate(page, `document.open(); document.write(${JSON.stringify(html)}); document.close(); document.title`);
const frames = (page) => view(page).evaluate((el) => el.debugFrames());
const configure = (page, args) => view(page).evaluate((el, a) => el.debugCommand('perf.configure', a), args);

const PAGE_HTML = `<title>paint</title>
<style>
  body { margin: 0; font: 16px serif }
  p { margin: 0; padding: 8px 12px; border-bottom: 1px solid #ccc }
  p:nth-child(3n) { background: #eef }
  button:hover { background: #fc6 }
  .fixed { position: fixed; right: 10px; top: 10px; width: 120px; height: 40px; background: #c33a }
</style>
<div class="fixed"></div>
<input style="margin: 12px; width: 200px">
<button style="margin: 12px">Hover</button>
${Array.from({ length: 200 }, (_, i) => `<p>Paragraph ${i}: lorem ipsum dolor sit amet, consectetur adipiscing elit</p>`).join('')}`;

test.beforeEach(async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => write(page, PAGE_HTML), { timeout: 60_000 }).toBe('paint');
});

test.afterEach(async ({ page }) => {
  await configure(page, { paintOnInput: true, damage: true }).catch(() => {});
});

test('partial frames show what a full repaint shows', async ({ page }) => {
  const box = await view(page).boundingBox();
  // Scrolls, a hover and its end, a scroll back: each a partial frame.
  await page.mouse.move(box.x + 300, box.y + 300);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 120);
  await page.mouse.wheel(0, -200);
  await evaluate(page, `document.querySelector('button').scrollIntoView(); 1`);
  const button = JSON.parse(await evaluate(page, `JSON.stringify(document.querySelector('button').getBoundingClientRect())`));
  await page.mouse.move(box.x + button.x + 10, box.y + button.y + 10);
  await page.waitForTimeout(200);
  await page.mouse.move(box.x + 500, box.y + 400);
  await page.mouse.wheel(0, 60);
  await page.waitForTimeout(400);
  const partial = await view(page).screenshot();
  await configure(page, { damage: false });
  await page.waitForTimeout(400);
  const full = await view(page).screenshot();
  expect(partial.equals(full)).toBe(true);
});

test('a blinking caret repaints a sliver, not the page', async ({ page }) => {
  await evaluate(page, `document.querySelector('input').focus(); 1`);
  await page.waitForTimeout(300);
  await frames(page);
  await page.waitForTimeout(1500);
  const stats = await frames(page);
  expect(stats.frames).toBeGreaterThan(0);
  expect(stats.area.max).toBeLessThan(0.05);
});

test('frame timings for scrolling, with and without the painting shortcuts', async ({ page }) => {
  const box = await view(page).boundingBox();
  await page.mouse.move(box.x + 300, box.y + 300);
  const run = async (args) => {
    await configure(page, args);
    await evaluate(page, 'scrollTo(0, 0); 1');
    await page.waitForTimeout(300);
    await frames(page);
    const started = Date.now();
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 40);
    await expect.poll(async () => Number(await evaluate(page, 'scrollY'))).toBe(1200);
    return { ms: Date.now() - started, ...(await frames(page)) };
  };
  const plain = await run({ paintOnInput: false, damage: false });
  const fast = await run({ paintOnInput: true, damage: true });
  console.log('scroll timings', JSON.stringify({ plain, fast }));
  expect(fast.frames).toBeGreaterThan(0);
});
