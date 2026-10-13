import { expect, test } from '@playwright/test';
import { requirePersistentStorage } from './persistence.mjs';
import { startRelay } from '../packages/inceptionjs/src/server/index.js';

// What a profile service changes in the security plan: one relay connection
// per profile (S1), content engines with no files and no network of their
// own even if their code is subverted (S2), profiles that share nothing and
// ephemeral ones that leave nothing (S5), and failures that stay where they
// happen (S6).
const harness = (page, method, ...args) => page.evaluate(([method, args]) => window.harness[method](...args), [method, args]);
const evaluate = (page, index, source) => harness(page, 'evaluate', index, source);

let relay;
// Relay sessions that ended: each is one WebSocket an engine opened.
let sessions = 0;

test.beforeAll(async () => {
  relay = await startRelay({
    port: 0,
    log: (level, message) => {
      if (message.startsWith('session closed')) sessions++;
    },
  });
});

test.afterAll(async () => {
  await relay?.close?.();
});

async function open(page, query = '') {
  await page.goto(`/tests/fixtures/profile-service.html?relay=ws://127.0.0.1:${relay.port}/${query}`);
  await page.waitForFunction(() => window.harness);
}

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.harness?.stop()).catch(() => {});
});

test('S1: one relay connection per profile, however many content engines load', async ({ page }) => {
  await open(page);
  const before = sessions;
  await harness(page, 'startService');
  const engines = [];
  for (let i = 0; i < 3; i++) {
    const index = await harness(page, 'startContent');
    await harness(page, 'connect', index);
    engines.push(index);
  }
  for (const [n, index] of engines.entries()) await harness(page, 'navigate', index, `https://example.com/?engine=${n}`);
  await harness(page, 'stop');
  await expect.poll(() => sessions - before).toBeGreaterThan(0);
  await page.waitForTimeout(1000);
  expect(sessions - before).toBe(1);
});

test('S2: a content engine cannot open files or the network, even asked directly', async ({ page }) => {
  await open(page);
  await harness(page, 'startService');
  const content = await harness(page, 'startContent');
  await harness(page, 'connect', content);
  const before = sessions;
  // The debug probes make the engine's own code try what a subverted engine
  // would: mount the profile's storage, and open a socket to the relay. The
  // engine refuses, and the attempt does not reach either.
  const attempt = await page.evaluate(async (index) => {
    const runtime = window.harness.runtimeOf(index);
    const crashed = new Promise((resolve) => runtime.addEventListener('crash', (e) => resolve(e.detail.message), { once: true }));
    runtime.send('debug.reach', { files: true });
    return Promise.race([crashed, new Promise((resolve) => setTimeout(() => resolve('no crash'), 5000))]);
  }, content);
  expect(attempt).toContain('no files or network');
  const second = await harness(page, 'startContent');
  await harness(page, 'connect', second);
  const network = await page.evaluate(async ([index, relayPort]) => {
    const runtime = window.harness.runtimeOf(index);
    const crashed = new Promise((resolve) => runtime.addEventListener('crash', (e) => resolve(e.detail.message), { once: true }));
    runtime.send('debug.reach', { network: `ws://127.0.0.1:${relayPort}/` });
    return Promise.race([crashed, new Promise((resolve) => setTimeout(() => resolve('no crash'), 5000))]);
  }, [second, relay.port]);
  expect(network).toContain('no files or network');
  // The service's own session is still open; nothing else opened one.
  await page.waitForTimeout(1000);
  expect(sessions - before).toBe(0);
});

test('S2: the service refuses what the window\'s policy does not allow, whatever the content engine asks', async ({ page }) => {
  await open(page);
  await harness(page, 'startService');
  const content = await harness(page, 'startContent');
  const link = await harness(page, 'connect', content);
  await harness(page, 'serviceSend', 'link.policy', { link, allow: ['example.com'] });
  await harness(page, 'navigate', content, 'https://example.com/');
  const result = await page.evaluate(async (index) => {
    await window.harness.evaluate(index, `window.out = 'pending'; fetch('https://example.org/').then(() => out = 'loaded', () => out = 'refused'); 1`);
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const value = await window.harness.evaluate(index, 'out');
      if (value !== 'pending') return value;
    }
    return 'timeout';
  }, content);
  expect(result).toBe('refused');
  // The allowed host still loads, subdomains included.
  await harness(page, 'navigate', content, 'https://example.com/?again');
});

test('S5: two profiles share no cookies or storage; an ephemeral one leaves nothing on disk', async ({ page }) => {
  await requirePersistentStorage(test, page);
  await open(page);
  const stamp = Date.now();
  const result = await page.evaluate(async (stamp) => {
    const { ProfileService } = await import('/host/profile-service.js');
    const h = window.harness;
    const first = await h.startProfile({ profile: `s5-a-${stamp}`, fresh: true });
    const second = await h.startProfile({ profile: `s5-b-${stamp}`, fresh: true });
    const a = await h.startContent();
    h.connectTo(first, a);
    const b = await h.startContent();
    h.connectTo(second, b);
    await h.navigate(a, 'https://example.com/');
    await h.navigate(b, 'https://example.com/');
    await h.evaluate(a, 'document.cookie = "who=a; max-age=3600; path=/"; localStorage.setItem("who", "a"); 1');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const seen = await h.evaluate(b, 'document.cookie + "|" + localStorage.getItem("who")');
    // Ephemeral: a service that never touches the origin-private file system.
    const root = await navigator.storage.getDirectory();
    const listing = async () => { const names = []; for await (const name of root.keys()) names.push(name); return names; };
    const inception = async () => { try { const dir = await root.getDirectoryHandle('inception'); const names = []; for await (const name of dir.keys()) names.push(name); return names.sort(); } catch { return []; } };
    const before = await inception();
    const ephemeral = await h.startProfile({ ephemeral: true });
    const c = await h.startContent();
    h.connectTo(ephemeral, c);
    await h.navigate(c, 'https://example.com/?ephemeral');
    await h.evaluate(c, 'document.cookie = "temp=1; max-age=3600; path=/"; localStorage.setItem("temp", "1"); indexedDB.open("temp", 1); 1');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const after = await inception();
    void listing;
    return { seen, before, after, ephemeralPersistent: ephemeral.info.persistent };
  }, stamp);
  expect(result.seen).toBe('|null');
  expect(result.after).toEqual(result.before);
  expect(result.ephemeralPersistent).toBe(false);
});
