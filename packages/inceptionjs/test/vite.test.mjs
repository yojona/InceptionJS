import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import inception from '../src/vite/index.js';

function build(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'inception-vite-'));
  const engineDir = join(root, 'engine');
  mkdirSync(engineDir);
  for (const name of ['inception-engine.js', 'inception-engine.wasm', 'inception-engine.data']) writeFileSync(join(engineDir, name), name);
  const plugin = inception({ engineDir, ...options });
  plugin.configResolved({ root, command: 'build', build: { outDir: 'dist' }, logger: { warn() {} } });
  plugin.writeBundle();
  const out = join(root, 'dist', '__inception');
  const list = (dir) => { try { return readdirSync(join(out, dir)).sort(); } catch { return null; } };
  const result = { engine: list('engine'), binaryen: list('binaryen') };
  rmSync(root, { recursive: true, force: true });
  return result;
}

test('a build ships the engine and only the binaryen files the host loads', () => {
  const { engine, binaryen } = build();
  assert.deepEqual(engine, ['inception-engine.data', 'inception-engine.js', 'inception-engine.wasm']);
  assert.deepEqual(binaryen, ['LICENSE', 'index.js']);
});

test('nothing is copied with engineUrl or copyEngine: false', () => {
  assert.deepEqual(build({ engineUrl: 'https://cdn.example/engine/inception-engine.js' }), { engine: null, binaryen: null });
  assert.deepEqual(build({ copyEngine: false }), { engine: null, binaryen: null });
});

test('the dev server sends a precompressed engine file when the browser accepts it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'inception-vite-'));
  const engineDir = join(root, 'engine');
  mkdirSync(engineDir);
  writeFileSync(join(engineDir, 'inception-engine.wasm'), 'raw');
  writeFileSync(join(engineDir, 'inception-engine.wasm.br'), 'brotli');
  writeFileSync(join(engineDir, 'inception-engine.data'), 'raw');
  const plugin = inception({ engineDir });
  plugin.configResolved({ root, command: 'serve', build: { outDir: 'dist' }, logger: { warn() {} } });
  const middlewares = [];
  await plugin.configureServer({ middlewares: { use: (fn) => middlewares.push(fn) } });
  const get = (url, encoding) => new Promise((resolve) => {
    const headers = {};
    const chunks = [];
    const res = new Writable({ write(chunk, _, done) { chunks.push(chunk); done(); } });
    res.setHeader = (name, value) => { headers[name.toLowerCase()] = value; };
    res.on('finish', () => resolve({ headers, body: Buffer.concat(chunks).toString() }));
    const req = { url, headers: encoding ? { 'accept-encoding': encoding } : {} };
    let i = 0;
    const next = () => middlewares[i++]?.(req, res, next);
    next();
  });
  const brotli = await get('/__inception/engine/inception-engine.wasm', 'gzip, deflate, br');
  assert.equal(brotli.headers['content-encoding'], 'br');
  assert.equal(brotli.headers['content-type'], 'application/wasm');
  assert.equal(brotli.body, 'brotli');
  const plain = await get('/__inception/engine/inception-engine.wasm', 'gzip');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body, 'raw');
  // No compressed copy: the file itself.
  assert.equal((await get('/__inception/engine/inception-engine.data', 'br')).body, 'raw');
  rmSync(root, { recursive: true, force: true });
});
