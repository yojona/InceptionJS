import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { startRelay } from '../packages/inceptionjs/src/server/index.js';

// Media sources play while they download when their size is unknown (a live
// stream) or too large to hold, and their format allows: MP3 and AAC go to a
// MediaSource as they arrive instead of waiting for the whole file.
const PAGE = process.env.PAGE_PATH ?? '/';
const TONE = readFileSync(new URL('./fixtures/tone.mp3', import.meta.url));
const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);

let relay;
let media;
const live = new Set();
test.beforeAll(async () => {
  // /live.mp3 never ends; /short.mp3?n=3 sends n seconds and ends. Neither
  // says how long it is.
  media = createServer((req, res) => {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
    let left = pathname === '/live.mp3' ? Infinity : Number(searchParams.get('n') ?? 3);
    const send = () => {
      if (left-- <= 0) return res.end();
      res.write(TONE);
      timer = setTimeout(send, 500);
    };
    let timer;
    live.add(res);
    res.on('close', () => { clearTimeout(timer); live.delete(res); });
    send();
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => media.once('listening', resolve));
  relay = await startRelay({ port: 0, dev: true, devPorts: [media.address().port] });
});
test.afterAll(async () => {
  for (const res of live) res.destroy();
  media?.close();
  await relay?.close?.();
});

test.beforeEach(async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank&relay=ws://127.0.0.1:${relay.port}/`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => evaluate(page, `document.title = 'media'; document.title`), { timeout: 60_000 }).toBe('media');
});

const listen = (page, path) => evaluate(page, `(() => {
  const audio = window.audio = new Audio('http://127.0.0.1:${media.address().port}${path}');
  window.events = [];
  for (const type of ['playing', 'ended', 'error']) audio.addEventListener(type, () => events.push(type));
  audio.play().catch(() => {});
  return 'x';
})()`);

test('a live MP3 stream plays while it downloads', async ({ page }) => {
  await listen(page, '/live.mp3');
  await expect.poll(async () => Number(await evaluate(page, 'audio.currentTime')), { timeout: 30_000 }).toBeGreaterThan(1);
  expect(await evaluate(page, 'String(audio.error)')).toBe('null');
});

test('a streamed MP3 of unknown length ends when its download does', async ({ page }) => {
  await listen(page, '/short.mp3?n=3');
  await expect.poll(() => evaluate(page, 'events.join()'), { timeout: 30_000 }).toContain('ended');
  expect(await evaluate(page, 'events.join()')).not.toContain('error');
  expect(await evaluate(page, 'Math.round(audio.duration)')).toBe('3');
});
