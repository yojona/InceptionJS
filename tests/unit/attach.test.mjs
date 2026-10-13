import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import { ATTACH_VERSION, validateClientMessage, validateHostMessage, validateRequest } from '../../host/attach.js';
import { serveDisplay, validateDisplayMessage } from '../../host/display.js';

// --- the broker, run against fake locks and ports -----------------------------

// Web Locks as the broker uses them: exclusive, queued, abortable.
function fakeLocks() {
  const held = new Map();
  const waiting = new Map();
  const grant = (name) => {
    const queue = waiting.get(name) ?? [];
    if (held.has(name) || !queue.length) return;
    const next = queue.shift();
    held.set(name, true);
    Promise.resolve(next.callback({ name })).finally(() => {
      held.delete(name);
      grant(name);
    });
  };
  return {
    request(name, options, callback) {
      return new Promise((resolve, reject) => {
        const entry = { callback: (lock) => Promise.resolve(callback(lock)).then(resolve, reject) };
        if (options.signal) options.signal.addEventListener('abort', () => {
          const queue = waiting.get(name) ?? [];
          const at = queue.indexOf(entry);
          if (at >= 0) {
            queue.splice(at, 1);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }
        });
        if (!waiting.has(name)) waiting.set(name, []);
        waiting.get(name).push(entry);
        grant(name);
      });
    },
    // A document taking a lock for its life: returns the function that frees it.
    hold(name) {
      let free;
      this.request(name, {}, () => new Promise((resolve) => { free = resolve; }));
      return () => free();
    },
  };
}

function fakePort() {
  const sent = [];
  return { sent, onmessage: null, // Messages come from another realm: compared as the plain data they are.
    postMessage: (message, transfer = []) => sent.push({ message: JSON.parse(JSON.stringify(message)), transfer }), of: (type) => sent.filter((s) => s.message.type === type).map((s) => s.message) };
}

function startBroker() {
  const locks = fakeLocks();
  const context = vm.createContext({ navigator: { locks }, AbortController, Promise, setTimeout, console });
  vm.runInContext(readFileSync(new URL('../../host/broker.js', import.meta.url), 'utf8'), context);
  const connect = () => {
    const port = fakePort();
    context.onconnect({ ports: [port] });
    const send = async (message, ports = []) => {
      port.onmessage({ data: message, ports });
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { port, send };
  };
  return { locks, connect };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the broker hands a client to the host and nothing else', async () => {
  const { locks, connect } = startBroker();
  locks.hold('inception-host:p:h1');
  locks.hold('inception-client:p:c1');
  const host = connect();
  const client = connect();
  await host.send({ type: 'join', profile: 'p', id: 'h1', role: 'host' });
  await client.send({ type: 'join', profile: 'p', id: 'c1', role: 'client' });
  assert.deepEqual(host.port.of('joined'), [{ type: 'joined', profile: 'p', host: null }]);
  await host.send({ type: 'host', profile: 'p', id: 'h1' });
  assert.deepEqual(client.port.of('host'), [{ type: 'host', profile: 'p', id: 'h1' }]);
  const channel = new MessageChannel();
  await client.send({ type: 'connect', profile: 'p', id: 'c1', request: { version: 1, id: 'c1' } }, [channel.port2]);
  const [handoff] = host.port.sent.filter((s) => s.message.type === 'client');
  assert.deepEqual(handoff.message, { type: 'client', from: 'c1', request: { version: 1, id: 'c1' } });
  assert.equal(handoff.transfer.length, 1);
  assert.equal(handoff.transfer[0], channel.port2);
  channel.port1.close();
  channel.port2.close();
});

test('a client that arrives before the host waits for it', async () => {
  const { locks, connect } = startBroker();
  locks.hold('inception-host:p:h1');
  locks.hold('inception-client:p:c1');
  const host = connect();
  const client = connect();
  await client.send({ type: 'join', profile: 'p', id: 'c1', role: 'client' });
  await client.send({ type: 'connect', profile: 'p', id: 'c1', request: { id: 'c1' } }, [{ marker: 1 }]);
  await client.send({ type: 'status', profile: 'p' });
  assert.equal(client.port.of('status')[0].pending, 1);
  await host.send({ type: 'join', profile: 'p', id: 'h1', role: 'host' });
  assert.equal(host.port.of('client').length, 0, 'joining is not being ready');
  await host.send({ type: 'host', profile: 'p', id: 'h1' });
  assert.equal(host.port.of('client').length, 1);
  await client.send({ type: 'status', profile: 'p' });
  assert.equal(client.port.of('status')[1].pending, 0);
  assert.equal(client.port.of('status')[1].host, 'h1');
});

