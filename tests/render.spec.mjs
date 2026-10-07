import { expect, test } from '@playwright/test';

const PAGE = process.env.PAGE_PATH ?? '/';

// The share of pixels in the largest canvas that differ from its first pixel:
// zero means nothing was painted.
async function paintedRatio(page) {
  return page.evaluate(async () => {
    const all = [...document.querySelectorAll('*')].flatMap((el) => [el, ...(el.shadowRoot ? el.shadowRoot.querySelectorAll('canvas') : [])]);
    const canvases = all.filter((el) => el instanceof HTMLCanvasElement);
    const canvas = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!canvas || !canvas.width) return 0;
    const bitmap = await createImageBitmap(canvas);
    const copy = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = copy.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    let differing = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) differing++;
    }
    return differing / (data.length / 4);
  });
}

test('example.com loads and paints', async ({ page }) => {
  await page.goto(`${PAGE}?url=${encodeURIComponent('https://example.com/')}`);
  await expect(page).toHaveTitle('Example Domain', { timeout: 90_000 });
  await expect.poll(() => paintedRatio(page), { timeout: 30_000 }).toBeGreaterThan(0.001);
});
