import { expect, test } from '@playwright/test';

// WebAssembly inside pages: the host translates modules with wasm2js and the
// page runs the result as script. MVP modules work; features wasm2js cannot
// lower (threads, SIMD, ...) fail as a CompileError.
const PAGE = process.env.PAGE_PATH ?? '/';
const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);
const write = (page, html) => evaluate(page, `document.open(); document.write(${JSON.stringify(html)}); document.close(); document.title`);

const hex = (text) => JSON.stringify(text.replace(/\s+/g, ''));
// (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add)
const ADD = hex('0061736d 01000000 0107 01 60 02 7f 7f 01 7f 0302 01 00 0707 01 03 616464 00 00 0a09 01 07 00 2000 2001 6a 0b');
// (func (export "f") (result i32) v128.const i32x4 0 0 0 0 i32x4.extract_lane 0): SIMD.
const SIMD = hex('0061736d 01000000 0105 01 60 00 01 7f 0302 01 00 0705 01 01 66 00 00 0a19 01 17 00 fd0c 00000000000000000000000000000000 fd1b 00 0b');

test.beforeEach(async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  await view(page).evaluate((el) => el.ready);
  await expect.poll(() => write(page, '<title>wasm</title>'), { timeout: 60_000 }).toBe('wasm');
});

const run = (page, bytes, call) => evaluate(page, `
  window.out = 'pending';
  const bytes = new Uint8Array(${bytes}.match(/../g).map((b) => parseInt(b, 16)));
  WebAssembly.instantiate(bytes).then(({ instance }) => { out = String(${call}); }, (error) => { out = error.name + ': ' + error.message; });
  1`).then(() => expect.poll(() => evaluate(page, 'out'), { timeout: 30_000 }).not.toBe('pending')).then(() => evaluate(page, 'out'));

test('a page compiles and runs an MVP WebAssembly module', async ({ page }) => {
  expect(await evaluate(page, 'typeof WebAssembly')).toBe('object');
  expect(await run(page, ADD, 'instance.exports.add(2, 40)')).toBe('42');
});

test('a module that needs SIMD fails to compile with a CompileError', async ({ page }) => {
  expect(await run(page, SIMD, 'instance.exports.f()')).toMatch(/^CompileError/);
});
