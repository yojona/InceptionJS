import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// A document that holds no engine, and need not be cross-origin isolated,
// attaches to a profile's host with connectProfile() and shows a window of it
// on a canvas: frames, input, dialogs, videos and Web Audio all come through.
const HOST = process.env.ATTACH_PAGE ?? '/examples/attach.html';
const CLIENT = process.env.ATTACH_CLIENT ?? '/plain/tests/fixtures/client.html';
const CLIP = `data:video/webm;base64,${readFileSync(new URL('./fixtures/clip.webm', import.meta.url)).toString('base64')}`;
const view = (page) => page.locator('inception-view');
const evaluateIn = (host, window, source) => view(host).evaluate((el, [w, s]) => el.debugEvaluate(s, { window: w }), [window, source]);
const profileName = () => `display-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function startHost(context, profile, query = '') {
  const page = await context.newPage();
  await page.goto(`${HOST}?profile=${profile}&persist=clear&url=about:blank${query}`);
  await view(page).evaluate((el) => el.ready);
  return page;
}

// A client page showing a new window of the host's profile.
async function startClient(context, profile, { frames = 'auto', query = '' } = {}) {
  const page = await context.newPage();
  await page.goto(`${CLIENT}${query}`);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  await page.evaluate((profile) => window.client.connect(profile), profile);
  const id = await page.evaluate((frames) => window.client.open({ width: 400, height: 300, url: 'about:blank', frames }), frames);
  return { page, id };
}

const write = (host, id, html) => evaluateIn(host, id, `document.open(); document.write(${JSON.stringify(html)}); document.close(); document.title`);
const canvasColor = (page) => page.evaluate(async () => {
  const canvas = document.getElementById('screen');
  if (!canvas?.width) return null;
  const bitmap = await createImageBitmap(canvas);
  const copy = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
  copy.drawImage(bitmap, 0, 0);
  return Array.from(copy.getImageData(10, 10, 1, 1).data.slice(0, 3));
});

for (const frames of ['auto', 'pixels']) {
  test(`a page without isolation shows a window and drives it (${frames})`, async ({ context }) => {
    const profile = profileName();
    const host = await startHost(context, profile);
    const { page, id } = await startClient(context, profile, { frames });
    await expect.poll(() => evaluateIn(host, id, 'document.readyState'), { timeout: 30_000 }).toBe('complete');
    await write(host, id, '<title>shown</title><style>html,body{margin:0;height:100%;background:rgb(0,128,0)}</style><script>window.downs = 0; addEventListener("mousedown", () => downs++)</script>');
    await expect.poll(() => canvasColor(page), { timeout: 20_000 }).toEqual([0, 128, 0]);
    await page.locator('#screen').click({ position: { x: 30, y: 30 } });
    await expect.poll(() => evaluateIn(host, id, 'String(downs)')).toBe('1');
    await expect.poll(() => evaluateIn(host, id, 'innerWidth + "x" + innerHeight')).toBe('400x300');
    // The window's state and tabs are the client's too.
    await evaluateIn(host, id, 'document.title');
    await expect.poll(() => page.evaluate(() => window.remote.title)).toBe('shown');
    // Closing the client closes the window it was given; the host is untouched.
    await page.close();
    await expect.poll(() => view(host).evaluate((el) => el.windows.map((w) => w.window))).toEqual([1]);
  });
}

test('dialogs are raised in the tab that shows the window', async ({ context }) => {
  const profile = profileName();
  const host = await startHost(context, profile);
  const { page, id } = await startClient(context, profile);
  // Dialogs of a window nobody displays end up on its handle on the host.
  await view(host).evaluate((el, id) => {
    window.hostDialogs = 0;
    window.hostBlocked = 0;
    for (const target of [el, el.window(id)]) {
      target.addEventListener('dialog', () => window.hostDialogs++);
      target.addEventListener('dialogblocked', () => window.hostBlocked++);
    }
  }, id);
  await expect.poll(() => evaluateIn(host, id, 'document.readyState'), { timeout: 30_000 }).toBe('complete');
  // Nobody there to answer: the display's policy (dismiss) applies, not the host's.
  await page.evaluate(() => {
    window.blocked = [];
    document.getElementById('screen').addEventListener('dialogblocked', (e) => window.blocked.push(e.detail.type));
  });
  expect(await evaluateIn(host, id, 'String(confirm("silent?"))')).toBe('false');
  expect(await page.evaluate(() => window.blocked)).toEqual(['confirm']);
  await page.evaluate(() => {
    window.asked = [];
    document.getElementById('screen').addEventListener('dialog', (e) => {
      e.preventDefault();
      const { type, message, defaultValue } = e.detail;
      window.asked.push({ type, message, defaultValue });
      e.detail.respond(type === 'confirm' ? true : type === 'prompt' ? 'typed' : null);
    });
  });
  expect(await evaluateIn(host, id, 'String(confirm("sure?"))')).toBe('true');
  expect(await evaluateIn(host, id, 'String(prompt("name?", "dflt"))')).toBe('typed');
  expect(await evaluateIn(host, id, 'String(alert("hello"))')).toBe('undefined');
  expect(await page.evaluate(() => window.asked)).toEqual([
    { type: 'confirm', message: 'sure?' },
    { type: 'prompt', message: 'name?', defaultValue: 'dflt' },
    { type: 'alert', message: 'hello' },
  ]);
  // The host's view never heard of them.
  expect(await view(host).evaluate(() => [window.hostDialogs, window.hostBlocked])).toEqual([0, 0]);

  // A window nobody displays has its dialogs answered by the host's own policy.
  await page.evaluate(() => window.remote.hide());
  await expect.poll(() => view(host).evaluate((el) => el.windows.find((w) => w.window === el.windows[1].window).visible)).toBe(false);
  expect(await evaluateIn(host, id, 'String(confirm("anyone?"))')).toBe('false');
  expect(await view(host).evaluate(() => window.hostBlocked)).toBe(1);
});

test('a video plays in the tab that shows the window, and the page sees it play', async ({ context }) => {
  const profile = profileName();
  const host = await startHost(context, profile);
  const { page, id } = await startClient(context, profile);
  await expect.poll(() => evaluateIn(host, id, 'document.readyState'), { timeout: 30_000 }).toBe('complete');
  // The person uses the tab that shows the window; videos may play with sound after that.
  await page.locator('#screen').click({ position: { x: 5, y: 5 } });
  await evaluateIn(host, id, `document.body.style.margin = "0"; window.vid = document.createElement("video"); vid.style.cssText = "width:320px;height:240px;display:block"; document.body.append(vid); vid.src = ${JSON.stringify(CLIP)}; vid.loop = true; vid.play().then(() => { window.played = true; }, (e) => { window.played = String(e); }); "ok"`);
  await expect.poll(() => page.evaluate(() => { const v = document.querySelector('video'); return !!v && !v.paused && v.currentTime > 0.3; }), { timeout: 30_000 }).toBe(true);
  // Placed where the page put it, under the canvas, and playing with sound.
  expect(await page.evaluate(() => { const v = document.querySelector('video'); return `${v.style.width}x${v.style.height} ${v.muted}`; })).toBe('320pxx240px false');
  // The page's own element follows the one that plays.
  const progress = async () => Number(await evaluateIn(host, id, 'vid.currentTime.toFixed(2)'));
  const before = await progress();
  await expect.poll(progress, { timeout: 10_000 }).toBeGreaterThan(before);
  expect(await evaluateIn(host, id, 'String(window.played)')).toBe('true');
  // Pausing from the page pauses the display's video.
  await evaluateIn(host, id, 'vid.pause(); "ok"');
  await expect.poll(() => page.evaluate(() => document.querySelector('video').paused)).toBe(true);
});

test('Web Audio of the window arrives as samples and plays once the person has used the tab', async ({ context }) => {
  const profile = profileName();
  // An engine per window: its audio is the window's.
  const host = await startHost(context, profile, '&isolation=window');
  const { page, id } = await startClient(context, profile);
  await expect.poll(() => evaluateIn(host, id, 'document.readyState'), { timeout: 30_000 }).toBe('complete');
  await evaluateIn(host, id, 'window.ctx = new AudioContext(); const o = ctx.createOscillator(); o.frequency.value = 440; const g = ctx.createGain(); g.gain.value = 0.5; o.connect(g).connect(ctx.destination); o.start(); ctx.resume(); ctx.state');
  const stats = () => page.evaluate(() => ({ ...window.remote.display.audio.stats }));
  await expect.poll(async () => (await stats()).chunks, { timeout: 20_000 }).toBeGreaterThan(10);
  // Where the browser holds sound back until the person has used the page, it
  // waits for that; the browser the tests run in may not (Playwright's
  // Chrome starts with autoplay allowed).
  await page.locator('#screen').click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => (await stats()).state, { timeout: 10_000 }).toBe('running');
  const heard = await stats();
  expect(heard.peak).toBeGreaterThan(0.45);
  expect(heard.peak).toBeLessThan(0.55);
  // The engine's clock runs in real time: the samples are drained as they are made.
  const t = Number(await evaluateIn(host, id, 'ctx.currentTime.toFixed(2)'));
  await expect.poll(async () => Number(await evaluateIn(host, id, 'ctx.currentTime.toFixed(2)')), { timeout: 10_000 }).toBeGreaterThan(t + 1);
  await expect.poll(async () => (await stats()).frames, { timeout: 10_000 }).toBeGreaterThan(heard.frames);
});

test('Web Audio of a window of the host\'s one engine plays in the tab that shows the window', async ({ context }) => {
  const profile = profileName();
  // One engine for every window: audio.open says which window made the context.
  const host = await startHost(context, profile);
  const { page, id } = await startClient(context, profile);
  await expect.poll(() => evaluateIn(host, id, 'document.readyState'), { timeout: 30_000 }).toBe('complete');
  await evaluateIn(host, id, 'window.ctx = new AudioContext(); const o = ctx.createOscillator(); o.frequency.value = 440; const g = ctx.createGain(); g.gain.value = 0.5; o.connect(g).connect(ctx.destination); o.start(); ctx.resume(); ctx.state');
  const stats = () => page.evaluate(() => ({ ...window.remote.display.audio.stats }));
  await expect.poll(async () => (await stats()).chunks, { timeout: 20_000 }).toBeGreaterThan(10);
  await page.locator('#screen').click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => (await stats()).peak, { timeout: 10_000 }).toBeGreaterThan(0.45);
});

test('fullscreen a page asks for puts the showing tab\'s canvas in fullscreen, and leaving it there tells the page', async ({ context }) => {
  const profile = profileName();
  const host = await startHost(context, profile);
  const { page, id } = await startClient(context, profile);
  await expect.poll(() => evaluateIn(host, id, 'document.readyState'), { timeout: 30_000 }).toBe('complete');
  await write(host, id, '<title>fs</title><body style="margin:0;height:100vh"><script>window.changes = []; document.addEventListener("fullscreenchange", () => changes.push(!!document.fullscreenElement)); document.body.onclick = () => document.documentElement.requestFullscreen().then(() => changes.push("ok"), (e) => changes.push("refused " + e.name));</script></body>');
  await expect.poll(() => evaluateIn(host, id, 'String(window.changes?.length)')).toBe('0');
  await page.locator('#screen').click({ position: { x: 50, y: 50 } });
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null), { timeout: 10_000 }).toBe('screen');
  await expect.poll(() => evaluateIn(host, id, 'JSON.stringify(changes)'), { timeout: 10_000 }).toContain('"ok"');
  expect(await evaluateIn(host, id, 'String(!!document.fullscreenElement)')).toBe('true');
  // The person leaves fullscreen in the tab that shows it.
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => evaluateIn(host, id, 'String(!!document.fullscreenElement)'), { timeout: 10_000 }).toBe('false');
});

test('EME of a window runs in the tab that shows it, with that browser\'s CDM', async ({ context }) => {
  const profile = profileName();
  // An engine per window: its EME objects are that window's.
  const host = await startHost(context, profile, '&isolation=window');
  const { page, id } = await startClient(context, profile);
  await page.evaluate(() => {
    window.accessRequests = 0;
    const original = navigator.requestMediaKeySystemAccess.bind(navigator);
    navigator.requestMediaKeySystemAccess = (...args) => { window.accessRequests++; return original(...args); };
  });
  await expect.poll(() => evaluateIn(host, id, 'document.readyState'), { timeout: 30_000 }).toBe('complete');
  await evaluateIn(host, id, `(async () => {
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
      window.emeResult = JSON.stringify({ keySystem: access.keySystem, statuses: seen });
    } catch (e) {
      window.emeResult = 'error: ' + e;
    }
  })(), 'started'`);
  await expect.poll(() => evaluateIn(host, id, 'emeResult'), { timeout: 30_000 }).toBe(JSON.stringify({ keySystem: 'org.w3.clearkey', statuses: ['usable'] }));
  expect(await page.evaluate(() => window.accessRequests)).toBeGreaterThan(0);
});

test('a file chosen in the tab that shows the window reaches the page', async ({ context }) => {
  const profile = profileName();
  const host = await startHost(context, profile);
  const { page, id } = await startClient(context, profile);
  await expect.poll(() => evaluateIn(host, id, 'document.readyState'), { timeout: 30_000 }).toBe('complete');
  await write(host, id, '<title>files</title><body style="margin:0"><input type="file" id="f" style="width:300px;height:100px;display:block">');
  await page.evaluate(() => {
    window.pickers = 0;
    document.getElementById('screen').addEventListener('filechooser', (e) => {
      e.preventDefault();
      window.pickers++;
      e.detail.choose([new File(['hello from the other tab'], 'note.txt', { type: 'text/plain' })]);
    });
  });
  await expect.poll(() => evaluateIn(host, id, 'document.getElementById("f") ? "ready" : "no"')).toBe('ready');
  await page.locator('#screen').click({ position: { x: 40, y: 20 } });
  await expect.poll(() => evaluateIn(host, id, 'String(document.getElementById("f").files.length)'), { timeout: 20_000 }).toBe('1');
  expect(await page.evaluate(() => window.pickers)).toBe(1);
  expect(await evaluateIn(host, id, 'document.getElementById("f").files[0].name')).toBe('note.txt');
  await evaluateIn(host, id, 'window.text = ""; document.getElementById("f").files[0].text().then((t) => { window.text = t; }); "ok"');
  await expect.poll(() => evaluateIn(host, id, 'window.text')).toBe('hello from the other tab');
});

test('a copy the page makes reaches the clipboard of the tab that shows the window', async ({ context }) => {
  const profile = profileName();
  const host = await startHost(context, profile);
  const { page, id } = await startClient(context, profile);
  await expect.poll(() => evaluateIn(host, id, 'document.readyState'), { timeout: 30_000 }).toBe('complete');
  // The clipboard of the tab, observed instead of the system's.
  await page.evaluate(() => {
    window.copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { write: async (items) => { for (const item of items) window.copied.push(await (await item.getType('text/plain')).text()); }, writeText: async (text) => window.copied.push(text) } });
  });
  await write(host, id, '<title>copy</title><body style="margin:0"><button id="c" style="width:300px;height:100px" onclick="const t = document.createElement(\'textarea\'); t.value = \'copied text\'; document.body.append(t); t.select(); document.execCommand(\'copy\'); t.remove()">copy</button>');
  await expect.poll(() => evaluateIn(host, id, 'document.getElementById("c") ? "ready" : "no"')).toBe('ready');
  await page.locator('#screen').click({ position: { x: 40, y: 20 } });
  await expect.poll(() => page.evaluate(() => window.copied), { timeout: 20_000 }).toEqual(['copied text']);
});

test('a window keeps painting for the tab that shows it while the engine\'s tab is in the background', async ({ context }) => {
  const profile = profileName();
  // A background tab: not visible, and no animation frames.
  const host = await context.newPage();
  await host.addInitScript(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { get: () => true });
    window.requestAnimationFrame = () => 0;
  });
  await host.goto(`${HOST}?profile=${profile}&persist=clear&url=about:blank`);
  await view(host).evaluate((el) => el.ready);
  const { page, id } = await startClient(context, profile);
  await expect.poll(() => evaluateIn(host, id, 'document.readyState'), { timeout: 30_000 }).toBe('complete');
  await write(host, id, '<title>background</title><style>html,body{margin:0;height:100%;background:rgb(10,120,200)}</style>');
  await expect.poll(() => canvasColor(page), { timeout: 20_000 }).toEqual([10, 120, 200]);
  // It goes on painting: a page animating its background shows new colours.
  await evaluateIn(host, id, 'window.n = 0; setInterval(() => { document.body.style.background = "rgb(" + (++n % 200) + ",30,30)"; }, 30); "ok"');
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    seen.add(JSON.stringify(await canvasColor(page)));
    await page.waitForTimeout(100);
  }
  expect(seen.size).toBeGreaterThan(3);
});
