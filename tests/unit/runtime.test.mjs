import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAX_MEMORY_MB, isOutOfMemory, lockImports, memoryLimitPages } from '../../host/runtime.js';

test('engine memory is bounded: 2 GiB by default, 512 MiB to 4 GiB when set', () => {
  const pages = (megabytes) => (megabytes * 1024 * 1024) / 65536;
  assert.equal(memoryLimitPages(undefined), pages(DEFAULT_MAX_MEMORY_MB));
  assert.equal(DEFAULT_MAX_MEMORY_MB, 2048);
  assert.equal(memoryLimitPages(1024), pages(1024));
  assert.equal(memoryLimitPages(64), pages(512));
  assert.equal(memoryLimitPages(1e9), pages(4096));
  assert.equal(memoryLimitPages('nonsense'), pages(DEFAULT_MAX_MEMORY_MB));
});

test('out-of-memory crashes are told apart', () => {
  assert.ok(isOutOfMemory('Aborted(OOM)'));
  assert.ok(isOutOfMemory('Cannot enlarge memory arrays to size 2147549184 bytes'));
  assert.ok(!isOutOfMemory('RuntimeError: unreachable'));
});

test('a content engine is instantiated without file system or socket imports', () => {
  function __wasmfs_opfs_open_access() { return 'opened'; }
  function _inception_tcp_open() { return 'connected'; }
  function inception_has_opfs() { return 1; }
  function _inception_link_post() { return 'posted'; }
  function _emscripten_get_now() { return 1; }
  const imports = { a: { b: __wasmfs_opfs_open_access, c: _inception_tcp_open, d: inception_has_opfs, e: _inception_link_post, f: _emscripten_get_now } };
  lockImports(imports);
  for (const key of ['b', 'c', 'd']) assert.throws(() => imports.a[key](), /no files or network/);
  assert.equal(imports.a.e(), 'posted');
  assert.equal(imports.a.f(), 1);
});

test("maxMemoryMB 'auto' follows the device's memory", async () => {
  const { memoryLimitMB } = await import('../../host/runtime.js');
  assert.equal(memoryLimitMB('auto', 8), 2048);
  assert.equal(memoryLimitMB('auto', 4), 1024);
  assert.equal(memoryLimitMB('auto', 2), 512);
  assert.equal(memoryLimitMB('auto', 0.5), 512);
  assert.equal(memoryLimitMB('auto', undefined), DEFAULT_MAX_MEMORY_MB);
  assert.equal(memoryLimitMB(1024, 2), 1024);
  assert.equal(memoryLimitPages('auto', 4), memoryLimitPages(1024));
});
