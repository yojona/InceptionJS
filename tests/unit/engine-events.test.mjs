import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEngineMessage } from '../../host/runtime.js';
import { Downloads } from '../../host/downloads.js';
import { Tabs } from '../../host/tabs.js';
import { Modules } from '../../host/modules.js';
import { resolvePolicy } from '../../host/policy.js';

test('only a bounded JSON event with a short name and an object payload gets through', () => {
  assert.deepEqual(parseEngineMessage('{"event":"title","data":{"title":"a"}}'), { event: 'title', payload: { title: 'a' } });
  assert.deepEqual(parseEngineMessage('{"event":"ready"}'), { event: 'ready', payload: {} });
  assert.deepEqual(parseEngineMessage('{"event":"x","data":[1]}'), { event: 'x', payload: {} });
  assert.deepEqual(parseEngineMessage('{"event":"x","data":"str"}'), { event: 'x', payload: {} });
  for (const bad of [undefined, null, 5, {}, '', 'not json', '[]', 'null', '"x"', '{}', '{"event":5}', '{"event":""}', `{"event":"${'a'.repeat(65)}"}`])
    assert.equal(parseEngineMessage(bad), null, String(bad));
});

// Payloads a broken engine could send: right names, wrong shapes.
const garbage = [
  {}, { id: null }, { id: {} }, { id: 'x', url: 5, filename: {}, mime: [], size: 'big' }, { tab: 'two', opener: {}, url: [] },
  { kind: 5, origin: {}, id: [] }, { bytes: 'not bytes', id: 1 }, { items: 5 }, { received: 'NaN', error: {} },
  Object.create(null), { __proto__: { id: 1 } }, { id: 1, extra: 'x'.repeat(100_000) },
];

function fakeView() {
  return Object.assign(new EventTarget(), { events: [] });
}

test('the host\'s event handlers survive payloads of the wrong shape', () => {
  const policy = () => resolvePolicy({ downloads: 'events' });
  const view = fakeView();
  const send = () => {};
  const downloads = new Downloads(view, send, policy);
  const tabs = new Tabs(view, send, policy);
  tabs.started(1);
  const modules = new Modules(view, send, {});
  const names = [
    ...['started', 'progress', 'paused', 'resumed', 'restarted', 'finished'].map((n) => ['download.' + n, downloads]),
    ...['created', 'opened', 'focus', 'activated', 'closed', 'audible', 'icons'].map((n) => ['tab.' + n, tabs]),
    ...['permission.request', 'geolocation.start', 'geolocation.stop', 'notification.show', 'notification.close'].map((n) => [n, modules]),
  ];
  for (const [name, target] of names)
    for (const payload of garbage) {
      try {
        target.handleEvent(name, payload);
      } catch (error) {
        // A throw is tolerated by the runtime (it logs and goes on); what must never happen
        // is a hang or a crash of the process, which reaching this line proves.
        assert.ok(error instanceof Error);
      }
    }
  for (const payload of garbage) {
    try {
      downloads.chunk(payload);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  }
});