test('when the host goes away clients are told, and the next host gets those waiting', async () => {
  const { locks, connect } = startBroker();
  const freeHost = locks.hold('inception-host:p:h1');
  locks.hold('inception-client:p:c1');
  const first = connect();
  const client = connect();
  await first.send({ type: 'join', profile: 'p', id: 'h1', role: 'host' });
  await first.send({ type: 'host', profile: 'p', id: 'h1' });
  await client.send({ type: 'join', profile: 'p', id: 'c1', role: 'client' });
  assert.equal(client.port.of('joined')[0].host, 'h1');
  freeHost();
  await tick();
  await tick();
  assert.deepEqual(client.port.of('host-lost'), [{ type: 'host-lost', profile: 'p', id: 'h1' }]);
  // A client asking now waits for the next host.
  await client.send({ type: 'connect', profile: 'p', id: 'c1', request: { id: 'c1' } }, [{ marker: 2 }]);
  locks.hold('inception-host:p:h2');
  const second = connect();
  await second.send({ type: 'join', profile: 'p', id: 'h2', role: 'host' });
  await second.send({ type: 'host', profile: 'p', id: 'h2' });
  assert.equal(second.port.of('client').length, 1);
  assert.deepEqual(client.port.of('host').at(-1), { type: 'host', profile: 'p', id: 'h2' });
});

test('a client that goes away is forgotten and the host hears of it', async () => {
  const { locks, connect } = startBroker();
  locks.hold('inception-host:p:h1');
  const freeClient = locks.hold('inception-client:p:c1');
  const host = connect();
  const client = connect();
  await host.send({ type: 'join', profile: 'p', id: 'h1', role: 'host' });
  await host.send({ type: 'host', profile: 'p', id: 'h1' });
  await client.send({ type: 'join', profile: 'p', id: 'c1', role: 'client' });
  await host.send({ type: 'status', profile: 'p' });
  assert.deepEqual(host.port.of('status')[0].clients, ['c1']);
  freeClient();
  await tick();
  await tick();
  assert.deepEqual(host.port.of('client-gone'), [{ type: 'client-gone', from: 'c1' }]);
  await host.send({ type: 'status', profile: 'p' });
  assert.deepEqual(host.port.of('status')[1].clients, []);
});

test('a document that does not hold its lock is not trusted to stay', async () => {
  const { connect } = startBroker();
  const client = connect();
  await client.send({ type: 'join', profile: 'p', id: 'c1', role: 'client' });
  await tick();
  await client.send({ type: 'status', profile: 'p' });
  assert.deepEqual(client.port.of('status')[0].clients, []);
});

test('profiles are separate, and junk is ignored', async () => {
  const { locks, connect } = startBroker();
  locks.hold('inception-host:a:h1');
  locks.hold('inception-client:b:c1');
  const host = connect();
  const client = connect();
  await host.send({ type: 'join', profile: 'a', id: 'h1', role: 'host' });
  await host.send({ type: 'host', profile: 'a', id: 'h1' });
  await client.send({ type: 'join', profile: 'b', id: 'c1', role: 'client' });
  await client.send({ type: 'connect', profile: 'b', id: 'c1', request: {} }, [{ marker: 3 }]);
  assert.equal(host.port.of('client').length, 0);
  for (const junk of [null, 'join', 5, {}, { type: 'join' }, { type: 'join', profile: 'x'.repeat(200), id: 'a', role: 'host' }, { type: 'join', profile: 'p', id: 'a', role: 'admin' }, { type: 'host', profile: 'p', id: 'ghost' }, { type: 'connect', profile: 'p', id: 'ghost', request: {} }])
    await client.send(junk);
  await client.send({ type: 'status', profile: 'p' });
  assert.deepEqual(client.port.of('status')[0], { type: 'status', profile: 'p', host: null, clients: [], pending: 0 });
});

// --- the attach protocol -------------------------------------------------------

