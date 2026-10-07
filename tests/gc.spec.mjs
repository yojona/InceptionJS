import { expect, test } from '@playwright/test';

const PAGE = process.env.PAGE_PATH ?? '/';
const MB = 1024 * 1024;

const view = (page) => page.locator('inception-view');
const heap = (page) => view(page).evaluate((el) => el.debugHeap());
const crashes = (page) => page.evaluate(() => window.__crashes);

async function open(page, url) {
  await page.addInitScript(() => {
    window.__crashes = [];
    addEventListener('DOMContentLoaded', () => {
      document.querySelector('inception-view')?.addEventListener('crash', (e) => window.__crashes.push(e.detail));
    });
  });
  await page.goto(`${PAGE}?url=${encodeURIComponent(url)}`);
}

// A script-heavy page churns the heap; collections that started mid-call used
// to free live cells and abort within seconds.
test('a script-heavy page runs for a minute without crashing', async ({ page }) => {
  test.setTimeout(180_000);
  await open(page, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  await expect(page).toHaveTitle(/YouTube/, { timeout: 60_000 });
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(10_000);
    expect(await crashes(page)).toEqual([]);
  }
  const { heapSize, memory } = await heap(page);
  console.log(`heap ${Math.round(heapSize / MB)} MB, wasm memory ${Math.round(memory / MB)} MB`);
});

// Collections wait for the event loop, so one long task holds all its garbage;
// it must still finish and the next turn must reclaim it.
test('a long allocating task finishes and its garbage is reclaimed', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page, 'https://example.com/');
  await expect(page).toHaveTitle('Example Domain', { timeout: 60_000 });
  const churn = `(() => { let keep = 0; for (let i = 0; i < 4e6; i++) { const o = { i, s: 'x' + i, a: [i, i] }; keep += o.a.length; } return keep; })()`;
  const result = await view(page).evaluate((el, source) => el.debugEvaluate(source), churn);
  expect(result).toBe(String(8e6));
  const peak = await heap(page);
  await page.waitForTimeout(5_000);
  const after = await heap(page);
  console.log(`after task ${Math.round(peak.heapSize / MB)} MB, later ${Math.round(after.heapSize / MB)} MB, wasm memory ${Math.round(after.memory / MB)} MB`);
  expect(after.heapSize).toBeLessThan(64 * MB);
  expect(await crashes(page)).toEqual([]);
});
