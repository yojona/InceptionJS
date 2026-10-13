import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAX_MEMORY_MB, isOutOfMemory, memoryLimitPages } from '../../host/runtime.js';

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