test('a client can only ask for windows of a sane shape', () => {
  assert.deepEqual(validateClientMessage({ type: 'open', key: 'w1', width: 400.4, height: 300 }), { type: 'open', key: 'w1', width: 400, height: 300, deviceScaleFactor: 1, url: '', frames: 'auto' });
  assert.deepEqual(validateClientMessage({ type: 'bye' }), { type: 'bye' });
  assert.deepEqual(validateClientMessage({ type: 'close', key: 'w1' }), { type: 'close', key: 'w1' });
  for (const junk of [null, 'open', {}, { type: 'open' }, { type: 'open', key: 'a b' }, { type: 'open', key: 'k'.repeat(65) }, { type: 'open', key: 'k', width: 0 }, { type: 'open', key: 'k', height: 20000 }, { type: 'open', key: 'k', deviceScaleFactor: 9 },
    { type: 'open', key: 'k', url: 5 }, { type: 'open', key: 'k', url: 'x'.repeat(9000) }, { type: 'open', key: 'k', frames: 'gl' }, { type: 'close' }, { type: 'close', key: '../x' }, { type: 'eval', code: '1' }, { type: 'open', key: '__proto__x/' }])
    assert.equal(validateClientMessage(junk), null, JSON.stringify(junk));
  // Fields it must not be able to set are dropped, not passed on.
  const clean = validateClientMessage({ type: 'open', key: 'k', hosts: { allow: ['*'] }, window: 7, policy: { dialogs: 'native' } });
  assert.deepEqual(Object.keys(clean).sort(), ['deviceScaleFactor', 'frames', 'height', 'key', 'type', 'url', 'width']);
});

test('a request to attach names its version and an id', () => {
  assert.deepEqual(validateRequest({ version: ATTACH_VERSION, id: 'abc-1', extra: 1 }), { version: ATTACH_VERSION, id: 'abc-1' });
  for (const junk of [null, {}, { version: 2, id: 'a' }, { version: 1 }, { version: 1, id: '' }, { version: 1, id: 'a b' }, { version: 1, id: 5 }])
    assert.equal(validateRequest(junk), null);
});

test('the host\'s messages are checked before a client believes them', () => {
  const ports = [{}, {}];
  assert.deepEqual(validateHostMessage({ type: 'welcome', version: ATTACH_VERSION, host: 'h-1' }), { type: 'welcome', host: 'h-1' });
  assert.equal(validateHostMessage({ type: 'welcome', version: 9, host: 'h' }), null);
  const opened = validateHostMessage({ type: 'opened', key: 'w1', window: 2, url: 'https://example.com/', tabs: [{ id: 2, url: 'https://example.com/', title: 5, evil: 1 }, { nope: 1 }], activeTab: 2 }, ports);
  assert.equal(opened.window, 2);
  assert.deepEqual(opened.tabs, [{ id: 2, url: 'https://example.com/', title: '5', loading: false, canGoBack: false, canGoForward: false, audible: false, icons: [] }]);
  assert.equal(validateHostMessage({ type: 'opened', key: 'w1', window: 2 }, [{}]), null, 'a window comes with its two ports');
  assert.equal(validateHostMessage({ type: 'opened', key: 'w1', window: 0 }, ports), null);
  assert.equal(validateHostMessage({ type: 'opened', key: 'bad key', window: 1 }, ports), null);
  assert.deepEqual(validateHostMessage({ type: 'event', key: 'w1', name: 'tabcreated', detail: { tab: 3 } }), { type: 'event', key: 'w1', name: 'tabcreated', detail: { tab: 3 } });
  assert.equal(validateHostMessage({ type: 'event', key: 'w1', name: 'dialog', detail: {} }), null, 'only the events the host forwards');
  assert.equal(validateHostMessage({ type: 'event', key: 'w1', name: 'tabcreated', detail: [] }), null);
  assert.deepEqual(validateHostMessage({ type: 'crash', key: 'w1', reason: 'oom', kind: 'out_of_memory' }), { type: 'crash', key: 'w1', reason: 'oom', kind: 'out_of_memory' });
  assert.equal(validateHostMessage({ type: 'closed' }), null);
  assert.equal(validateHostMessage('closed'), null);
});

// --- the display channel's additions -----------------------------------------------

