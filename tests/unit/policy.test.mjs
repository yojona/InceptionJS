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

import { safeNotificationIcon } from '../../host/modules.js';

test('a notification icon is shown only when it is an inline image', () => {
  assert.equal(safeNotificationIcon('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(safeNotificationIcon('https://tracker.example/pixel.png'), undefined);
  assert.equal(safeNotificationIcon('data:text/html;base64,AAAA'), undefined);
  assert.equal(safeNotificationIcon('data:image/svg+xml;base64,AAAA'), undefined);
  assert.equal(safeNotificationIcon(''), undefined);
  assert.equal(safeNotificationIcon(undefined), undefined);
});

import { Downloads } from '../../host/downloads.js';

test('a download without the person\'s input is cancelled unless the policy allows it', () => {
  const run = (configured, started) => {
    const view = new EventTarget();
    const events = [];
    const sent = [];
    for (const type of ['downloadstart', 'downloadblocked']) view.addEventListener(type, (e) => events.push([type, e.detail.reason]));
    new Downloads(view, (command) => sent.push(command), () => resolvePolicy(configured)).handleEvent('download.started', started);
    return { events, sent };
  };
  const page = { id: 1, url: 'https://x/f', filename: 'f', mime: '', size: 1 };
  assert.deepEqual(run({}, { ...page, userGesture: false }), { events: [['downloadblocked', 'no-gesture']], sent: ['download.cancel'] });
  assert.deepEqual(run({}, { ...page, userGesture: true }), { events: [['downloadstart', undefined]], sent: [] });
  assert.deepEqual(run({ gesturelessDownloads: 'allow' }, { ...page, userGesture: false }), { events: [['downloadstart', undefined]], sent: [] });
  assert.deepEqual(run({ downloads: 'block' }, { ...page, userGesture: true }).events, [['downloadblocked', 'policy']]);
});
