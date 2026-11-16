import { expect, test } from '@playwright/test';

// Fonts: emoji paint in color even where a text font has outline glyphs for
// them, and the CJK font, which the engine does not bundle, arrives when a
// page needs it ('on-demand'), right after the first frame ('background', and
// 'auto', the default, on a fast connection) or never ('off').
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);
const write = (page, html) => evaluate(page, `document.open(); document.write(${JSON.stringify(html)}); document.close(); document.title`);

const open = async (page, query = '') => {
  await page.goto(`${PAGE}?url=about:blank${query}`);
  await view(page).evaluate((el) => el.ready);
};

// Saturated colors in a box of the view's canvas.
const colorsIn = (page, box) => view(page).evaluate((el, box) => {
  const canvas = el.shadowRoot.querySelector('canvas');
  const scale = canvas.width / el.clientWidth;
  const copy = new OffscreenCanvas(canvas.width, canvas.height).getContext('2d');
  copy.drawImage(canvas, 0, 0);
  const data = copy.getImageData(box.x * scale, box.y * scale, box.width * scale, box.height * scale).data;
  const colors = new Set();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 60) colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
  }
  return colors.size;
}, box);

// Eleven CJK characters at 40px: about 440px wide with the CJK font (Hangul
// is a little narrower), about 260 as missing-glyph boxes.
const CJK_PAGE = '<title>cjk</title><body style="margin:0"><span id="t" style="font:40px sans-serif">你好世界日本語한국어漢</span></body>';
const cjkWidth = async (page) => Math.round(Number(await evaluate(page, "document.getElementById('t').getBoundingClientRect().width")));

test('smileys that DejaVu Sans also has paint in color', async ({ page }) => {
  await open(page);
  await expect.poll(() => write(page, '<title>smiley</title><body style="margin:0;background:#fff"><span style="font:48px sans-serif">😀😂😍</span></body>')).toBe('smiley');
  await page.waitForTimeout(500);
  expect(await colorsIn(page, { x: 0, y: 0, width: 160, height: 60 })).toBeGreaterThan(20);
});

test('the CJK font arrives when a page first needs it', async ({ page }) => {
  await open(page, '&fonts-cjk=on-demand');
  await expect.poll(() => write(page, CJK_PAGE)).toBe('cjk');
  await expect.poll(() => cjkWidth(page), { timeout: 30_000 }).toBeGreaterThan(400);
});

test("with fonts.cjk 'off', CJK text stays without its font", async ({ page }) => {
  await open(page, '&fonts-cjk=off');
  await expect.poll(() => write(page, CJK_PAGE)).toBe('cjk');
  await page.waitForTimeout(3000);
  expect(await cjkWidth(page)).toBeLessThan(300);
});

test("by default ('auto'), the CJK font loads after the first frame, before any page needs it", async ({ page }) => {
  const fetched = page.waitForRequest((request) => request.url().endsWith('inception-engine-cjk.ttc'), { timeout: 30_000 });
  await open(page);
  await fetched;
  await expect.poll(() => write(page, CJK_PAGE)).toBe('cjk');
  await expect.poll(() => cjkWidth(page), { timeout: 10_000 }).toBeGreaterThan(400);
});

test("with fonts.cjk 'on-demand', a page without CJK text loads no CJK font", async ({ page }) => {
  let fetched = false;
  page.on('request', (request) => { if (request.url().endsWith('inception-engine-cjk.ttc')) fetched = true; });
  await open(page, '&fonts-cjk=on-demand');
  await expect.poll(() => write(page, '<title>latin</title><p>Hello</p>')).toBe('latin');
  await page.waitForTimeout(2000);
  expect(fetched).toBe(false);
});
