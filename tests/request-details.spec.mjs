import { expect, test } from '@playwright/test';
import { startRelay } from '../packages/inceptionjs/src/server/index.js';

// Details of requests and responses the engine used to get wrong, the same in
// a standalone engine and in a content engine whose loads a profile service
// makes: Response.redirected after a redirect to another origin, a body
// without a type sent as it is, and document.cookie in a JSON document.
const harness = (page, method, ...args) => page.evaluate(([method, args]) => window.harness[method](...args), [method, args]);

let relay;
test.beforeAll(async () => {
  relay = await startRelay({ port: 0 });
});
test.afterAll(async () => {
  await relay?.close?.();
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.harness?.stop()).catch(() => {});
});

// Runs `source` (the body of an async function) in the engine's page and
// returns its JSON result.
const run = (page, index, source) => page.evaluate(async ([index, source]) => {
  await window.harness.evaluate(index, `window.__r = undefined; (async () => { ${source} })().then((v) => __r = JSON.stringify(v), (e) => __r = 'ERR ' + e.message); 1`);
  for (let i = 0; i < 120; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const value = await window.harness.evaluate(index, 'String(window.__r)');
    if (value !== 'undefined') return value.startsWith('ERR') ? value : JSON.parse(value);
  }
  return 'timeout';
}, [index, source]);

async function engine(page, role) {
  await page.goto(`/tests/fixtures/profile-service.html?relay=ws://127.0.0.1:${relay.port}/`);
  await page.waitForFunction(() => window.harness);
  if (role === 'content') await harness(page, 'startService');
  const index = await harness(page, 'startContent', role);
  if (role === 'content') await harness(page, 'connect', index);
  return index;
}

for (const role of ['standalone', 'content']) {
  test(`Response.redirected after redirects to the same and to another origin (${role})`, async ({ page }) => {
    const index = await engine(page, role);
    await harness(page, 'navigate', index, 'https://example.com/');
    const across = await run(page, index, `const r = await fetch('https://httpbingo.org/redirect-to?url=' + encodeURIComponent('https://httpbingo.org/get?hop=2')); return [r.redirected, r.url, r.status];`);
    expect(across).toEqual([true, 'https://httpbingo.org/get?hop=2', 200]);
    await harness(page, 'navigate', index, 'https://httpbingo.org/get?start');
    const same = await run(page, index, `const r = await fetch('/redirect/2'); return [r.redirected, r.url];`);
    expect(same).toEqual([true, 'https://httpbingo.org/get']);
    const none = await run(page, index, `const r = await fetch('/get?plain'); return r.redirected;`);
    expect(none).toBe(false);
  });

  test(`a Blob or ArrayBuffer body goes without a Content-Type of its own (${role})`, async ({ page }) => {
    const index = await engine(page, role);
    await harness(page, 'navigate', index, 'https://httpbingo.org/get?bodies');
    const result = await run(page, index, `
      const echo = async (body, headers) => (await (await fetch('/anything', { method: 'POST', body, headers })).json());
      const blob = await echo(new Blob(['blob contents']));
      const buffer = await echo(new Uint8Array([104, 105]).buffer);
      const typed = await echo(new Blob(['typed'], { type: 'text/plain' }));
      const xhr = await new Promise((resolve) => { const x = new XMLHttpRequest(); x.open('POST', '/anything'); x.onload = () => resolve(JSON.parse(x.responseText)); x.send(new Blob(['xhr'])); });
      const type = (echoed) => echoed.headers['Content-Type'] ?? null;
      return { blob: [blob.data, type(blob)], buffer: [buffer.data, type(buffer)], typed: [typed.data, type(typed)], xhr: [xhr.data, type(xhr)] };`);
    expect(result.blob).toEqual(['blob contents', null]);
    expect(result.buffer).toEqual(['hi', null]);
    expect(result.typed).toEqual(['typed', ['text/plain']]);
    expect(result.xhr).toEqual(['xhr', null]);
  });

  test(`document.cookie in a JSON document (${role})`, async ({ page }) => {
    const index = await engine(page, role);
    // A cookie the server sets with a redirect, read by the JSON page it leads to.
    await harness(page, 'navigate', index, 'https://httpbin.org/cookies/set?jsondoc=1', 'location.pathname === "/cookies" && document.readyState === "complete"');
    const set = await run(page, index, `return [document.contentType, document.cookie];`);
    expect(set).toEqual(['application/json', 'jsondoc=1']);
    await harness(page, 'navigate', index, 'https://httpbingo.org/json');
    const script = await run(page, index, `document.cookie = 'fromscript=2; path=/'; return [document.contentType, document.cookie];`);
    expect(script).toEqual(['application/json', 'fromscript=2']);
  });
}
