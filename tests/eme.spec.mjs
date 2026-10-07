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
