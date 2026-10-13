import { expect, test } from '@playwright/test';

// Content engines load through their profile service: pages, subresources,
// redirects, uploads, cookies from responses, WebSockets, downloads and
// history all happen in the service, which has the network and the files.
// Uses public test servers (example.com, httpbin.org, echo.websocket.org)
// through the relay, as the rest of the suite does.
const harness = (page, method, ...args) => page.evaluate(([method, args]) => window.harness[method](...args), [method, args]);
const evaluate = (page, index, source) => harness(page, 'evaluate', index, source);

async function open(page, contents = 1) {
  await page.goto('/tests/fixtures/profile-service.html');
  await page.waitForFunction(() => window.harness);
  await harness(page, 'startService');
  const indexes = [];
  for (let i = 0; i < contents; i++) {
    const index = await harness(page, 'startContent');
    await harness(page, 'connect', index);
    indexes.push(index);
  }
  return indexes;
}

// Runs `source` (an async function body) in a content engine's page and
// waits for its JSON result.
async function run(page, index, source, timeout = 60_000) {
  const key = `r${Math.random().toString(36).slice(2)}`;
  await evaluate(page, index, `window.${key} = undefined; (async () => { ${source} })().then((v) => { window.${key} = JSON.stringify({ value: v }); }, (e) => { window.${key} = JSON.stringify({ error: String(e && e.message || e) }); }); "started"`);
  let text = 'undefined';
  await expect.poll(async () => (text = await evaluate(page, index, `String(window.${key})`)), { timeout }).not.toBe('undefined');
  return JSON.parse(text);
}

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.harness?.stop()).catch(() => {});
});

test('a content engine shows an http page and fetches its subresources through the service', async ({ page }) => {
  const [content] = await open(page);
  expect(await harness(page, 'navigate', content, 'https://example.com/')).toBe('https://example.com/');
  expect(await evaluate(page, content, 'document.title')).toBe('Example Domain');
  const result = await run(page, content, `const r = await fetch('https://httpbin.org/get?from=content'); const j = await r.json(); return [r.status, j.args.from, r.headers.get('content-type')];`);
  expect(result.value).toEqual([200, 'content', 'application/json']);
});

test('redirects go hop by hop through WebCore, and uploads carry their bytes, blob parts included', async ({ page }) => {
  const [content] = await open(page);
  await harness(page, 'navigate', content, 'https://example.com/');
  const redirected = await run(page, content, `const r = await fetch('https://httpbin.org/redirect-to?url=' + encodeURIComponent('https://httpbin.org/get?hop=2')); const j = await r.json(); return [r.url, j.args.hop];`);
  expect(redirected.value).toEqual(['https://httpbin.org/get?hop=2', '2']);
  const posted = await run(page, content, `
    const form = new FormData();
    form.append('text', 'plain value');
    form.append('file', new Blob(['blob contents'], { type: 'text/plain' }), 'note.txt');
    const r = await fetch('https://httpbin.org/post', { method: 'POST', body: form });
    const j = await r.json();
    const raw = await (await fetch('https://httpbin.org/post', { method: 'POST', body: 'hi', headers: { 'content-type': 'text/plain' } })).json();
    return [j.form.text, j.files.file, raw.data];`);
  expect(posted.value).toEqual(['plain value', 'blob contents', 'hi']);
});

test('page WebSockets run in the service: text and binary both ways, close', async ({ page }) => {
  const [content] = await open(page);
  await harness(page, 'navigate', content, 'https://example.com/');
  const result = await run(page, content, `
    const socket = new WebSocket('wss://echo.websocket.org/');
    socket.binaryType = 'arraybuffer';
    const messages = [];
    let wake = () => {};
    socket.onmessage = (e) => { messages.push(e.data); wake(); };
    const until = async (test) => {
      while (!messages.some(test)) await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 15000); });
      return messages.find(test);
    };
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('could not connect')); });
    socket.send('hello');
    const text = await until((m) => m === 'hello');
    socket.send(new Uint8Array([1, 2, 3]).buffer);
    const binary = await until((m) => m instanceof ArrayBuffer);
    const closed = new Promise((resolve) => { socket.onclose = (e) => resolve([e.code, e.wasClean]); });
    socket.close(1000, 'done');
    return [text, Array.from(new Uint8Array(binary)), await closed];`);
  expect(result.value).toEqual(['hello', [1, 2, 3], [1000, true]]);
});

test('downloads and history are the service\'s, tagged with the content engine they came from', async ({ page }) => {
  const [content] = await open(page);
  await harness(page, 'navigate', content, 'https://example.com/');
  await harness(page, 'navigate', content, 'https://example.com/?visited=1');
  await evaluate(page, content, `const a = document.createElement('a'); a.href = 'https://httpbin.org/response-headers?Content-Disposition=attachment%3B%20filename%3Dnote.txt'; a.download = 'note.txt'; document.body.append(a); a.click(); "clicked"`);
  await expect.poll(() => harness(page, 'serviceEvents', 'download.finished'), { timeout: 60_000 }).toHaveLength(1);
  const [started] = await harness(page, 'serviceEvents', 'download.started');
  const [finished] = await harness(page, 'serviceEvents', 'download.finished');
  const { link } = await harness(page, 'content', content);
  expect(started).toMatchObject({ filename: 'note.txt', link });
  expect(finished.error).toBeUndefined();
  await harness(page, 'serviceSend', 'history.query', { id: 7, limit: 10 });
  await expect.poll(async () => (await harness(page, 'serviceEvents', 'history.result')).find((r) => r.id === 7)?.entries.map((e) => e.url) ?? []).toContain('https://example.com/?visited=1');
});

test('loads in flight fail when the service crashes, and work again after its restart', async ({ page }) => {
  const [content] = await open(page);
  await harness(page, 'navigate', content, 'https://example.com/');
  await evaluate(page, content, `window.slow = 'pending'; fetch('https://httpbin.org/delay/8').then(() => { slow = 'loaded'; }, (e) => { slow = 'failed'; }); "ok"`);
  await page.waitForTimeout(500);
  const restarted = page.evaluate(() => window.harness.waitRestart());
  await harness(page, 'crashService');
  await expect.poll(() => evaluate(page, content, 'slow'), { timeout: 5_000 }).toBe('failed');
  await restarted;
  await harness(page, 'connect', content);
  const again = await run(page, content, `return (await fetch('https://httpbin.org/get')).status;`);
  expect(again.value).toBe(200);
});
