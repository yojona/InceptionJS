import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_DEFAULTS, resolvePolicy } from '../../host/policy.js';
import { safeFilename } from '../../host/downloads.js';

test('nothing configured means the safe defaults', () => {
  assert.deepEqual(resolvePolicy(null), POLICY_DEFAULTS);
  assert.equal(POLICY_DEFAULTS.downloads, 'events');
  assert.equal(POLICY_DEFAULTS.newTabs, 'block');
  assert.equal(POLICY_DEFAULTS.dialogs, 'dismiss');
  assert.equal(POLICY_DEFAULTS.clipboard, 'user');
});

test('valid choices are kept, anything else falls back to the default', () => {
  assert.equal(resolvePolicy({ downloads: 'save' }).downloads, 'save');
  assert.equal(resolvePolicy({ clipboard: false }).clipboard, false);
  assert.equal(resolvePolicy({ clipboard: true }).clipboard, true);
  const bad = resolvePolicy({ downloads: 'yes', newTabs: 1, dialogs: null, clipboard: 'sure', maxDownloadBytes: '9', unknown: 1 });
  assert.deepEqual(bad, POLICY_DEFAULTS);
  assert.equal(resolvePolicy({ maxDownloadBytes: 10 }).maxDownloadBytes, 10);
});

test('file names from a server cannot carry paths or control characters', () => {
  assert.equal(safeFilename('report.pdf'), 'report.pdf');
  assert.equal(safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeFilename('C:\\Users\\me\\run.exe'), 'run.exe');
  assert.equal(safeFilename('a\u0000b\u001f.txt'), 'ab.txt');
  assert.equal(safeFilename('.bashrc'), 'bashrc');
  assert.equal(safeFilename(''), 'download');
  assert.equal(safeFilename(undefined), 'download');
  assert.ok(safeFilename('x'.repeat(1000)).length <= 200);
});
