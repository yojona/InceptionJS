import { expect, test } from '@playwright/test';

// Browsers keep four WebGL contexts per worker and lose the oldest past that,
// and the engine's own context is the oldest. Pages are held to three, so
// however many contexts a page asks for and keeps drawing with, the engine
// never loses its own.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);

test('a page holding many live WebGL contexts never costs the engine its own', async ({ page }) => {
  const lostEngine = [];
  page.on('console', (m) => { if (/the engine lost its WebGL context/.test(m.text())) lostEngine.push(m.text()); });
  await page.goto(`${PAGE}?url=about:blank`);
  expect(await view(page).evaluate((el) => el.ready.then((r) => r.webglContexts))).toBe(3);
  await expect.poll(() => evaluate(page, '1 + 1'), { timeout: 60_000 }).toBe('2');
  const lost = await evaluate(page, `(() => {
    window.contexts = [];
    let lost = 0;
    for (let i = 0; i < 12; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 8;
      canvas.addEventListener('webglcontextlost', () => lost++);
      document.body.append(canvas);
      contexts.push(canvas.getContext(i % 2 ? 'webgl' : 'webgl2'));
    }
    // All of them stay in use, every frame, for a while.
    let frames = 0;
    (function draw() {
      contexts.forEach((gl, i) => { gl.clearColor(i / 12, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); });
      if (++frames < 60) requestAnimationFrame(draw);
    })();
    return String(lost);
  })()`);
  expect(lost).toBe('0');
  await page.waitForTimeout(2000);
  expect(await evaluate(page, 'String(contexts.filter((gl) => gl.isContextLost()).length)')).toBe('0');
  expect(lostEngine).toEqual([]);
  // The engine still paints.
  await evaluate(page, `document.body.style.margin = '0'; document.body.innerHTML = '<div style="width:100px;height:100px;background:rgb(255,0,0)"></div>'; 'ok'`);
  await expect.poll(() => page.evaluate(async () => {
    const canvas = document.querySelector('inception-view').shadowRoot.querySelector('canvas');
    const bitmap = await createImageBitmap(canvas);
    const copy = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    copy.drawImage(bitmap, 0, 0);
    return [...copy.getImageData(10, 10, 1, 1).data.slice(0, 3)];
  }), { timeout: 20_000 }).toEqual([255, 0, 0]);
});
