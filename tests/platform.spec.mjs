import { expect, test } from '@playwright/test';

const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);
const settle = (page, source, timeout = 20_000) => expect.poll(() => evaluate(page, source), { timeout });

test.beforeEach(async ({ page }) => {
  await page.goto(`${PAGE}?url=https://example.com/`);
  await view(page).evaluate((el) => el.ready);
  await settle(page, 'location.host + " " + document.readyState', 30_000).toBe('example.com complete');
});

test('Web Audio renders offline and runs a live context', async ({ page }) => {
  await evaluate(page, `(async () => {
    const offline = new OfflineAudioContext(1, 4800, 48000);
    const oscillator = new OscillatorNode(offline, { frequency: 440 });
    oscillator.connect(offline.destination);
    oscillator.start();
    const buffer = await offline.startRendering();
    const peak = Math.max(...buffer.getChannelData(0).map(Math.abs));
    const live = new AudioContext();
    window.audioResult = JSON.stringify({ length: buffer.length, loud: peak > 0.5, state: live.state });
  })(), 'x'`);
  const result = JSON.parse(await settle(page, 'String(window.audioResult)').not.toBe('undefined').then(() => evaluate(page, 'audioResult')));
  expect(result.length).toBe(4800);
  expect(result.loud).toBe(true);
  expect(['running', 'suspended']).toContain(result.state);
});

test('capabilities the embedder did not grant exist and refuse', async ({ page }) => {
  await evaluate(page, `(async () => {
    const out = {};
    out.notification = await Notification.requestPermission();
    out.geolocation = await new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('granted'), (e) => resolve(e.code)));
    out.rtc = await new RTCPeerConnection().createOffer().then(() => 'offered', (e) => e.name);
    out.camera = await navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted', (e) => e.name);
    out.speech = typeof speechSynthesis.speak;
    out.session = typeof navigator.mediaSession.setActionHandler;
    out.beacon = navigator.sendBeacon('https://example.com/inception-beacon', 'ping');
    window.capResult = JSON.stringify(out);
  })(), 'x'`);
  await settle(page, 'String(window.capResult)').not.toBe('undefined');
  expect(JSON.parse(await evaluate(page, 'capResult'))).toEqual({ notification: 'denied', geolocation: 1, rtc: 'NotAllowedError', camera: 'NotAllowedError', speech: 'function', session: 'function', beacon: true });
});

test('back, forward, history, find and zoom', async ({ page }) => {
  const el = view(page);
  await el.evaluate((v) => v.navigate('https://www.iana.org/help/example-domains'));
  await settle(page, 'location.host', 30_000).toBe('www.iana.org');
  await expect.poll(() => el.evaluate((v) => v.canGoBack)).toBe(true);
  await el.evaluate((v) => v.back());
  await settle(page, 'location.host', 30_000).toBe('example.com');
  await expect.poll(() => el.evaluate((v) => v.canGoForward)).toBe(true);
  const history = await el.evaluate((v) => v.history({ text: 'iana' }));
  expect(history[0].url).toContain('iana.org');
  const found = await el.evaluate((v) => v.find('example'));
  expect(found.found).toBe(true);
  expect(found.matches).toBeGreaterThan(0);
  await el.evaluate((v) => v.zoom(2));
  await settle(page, 'String(Math.round(document.documentElement.getBoundingClientRect().width))').not.toBe('0');
});

test('a download reaches the host as a file', async ({ page }) => {
  const result = await view(page).evaluate((el) => new Promise((resolve) => {
    el.addEventListener('downloadfinish', (e) => {
      e.preventDefault();
      resolve({ filename: e.detail.filename, size: e.detail.blob?.size ?? 0, error: e.detail.error ?? null });
    }, { once: true });
    el.download('https://www.iana.org/robots.txt');
  }));
  expect(result.error).toBeNull();
  expect(result.filename).toBe('robots.txt');
  expect(result.size).toBeGreaterThan(0);
});

test('a second view on an open profile says so in the view', async ({ page, context }) => {
  const second = await context.newPage();
  await second.goto(`${PAGE}?url=about:blank`);
  const message = second.locator('inception-view').locator('.message');
  await expect(message).toContainText('already open in another tab', { timeout: 20_000 });
  await second.close();
});
