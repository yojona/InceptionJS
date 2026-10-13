import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, ProtocolServer, createPostMessageTransport, createWebSocketTransport } from '../../host/protocol.js';

// A transport whose far end is the test.
function pipe() {
  const sent = [];
  const transport = { onmessage: null, send: (m) => sent.push(m) };
  const call = async (message) => {
    await transport.onmessage(message);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { transport, sent, call };
}

function setup(options) {
  const calls = [];
  const server = new ProtocolServer(['view', 'find', 'history', 'observe'], { optIn: ['find', 'history', 'observe'] });
  server.handle('view.ping', (params) => (calls.push(params), 'pong'));
  server.handle('view.find', (params) => (calls.push(params), { found: true }), 'find');
  server.handle('history.query', () => []);
  const end = pipe();
  server.connect(end.transport, options);
  return { server, calls, ...end };
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const hello = (capabilities) => rpc(1, 'hello', { version: 1, ...(capabilities ? { capabilities } : {}) });

test('nothing is reachable before hello', async () => {
  const { call, sent, calls } = setup();
  await call(rpc(2, 'view.ping', {}));
  assert.equal(sent[0].error.code, ErrorCode.NotNegotiated);
  assert.equal(calls.length, 0);
});

test('a plain hello gets the default capabilities, not the sensitive ones', async () => {
  const { call, sent } = setup();
  await call(hello());
  assert.deepEqual(sent[0].result.capabilities, ['view']);
  await call(rpc(2, 'view.find', { text: 'secret' }));
  assert.equal(sent[1].error.code, ErrorCode.CapabilityMissing);
  await call(rpc(3, 'history.query', {}));
  assert.equal(sent[2].error.code, ErrorCode.CapabilityMissing);
});

test('a connection cannot negotiate what it was not allowed', async () => {
  const { call, sent, calls } = setup({ allow: ['view'] });
  await call(hello(['view', 'find', 'history', 'observe']));
  assert.deepEqual(sent[0].result.capabilities, ['view']);
  await call(rpc(2, 'view.find', { text: 'x' }));
  assert.equal(sent[1].error.code, ErrorCode.CapabilityMissing);
  assert.equal(calls.length, 0);
  const wide = setup({ allow: ['view', 'find'] });
  await wide.call(hello(['find', 'history']));
  assert.deepEqual(wide.sent[0].result.capabilities, ['find']);
  await wide.call(rpc(2, 'view.find', { text: 'x' }));
  assert.deepEqual(wide.sent[1].result, { found: true });
});

test('events reach only connections that negotiated their capability', async () => {
  const { server, call, sent } = setup();
  await call(hello());
  server.emit('title', { title: 'a' });
  server.emit('console', { message: 'private' }, 'observe');
  assert.equal(sent.filter((m) => m.method === 'event').length, 1);
});

test('malformed, oversized, unknown and replayed messages never crash it or reach a handler', async () => {
  const { call, sent, calls } = setup();
  await call(hello());
  const junk = [
    undefined, null, 0, 'text', [], [[]], {}, { jsonrpc: '2.0' }, { jsonrpc: '1.0', method: 'view.ping', id: 5 },
    rpc(6, 7), rpc(7, 'x'.repeat(100_000)), rpc(8, 'view.ping', null), rpc(9, 'view.ping', []), rpc(10, 'view.ping', 'str'),
    rpc({}, 'view.ping', {}), rpc([], 'view.ping', {}), rpc(11, '__proto__', {}), rpc(12, 'constructor', {}),
    rpc(13, 'hello', { version: 1, capabilities: 'view' }), rpc(14, 'hello', { version: 1, capabilities: [1, {}] }),
    rpc(15, 'hello', { version: 99 }), rpc(16, 'view.nothing', {}), rpc(17, 'nothing.at.all', {}),
  ];
  for (const message of junk) await call(message);
  assert.equal(calls.length, 0);
  assert.ok(sent.every((m) => m.error || m.result), 'every answer is a result or an error');
  // A valid request replayed is simply answered again.
  for (let i = 0; i < 3; i++) await call(rpc(20, 'view.ping', { n: i }));
  assert.equal(calls.length, 3);
  // Large but valid params are passed through, not parsed twice or truncated.
  await call(rpc(21, 'view.ping', { blob: 'y'.repeat(2_000_000) }));
  assert.equal(calls.length, 4);
});

test('a handler that throws answers with an internal error', async () => {
  const { server, call, sent } = setup();
  server.handle('view.boom', () => {
    throw new Error('boom');
  });
  await call(hello());
  await call(rpc(2, 'view.boom', {}));
  assert.equal(sent[1].error.code, ErrorCode.Internal);
});

test('a Window peer needs an origin, and only that origin and window are heard', () => {
  class FakeWindow {
    posted = [];
    postMessage(message, origin) {
      this.posted.push({ message, origin });
    }
  }
  globalThis.Window = FakeWindow;
  try {
    const peer = new FakeWindow();
    const listeners = [];
    const source = { addEventListener: (type, fn) => listeners.push(fn) };
    assert.throws(() => createPostMessageTransport(peer, undefined, source), /origin/);
    const transport = createPostMessageTransport(peer, 'https://peer.example', source);
    const heard = [];
    transport.onmessage = (m) => heard.push(m);
    const message = { inceptionProtocol: { hello: true } };
    listeners[0]({ origin: 'https://evil.example', source: peer, data: message });
    listeners[0]({ origin: 'https://peer.example', source: new FakeWindow(), data: message });
    listeners[0]({ origin: 'https://peer.example', source: peer, data: { other: 1 } });
    assert.equal(heard.length, 0);
    listeners[0]({ origin: 'https://peer.example', source: peer, data: message });
    assert.equal(heard.length, 1);
    transport.send({ a: 1 });
    assert.equal(peer.posted[0].origin, 'https://peer.example');
  } finally {
    delete globalThis.Window;
  }
});

test('socket messages over the limit or not text are refused before parsing', () => {
  const handlers = {};
  const sent = [];
  const socket = { addEventListener: (type, fn) => (handlers[type] = fn), send: (text) => sent.push(JSON.parse(text)) };
  const transport = createWebSocketTransport(socket, { maxMessageBytes: 100 });
  const heard = [];
  transport.onmessage = (m) => heard.push(m);
  handlers.message({ data: JSON.stringify({ jsonrpc: '2.0', method: 'hello', pad: 'x'.repeat(200) }) });
  handlers.message({ data: new ArrayBuffer(4) });
  handlers.message({ data: 'not json' });
  handlers.message({ data: '{"jsonrpc":"2.0","method":"x"}' });
  assert.equal(heard.length, 1);
  assert.equal(sent.filter((m) => m.error?.code === ErrorCode.InvalidRequest).length, 2);
  assert.equal(sent.filter((m) => m.error?.code === ErrorCode.ParseError).length, 1);
});
