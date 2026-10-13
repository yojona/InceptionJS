import { expect, test } from '@playwright/test';

// The engine's command parser takes anything the host page sends without
// falling over: malformed, oversized, unknown and wrongly typed commands are
// refused or ignored, and the engine keeps working.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);

test('wrong, unknown and oversized commands leave the engine working', async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank&persist=clear`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => evaluate(page, '1 + 1'), { timeout: 60_000 }).toBe('2');

  const values = [null, true, 0, -1, 1e308, 'x', '', [], [1, 'a'], { nested: { deep: [null] } }];
  const commands = ['load', 'resize', 'mouse', 'wheel', 'key', 'focus', 'ime.set', 'ime.commit', 'zoom', 'find', 'history.query',
    'tab.activate', 'select.choose', 'agent.snapshot', 'agent.act', 'agent.describe', 'agent.extract', 'agent.probe', 'agent.control', 'no.such.command'];
  await view(page).evaluate(async (el, [commands, values]) => {
    let seed = 7;
    const random = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const keys = ['id', 'url', 'x', 'y', 'type', 'key', 'text', 'ref', 'action', 'allow', 'width', 'height', 'kind', 'agent', 'tab', 'factor'];
    for (let i = 0; i < 400; i++) {
      const args = {};
      for (let k = random(5); k > 0; k--) args[keys[random(keys.length)]] = values[random(values.length)];
      await el.debugCommand(commands[random(commands.length)], args);
    }
    // Arguments that are not an object, and a command far over the size limit.
    for (const command of ['load', 'agent.act', 'mouse']) for (const value of values) await el.debugCommand(command, value);
    await el.debugCommand('load', { url: 'x'.repeat(17 * 1024 * 1024) });
  }, [commands, values]);

  await expect.poll(() => evaluate(page, '6 * 7'), { timeout: 30_000 }).toBe('42');
  expect(await view(page).evaluate((el) => el.dataset.renderer)).toBeTruthy();
});
