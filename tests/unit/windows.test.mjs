import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, ProtocolServer } from '../../host/protocol.js';
import { FrameRouter, frameWindow } from '../../host/runtime.js';
import { validateDisplayMessage } from '../../host/display.js';
import { registerAgentMethods } from '../../host/agent.js';

function pipe() {
  const sent = [];
  const transport = { onmessage: null, send: (m) => sent.push(m) };
  const call = async (message) => {
    await transport.onmessage(message);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { transport, sent, call };
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const hello = (extra = {}) => rpc(1, 'hello', { version: 1, ...extra });

function setup() {
  const live = new Set([1, 2, 3]);
  const server = new ProtocolServer(['view', 'windows', 'agent'], { optIn: ['windows', 'agent'], windowExists: (id) => live.has(id) });
  const calls = [];
  server.handle('view.navigate', (params, { window }) => (calls.push({ window, params }), null));
  const connect = (options) => {
    const end = pipe();
    server.connect(end.transport, options);
    return end;
  };
  return { server, calls, connect, live };
}

test('a connection acts on its own window, and the params cannot name another', async () => {
  const { calls, connect } = setup();
  const one = connect({ allow: ['view'] });
  const two = connect({ allow: ['view'], window: 2 });
  await one.call(hello());
  await two.call(hello());
  assert.equal(one.sent[0].result.window, 1);
  assert.equal(two.sent[0].result.window, 2);
  await two.call(rpc(2, 'view.navigate', { url: 'https://a.example/', window: 1 }));
  await one.call(rpc(2, 'view.navigate', { url: 'https://b.example/' }));
  assert.deepEqual(calls.map((c) => c.window), [2, 1]);
});

test('hello binds to another window only with the windows capability allowed', async () => {
  const { connect } = setup();
  const plain = connect({ allow: ['view'] });
  await plain.call(hello({ window: 2 }));
  assert.equal(plain.sent[0].error.code, ErrorCode.DeniedByPolicy);
  const own = connect({ allow: ['view'], window: 3 });
  await own.call(hello({ window: 3 }));
  assert.equal(own.sent[0].result.window, 3);
  const trusted = connect({ allow: ['view', 'windows'] });
  await trusted.call(hello({ window: 2, capabilities: ['view', 'windows'] }));
  assert.equal(trusted.sent[0].result.window, 2);
  assert.deepEqual(trusted.sent[0].result.capabilities, ['view', 'windows']);
});

test('hello refuses a window that does not exist or is not an integer', async () => {
  const { connect } = setup();
  for (const window of [9, 0, -1, 1.5, '2', null, {}]) {
    const end = connect();
    await end.call(hello({ window }));
    assert.equal(end.sent[0].error.code, ErrorCode.InvalidParams, String(window));
    assert.equal(end.sent[0].error.data.reason, 'invalid_params');
  }
  assert.throws(() => setup().server.connect(pipe().transport, { window: 0 }), TypeError);
});

test('window events reach only the connections bound to that window', async () => {
  const { server, connect } = setup();
  const one = connect();
  const two = connect({ window: 2 });
  await one.call(hello());
  await two.call(hello());
  server.emit('title', { title: 'two' }, 'view', 2);
  server.emit('title', { title: 'one' }, 'view', 1);
  server.emit('windows.created', { window: 3 }, 'windows');
  const titles = (end) => end.sent.filter((m) => m.method === 'event' && m.params.name === 'title').map((m) => m.params.data.title);
  assert.deepEqual(titles(one), ['one']);
  assert.deepEqual(titles(two), ['two']);
  // Not negotiated by default: windows is opt-in.
  assert.equal(one.sent.filter((m) => m.params?.name === 'windows.created').length, 0);
});

test('agent methods run on the agent of the calling connection\'s window only', async () => {
  const server = new ProtocolServer(['agent'], { optIn: ['agent'], windowExists: () => true });
  const hosts = new Map([1, 2].map((id) => [id, { control: 'human', log: () => [id], snapshot: () => ({ window: id }) }]));
  registerAgentMethods(server, (id) => hosts.get(id) ?? null);
  const results = [];
  for (const window of [1, 2, 7]) {
    const end = pipe();
    server.connect(end.transport, { allow: ['agent'], window });
    await end.call(rpc(1, 'hello', { version: 1, capabilities: ['agent'] }));
    await end.call(rpc(2, 'agent.snapshot', {}));
    await end.call(rpc(3, 'agent.log', {}));
    results.push(end.sent.slice(1));
  }
  assert.deepEqual(results[0].map((m) => m.result), [{ window: 1 }, [1]]);
  assert.deepEqual(results[1].map((m) => m.result), [{ window: 2 }, [2]]);
  assert.equal(results[2][0].error.data.reason, 'not_ready');
});

function fakeBitmap() {
  return { width: 2, height: 2, closed: false, close() { this.closed = true; } };
}

test('frames go to their window\'s display; bare frames are window 1\'s', () => {
  const router = new FrameRouter();
  const shown = { 1: [], 2: [] };
  router.attach(1, { present: (b) => shown[1].push(b) });
  const detach = router.attach(2, { present: (b) => shown[2].push(b) });
  const bare = fakeBitmap();
  const two = fakeBitmap();
  assert.ok(router.present(undefined, bare));
  assert.ok(router.present(2, two));
  assert.deepEqual(shown, { 1: [bare], 2: [two] });
  detach();
  const orphan = fakeBitmap();
  assert.equal(router.present(2, orphan), false);
  assert.ok(orphan.closed, 'a frame nobody shows is released');
  const unknown = fakeBitmap();
  assert.equal(router.present(5, unknown), false);
  assert.ok(unknown.closed);
});

test('a hostile engine cannot reach a window with something that is not a frame', () => {
  const router = new FrameRouter();
  const shown = [];
  router.attach(1, { present: (b) => shown.push(b) });
  for (const junk of [null, 5, 'bitmap', {}, { close: 'no' }, []]) assert.equal(router.present(1, junk), false);
  assert.equal(shown.length, 0);
  for (const value of [0, -2, 1.5, '3', null, undefined, {}]) assert.equal(frameWindow(value), 1);
  assert.equal(frameWindow(4), 4);
});

test('display messages: input is limited to known commands and never carries a window', () => {
  assert.deepEqual(validateDisplayMessage({ type: 'input', command: 'mouse', args: { type: 'down', x: 1, y: 2, window: 1 } }), { type: 'input', command: 'mouse', args: { type: 'down', x: 1, y: 2 } });
  for (const command of ['load', 'window.close', 'debug.evaluate', 'agent.act', 'init', 'tab.activate', 5, undefined])
    assert.equal(validateDisplayMessage({ type: 'input', command, args: {} }), null, String(command));
  assert.equal(validateDisplayMessage({ type: 'input', command: 'key', args: [1] }), null);
  assert.equal(validateDisplayMessage({ type: 'input', command: 'key', args: { text: 'x'.repeat(70_000) } }), null, 'oversized');
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(validateDisplayMessage({ type: 'input', command: 'key', args: cyclic }), null);
});

test('display messages: sizes, visibility and junk', () => {
  assert.deepEqual(validateDisplayMessage({ type: 'resize', width: 640.4, height: 480, deviceScaleFactor: 2, window: 1 }), { type: 'resize', width: 640, height: 480, deviceScaleFactor: 2 });
  for (const size of [{ width: 0, height: 10 }, { width: 10, height: 1e9 }, { width: 'a', height: 1 }, { width: 10, height: 10, deviceScaleFactor: -1 }])
    assert.equal(validateDisplayMessage({ type: 'resize', ...size }), null);
  assert.deepEqual(validateDisplayMessage({ type: 'visibility', visible: false }), { type: 'visibility', visible: false });
  assert.equal(validateDisplayMessage({ type: 'visibility', visible: 'no' }), null);
  assert.deepEqual(validateDisplayMessage({ type: 'close', window: 1 }), { type: 'close' });
  assert.deepEqual(validateDisplayMessage({ type: 'probe', ok: false, bitmap: {} }), { type: 'probe', ok: false });
  assert.equal(validateDisplayMessage({ type: 'probe', ok: 'yes' }), null);
  for (const junk of [null, 'input', 5, [], {}, { type: 'frame' }, { type: 'answer', id: 1 }, { type: 'eval' }])
    assert.equal(validateDisplayMessage(junk), null);
});
