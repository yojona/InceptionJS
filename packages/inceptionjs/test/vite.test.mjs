import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
