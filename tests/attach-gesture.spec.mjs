import { expect, test } from '@playwright/test';

// A browser holds sound back until the person has used the page. The samples
// of a window shown by this page queue up and play after the first gesture in
// it. Playwright's browsers let pages play at once, so the page here gets an
// AudioContext that behaves like a person's browser: it refuses to run until
// a pointer or key event has reached the page.
const HOST = process.env.ATTACH_PAGE ?? '/examples/attach.html';
const CLIENT = process.env.ATTACH_CLIENT ?? '/plain/tests/fixtures/client.html';
const view = (page) => page.locator('inception-view');
const evaluateIn = (host, window, source) => view(host).evaluate((el, [w, s]) => el.debugEvaluate(s, { window: w }), [window, source]);

test('the display keeps the samples and plays them after the first gesture', async ({ context }) => {
  const profile = `gesture-${Date.now()}`;
  const host = await context.newPage();
  await host.goto(`${HOST}?profile=${profile}&persist=clear&url=about:blank&isolation=window`);
  await view(host).evaluate((el) => el.ready);
  const page = await context.newPage();
  await page.addInitScript(() => {
    const Real = window.AudioContext;
    let allowed = false;
    for (const type of ['pointerdown', 'keydown', 'touchend']) addEventListener(type, () => { allowed = true; }, true);
    window.AudioContext = class extends Real {
      get state() { return allowed ? super.state : 'suspended'; }
      resume() { return allowed ? super.resume() : Promise.reject(new DOMException('The AudioContext was not allowed to start.', 'NotAllowedError')); }
    };
  });
  await page.goto(CLIENT);
  await page.evaluate((profile) => window.client.connect(profile), profile);
  const id = await page.evaluate(() => window.client.open({ width: 400, height: 300, url: 'about:blank' }));
  await expect.poll(() => evaluateIn(host, id, 'document.readyState'), { timeout: 30_000 }).toBe('complete');
  await evaluateIn(host, id, 'window.ctx = new AudioContext(); const o = ctx.createOscillator(); o.connect(ctx.destination); o.start(); ctx.resume(); ctx.state');
  const stats = () => page.evaluate(() => ({ ...window.remote.display.audio.stats }));
  await expect.poll(async () => (await stats()).chunks, { timeout: 20_000 }).toBeGreaterThan(10);
  expect((await stats()).state).toBe('suspended');
  await page.locator('#screen').click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => (await stats()).state, { timeout: 10_000 }).toBe('running');
  const before = (await stats()).frames;
  await expect.poll(async () => (await stats()).frames, { timeout: 10_000 }).toBeGreaterThan(before);
});