test('a display\'s answers, video state and files are checked', () => {
  assert.deepEqual(validateDisplayMessage({ type: 'answer', id: 3, value: true }), { type: 'answer', id: 3, value: true });
  assert.deepEqual(validateDisplayMessage({ type: 'answer', id: 3, value: { evil: 1 } }), { type: 'answer', id: 3, value: null });
  assert.equal(validateDisplayMessage({ type: 'answer', id: 0, value: true }), null);
  assert.equal(validateDisplayMessage({ type: 'answer', id: 'x', value: true }), null);
  assert.equal(validateDisplayMessage({ type: 'media', command: 'media.state', args: { id: 1 } }).command, 'media.state');
  for (const command of ['media.create', 'load', 'eme.update', 'debug.evaluate', 'media.captureFormat'])
    assert.equal(validateDisplayMessage({ type: 'media', command, args: {} }), null, command);
  assert.equal(validateDisplayMessage({ type: 'media', command: 'media.state', args: 'x' }), null);
  assert.equal(validateDisplayMessage({ type: 'media', command: 'media.state', args: { big: 'x'.repeat(70 * 1024) } }), null);
  assert.equal(validateDisplayMessage({ type: 'file', name: 'a.txt', bytes: new ArrayBuffer(4) }).name, 'a.txt');
  for (const junk of [{ type: 'file', name: '', bytes: new ArrayBuffer(1) }, { type: 'file', name: 'a', bytes: new Uint8Array(4) }, { type: 'file', name: 'a'.repeat(300), bytes: new ArrayBuffer(1) }, { type: 'file', name: 'a' }])
    assert.equal(validateDisplayMessage(junk), null);
});

function servedDisplay(options = {}) {
  const { port1, port2 } = new MessageChannel();
  const sent = [];
  const media = [];
  const files = [];
  const served = serveDisplay(port1, { frames: 'pixels', send: (command, args) => sent.push([command, args]), sendMedia: (command, args) => media.push([command, args]), sendFile: (name, bytes) => files.push([name, bytes.byteLength]), ...options });
  const inbox = [];
  port2.on('message', (message) => inbox.push(message));
  const say = async (message, transfer) => {
    port2.postMessage(message, transfer);
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return { served, sent, media, files, inbox, say, close: () => { port2.close(); } };
}

test('a dialog waits for the display, and goes unanswered if the display leaves', async () => {
  const d = servedDisplay();
  const answer = d.served.ask({ question: 'confirm', message: 'sure?' });
  await d.say({ type: 'answer', id: 99, value: true });
  await d.say({ type: 'answer', id: 1, value: false });
  assert.equal(await answer, false);
  const orphan = d.served.ask({ question: 'alert', message: 'bye' });
  await d.say({ type: 'close' });
  assert.equal(await orphan, undefined);
  assert.equal(await d.served.ask({ question: 'alert', message: 'late' }), undefined);
  d.close();
});

test('a display sends files only for a chooser the window raised', async () => {
  const d = servedDisplay();
  await d.say({ type: 'file', name: 'sneaky.txt', bytes: new ArrayBuffer(8) });
  await d.say({ type: 'input', command: 'file.chosen', args: { cancelled: false } });
  assert.deepEqual(d.files, []);
  assert.deepEqual(d.sent, []);
  d.served.post('file.choose', { multiple: false, accept: [] });
  await d.say({ type: 'file', name: 'a.txt', bytes: new ArrayBuffer(8) });
  await d.say({ type: 'input', command: 'file.chosen', args: { cancelled: false } });
  assert.deepEqual(d.files, [['a.txt', 8]]);
  assert.deepEqual(d.sent, [['file.chosen', { cancelled: false }]]);
  // One chooser, one answer.
  await d.say({ type: 'file', name: 'again.txt', bytes: new ArrayBuffer(8) });
  assert.equal(d.files.length, 1);
  d.served.close();
  d.close();
});

test('video state comes back through the media channel only', async () => {
  const d = servedDisplay();
  await d.say({ type: 'media', command: 'media.state', args: { id: 4, currentTime: 1.5 } });
  await d.say({ type: 'media', command: 'load', args: { url: 'https://example.com/' } });
  await d.say({ type: 'input', command: 'media.state', args: {} });
  assert.deepEqual(d.media, [['media.state', { id: 4, currentTime: 1.5 }]]);
  assert.deepEqual(d.sent, []);
  // The media stand-in knows which players and fetches are the display's.
  d.served.media.handleEvent('media.create', { id: 4 });
  d.served.media.handleEvent('media.load', { id: 4, url: 'x', fetch: 9 });
  assert.equal(d.served.media.hasPlayer(4), true);
  assert.equal(d.served.media.ownsFetch(9), true);
  d.served.media.handleFetchEvent('media.fetch.finished', { id: 9 });
  assert.equal(d.served.media.ownsFetch(9), false);
  d.served.media.append(4, 1, 7, new Uint8Array([1, 2, 3]));
  await d.say({ type: 'probe', ok: false });
  assert.ok(d.inbox.some((m) => m.type === 'media-append' && m.bytes.length === 3));
  assert.ok(d.inbox.some((m) => m.type === 'media' && m.name === 'media.create'));
  d.served.close();
  d.close();
});
