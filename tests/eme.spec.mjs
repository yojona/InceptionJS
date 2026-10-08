import { expect, test } from '@playwright/test';

const PAGE = process.env.PAGE_PATH ?? '/';

const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);

test.beforeEach(async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  await view(page).evaluate((el) => el.ready);
});

// ClearKey needs no license server: the page answers the license request with
// the key itself, which exercises the whole relay with the host's CDM.
test('a ClearKey session runs end to end through the host CDM', async ({ page }) => {
  await evaluate(page, `(async () => {
    const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    const kid = new Uint8Array(16).fill(1), key = new Uint8Array(16).fill(2);
    window.emeResult = 'pending';
    try {
      const access = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{ initDataTypes: ['keyids'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }]);
      const keys = await access.createMediaKeys();
      const session = keys.createSession();
      const message = new Promise((resolve) => session.addEventListener('message', (e) => resolve(e), { once: true }));
      const statuses = new Promise((resolve) => session.addEventListener('keystatuseschange', resolve, { once: true }));
      await session.generateRequest('keyids', new TextEncoder().encode(JSON.stringify({ kids: [b64url(kid)] })));
      const request = JSON.parse(new TextDecoder().decode((await message).message));
      await session.update(new TextEncoder().encode(JSON.stringify({ keys: [{ kty: 'oct', kid: request.kids[0], k: b64url(key) }] })));
      await statuses;
      const seen = [];
      session.keyStatuses.forEach((status) => seen.push(status));
      window.emeResult = JSON.stringify({ keySystem: access.keySystem, messageType: (await message).messageType, statuses: seen });
    } catch (e) {
      window.emeResult = 'error: ' + e;
    }
  })(), 'started'`);
  await expect.poll(() => evaluate(page, 'emeResult'), { timeout: 30_000 }).toBe(JSON.stringify({ keySystem: 'org.w3.clearkey', messageType: 'license-request', statuses: ['usable'] }));
});

test('an unknown key system is rejected cleanly', async ({ page }) => {
  await evaluate(page, `navigator.requestMediaKeySystemAccess('com.example.nothing', [{ videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }]).then(() => { window.emeReject = 'resolved'; }, (e) => { window.emeReject = e.name; }), 'started'`);
  await expect.poll(() => evaluate(page, 'String(window.emeReject)'), { timeout: 20_000 }).toBe('NotSupportedError');
});

// A player moving on to its next track loads a new source on the same element
// with the same MediaKeys; each load is a new host video, and the keys must
// follow it there instead of staying with the previous one.
test('MediaKeys follow the element across source changes', async ({ page }) => {
  // On an http page: blob URLs made in about:blank do not load in this engine yet.
  await page.goto(`${PAGE}?url=https://example.com/`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => evaluate(page, 'location.host + " " + document.readyState'), { timeout: 30_000 }).toBe('example.com complete');
  const warnings = [];
  page.on('console', (m) => { if (/setMediaKeys|releasing MediaKeys/.test(m.text())) warnings.push(m.text()); });
  await evaluate(page, `(async () => {
    window.swapResult = 'pending';
    try {
      const access = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{ initDataTypes: ['keyids'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }]);
      const keys = await access.createMediaKeys();
      const video = document.createElement('video');
      document.body.append(video);
      await video.setMediaKeys(keys);
      for (let track = 0; track < 3; track++) {
        const source = new MediaSource();
        const open = new Promise((resolve) => source.addEventListener('sourceopen', resolve, { once: true }));
        video.src = URL.createObjectURL(source);
        await open;
        source.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      window.swapResult = video.mediaKeys === keys ? 'kept' : 'lost';
    } catch (e) {
      window.swapResult = 'error: ' + e;
    }
  })(), 'started'`);
  await expect.poll(() => evaluate(page, 'swapResult'), { timeout: 30_000 }).toBe('kept');
  await page.waitForTimeout(1000);
  expect(warnings).toEqual([]);
});

// A player that holds playbackRate at 0 until its element un-stalls (as some
// streaming players do while rebuffering) must see the stall end once the
// license makes its key usable, even if media data arrived before it.
test('a key becoming usable ends the stall for a player holding rate 0', async ({ page }) => {
  await page.goto(`${PAGE}?url=https://example.com/`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => evaluate(page, 'location.host + " " + document.readyState'), { timeout: 30_000 }).toBe('example.com complete');
  await evaluate(page, `(async () => {
    window.stall = [];
    const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    const base = 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_480x270_600k/bbb_30fps_480x270_600k_';
    const access = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{ initDataTypes: ['keyids'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.64001e"' }] }]);
    const keys = await access.createMediaKeys();
    const video = document.createElement('video');
    video.muted = true;
    document.body.append(video);
    await video.setMediaKeys(keys);
    video.playbackRate = 0;
    let usable = false;
    for (const type of ['waiting', 'canplaythrough', 'playing']) video.addEventListener(type, () => {
      window.stall.push((usable ? 'after:' : 'before:') + type);
      if (usable && type === 'canplaythrough') video.playbackRate = 1;
    });
    const source = new MediaSource();
    video.src = URL.createObjectURL(source);
    await new Promise((r) => source.addEventListener('sourceopen', r, { once: true }));
    const sb = source.addSourceBuffer('video/mp4; codecs="avc1.64001e"');
    for (const part of ['0.m4v', '1.m4v', '2.m4v']) {
      sb.appendBuffer(await (await fetch(base + part)).arrayBuffer());
      await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
    }
    await video.play();
    await new Promise((r) => setTimeout(r, 1500));
    const session = keys.createSession();
    const message = new Promise((r) => session.addEventListener('message', r, { once: true }));
    await session.generateRequest('keyids', new TextEncoder().encode(JSON.stringify({ kids: [b64url(new Uint8Array(16).fill(1))] })));
    const kid = JSON.parse(new TextDecoder().decode((await message).message)).kids[0];
    usable = true;
    await session.update(new TextEncoder().encode(JSON.stringify({ keys: [{ kty: 'oct', kid, k: b64url(new Uint8Array(16).fill(2)) }] })));
    window.stallVideo = video;
  })(), 'x'`);
  await expect.poll(() => evaluate(page, 'JSON.stringify(window.stall.filter((e) => e.startsWith("after:")))'), { timeout: 30_000 }).toContain('after:canplaythrough');
  await expect.poll(() => evaluate(page, 'String(window.stallVideo && window.stallVideo.currentTime > 0.5)'), { timeout: 20_000 }).toBe('true');
});
