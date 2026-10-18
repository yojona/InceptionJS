import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';
import { startRelay, CloseReason } from '../src/server/relay.js';
import { signRelayToken } from '../src/server/token.js';
import { addressRange } from '../src/server/policy.js';

const quiet = () => {};

const packet = (type, id, payload = Buffer.alloc(0)) => {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32LE(id, 1);
  return Buffer.concat([header, payload]);
};

const connectPayload = (host, port) => {
  const p = Buffer.alloc(3);
  p.writeUInt8(1, 0);
  p.writeUInt16LE(port, 1);
  return Buffer.concat([p, Buffer.from(host)]);
};

async function client(url, headers = {}) {
  const ws = new WebSocket(url, { headers });
  const packets = [];
  const waiters = [];
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  ws.on('message', (data) => {
    packets.push({ type: data[0], id: data.readUInt32LE(1), payload: data.subarray(5) });
    waiters.splice(0).forEach((w) => w());
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const next = async (predicate) => {
    for (;;) {
      const found = packets.find(predicate);
      if (found) {
        packets.splice(packets.indexOf(found), 1);
        return found;
      }
      await new Promise((r) => waiters.push(r));
    }
  };
  // Asks for a stream and returns how it ended: a close reason, or 'data'.
  let streamId = 0;
  const open = async (host, port, waitMs) => {
    const id = ++streamId;
    ws.send(packet(0x01, id, connectPayload(host, port)));
    const answer = next((p) => p.id === id && (p.type === 0x04 || p.type === 0x02));
    const result = await (waitMs ? Promise.race([answer, new Promise((r) => setTimeout(() => r({ type: 'silent' }), waitMs))]) : answer);
    return result.type === 'silent' ? 'silent' : result.type === 0x04 ? result.payload[0] : 'data';
  };
  return { ws, next, open, closed };
}

const BLOCKED = CloseReason.Blocked;

test('addresses written in any form are refused, whatever the resolver makes of them', async () => {
  const connects = [];
  const relay = await startRelay({ log: quiet, hooks: { connect: (options) => (connects.push(options.host), net.connect({ host: '127.0.0.1', port: 9 })) } });
  const { ws, open } = await client(relay.url);
  const loopbackForms = [
    '127.0.0.1', '127.1', '2130706433', '0x7f000001', '0x7f.0.0.1', '017700000001', '0177.0.0.1',
    '0', '0.0.0.0', '[::1]', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1',
    'localhost', 'LOCALHOST', 'localhost.', 'foo.localhost', 'foo.local', 'box.tail1234.ts.net', 'printer.lan',
    '10.0.0.1', '172.16.5.4', '192.168.0.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    'fd7a:115c:a1e0::1', 'fe80::1', '64:ff9b::7f00:1', '2002:7f00:1::',
  ];
  // Blocked outright, or the resolver could not make sense of the form. Some
  // resolvers read an odd form as a different, public address (0177.0.0.1 is
  // 177.0.0.1 on some systems); then the connection is allowed, and it goes to
  // that checked address.
  for (const host of loopbackForms) await open(host, 80, 2000);
  assert.deepEqual(connects.filter((address) => addressRange(address) !== null), []);
  ws.close();
  await relay.close();
});

test('a public name that resolves to an internal address is refused', async () => {
  const records = {
    'rebind.example': ['127.0.0.1'],
    'metadata.example': ['169.254.169.254'],
    'lan.example': ['192.168.1.20'],
    'ula.example': ['fd00::1'],
    'mapped.example': ['::ffff:127.0.0.1'],
    'tailscale.example': ['100.101.102.103'],
    'mixed.example': ['10.0.0.5', '192.168.0.9'],
  };
  const relay = await startRelay({ log: quiet, hooks: { resolve: async (name) => records[name].map((address) => ({ address })) } });
  const { ws, open } = await client(relay.url);
  for (const name of Object.keys(records)) assert.equal(await open(name, 443), BLOCKED, name);
  ws.close();
  await relay.close();
});

test('only web ports are reachable', async () => {
  const relay = await startRelay({ log: quiet, hooks: { resolve: async () => [{ address: '93.184.215.14' }] } });
  const { ws, open } = await client(relay.url);
  for (const port of [21, 22, 23, 25, 53, 3306, 5432, 6379, 8080, 9200, 11211, 27017]) assert.equal(await open('public.example', port), BLOCKED, `port ${port}`);
  ws.close();
  await relay.close();
});

test('the connection goes to the address that was checked, never to a second resolution', async () => {
  const echo = net.createServer((s) => s.on('error', () => {}).pipe(s)).listen(0, '127.0.0.1');
  await new Promise((r) => echo.once('listening', r));
  let lookups = 0;
  const connected = [];
  const relay = await startRelay({
    log: quiet,
    hooks: {
      // The first answer is public, any later one would be internal.
      resolve: async () => [{ address: ++lookups === 1 ? '93.184.215.14' : '127.0.0.1' }],
      connect: ({ host }) => (connected.push(host), net.connect({ host: '127.0.0.1', port: echo.address().port })),
    },
  });
  const { ws, next } = await client(relay.url);
  ws.send(packet(0x01, 1, connectPayload('rebind.example', 443)));
  ws.send(packet(0x02, 1, Buffer.from('ping')));
  assert.equal((await next((p) => p.type === 0x02 && p.id === 1)).payload.toString(), 'ping');
  assert.deepEqual(connected, ['93.184.215.14']);
  assert.equal(lookups, 1);
  ws.close();
  await relay.close();
  echo.close();
});

test('a public record is used when a name has both public and internal ones', async () => {
  const connected = [];
  const relay = await startRelay({
    log: quiet,
    hooks: {
      resolve: async () => [{ address: '10.0.0.5' }, { address: '93.184.215.14' }],
      connect: ({ host }) => (connected.push(host), net.connect({ host: '127.0.0.1', port: 9 })),
    },
  });
  const { ws, open } = await client(relay.url);
  await open('both.example', 443);
  assert.deepEqual(connected, ['93.184.215.14']);
  ws.close();
  await relay.close();
});

test('development mode opens loopback to the listed ports only', async () => {
  const relay = await startRelay({ log: quiet, dev: true, devPorts: [5173] });
  const { ws, open } = await client(relay.url);
  for (const host of ['127.0.0.1', 'localhost']) assert.equal(await open(host, 22), BLOCKED, host);
  // Private ranges stay closed in development.
  assert.equal(await open('192.168.1.1', 5173), BLOCKED);
  assert.equal(await open('169.254.169.254', 80), BLOCKED);
  ws.close();
  await relay.close();
});

test('a relay reachable from outside the machine refuses to start without a secret', async () => {
  await assert.rejects(startRelay({ host: '0.0.0.0', log: quiet }), /secret/);
  await assert.rejects(startRelay({ host: '192.168.1.5', log: quiet }), /secret/);
  await assert.rejects(startRelay({ host: '0.0.0.0', secret: 'short', log: quiet }), /at least 32 characters/);
  const relay = await startRelay({ host: '0.0.0.0', secret: 's'.repeat(40), log: quiet });
  await relay.close();
  const local = await startRelay({ host: 'localhost', log: quiet });
  await local.close();
});

test('sessions without a valid token are refused, expired ones too', async () => {
  const secret = 's'.repeat(40);
  const relay = await startRelay({ secret, log: quiet });
  await assert.rejects(client(relay.url));
  await assert.rejects(client(`${relay.url}?token=garbage`));
  await assert.rejects(client(`${relay.url}?token=${signRelayToken({ secret, ttlSeconds: 60, now: 0 })}`));
  await assert.rejects(client(`${relay.url}?token=${signRelayToken({ secret: 'z'.repeat(40) })}`));
  const ok = await client(`${relay.url}?token=${signRelayToken({ secret })}`);
  ok.ws.close();
  await relay.close();
});

test('limits: streams per minute, sessions, and bytes per session', async () => {
  const resolve = async () => [{ address: '93.184.215.14' }];
  const connect = () => net.connect({ host: '127.0.0.1', port: 9 });

  const rate = await startRelay({ log: quiet, connectsPerMinute: 2, hooks: { resolve, connect } });
  const first = await client(rate.url);
  await first.open('a.example', 443);
  await first.open('b.example', 443);
  assert.equal(await first.open('c.example', 443), CloseReason.Throttled);
  first.ws.close();
  await rate.close();

  const few = await startRelay({ log: quiet, maxConnections: 1 });
  const one = await client(few.url);
  await assert.rejects(client(few.url));
  one.ws.close();
  await few.close();

  const echo = net.createServer((s) => s.on('error', () => {}).pipe(s)).listen(0, '127.0.0.1');
  await new Promise((r) => echo.once('listening', r));
  const budget = await startRelay({ log: quiet, maxBytes: 2000, hooks: { resolve, connect: () => net.connect({ host: '127.0.0.1', port: echo.address().port }) } });
  const big = await client(budget.url);
  big.ws.send(packet(0x01, 1, connectPayload('c.example', 443)));
  for (let i = 0; i < 5; i++) big.ws.send(packet(0x02, 1, Buffer.alloc(1000, 1)));
  assert.equal(await big.closed, 1008);
  await budget.close();
  echo.close();
});

test('the log carries destinations and sizes, never content', async () => {
  const lines = [];
  const echo = net.createServer((s) => s.on('error', () => {}).pipe(s)).listen(0, '127.0.0.1');
  await new Promise((r) => echo.once('listening', r));
  const relay = await startRelay({
    log: (level, message) => lines.push(message),
    hooks: { resolve: async () => [{ address: '93.184.215.14' }], connect: () => net.connect({ host: '127.0.0.1', port: echo.address().port }) },
  });
  const { ws, next } = await client(relay.url);
  ws.send(packet(0x01, 1, connectPayload('logged.example', 443)));
  ws.send(packet(0x02, 1, Buffer.from('the secret password')));
  await next((p) => p.type === 0x02 && p.id === 1);
  ws.close();
  await new Promise((r) => setTimeout(r, 100));
  await relay.close();
  echo.close();
  const text = lines.join('\n');
  assert.match(text, /logged\.example:443/);
  assert.match(text, /\d+ bytes/);
  assert.doesNotMatch(text, /password/);
});

test('a stream that is still connecting gets no new window and cannot queue without limit', async () => {
  // The name never resolves, so the stream stays in its connecting state.
  const relay = await startRelay({ log: quiet, hooks: { resolve: () => new Promise(() => {}) } });
  const { ws, next } = await client(relay.url);
  ws.send(packet(0x01, 1, connectPayload('example.com', 443)));
  const chunk = Buffer.alloc(64 * 1024);
  for (let i = 0; i < 20; i++) ws.send(packet(0x02, 1, chunk));
  const answer = await next((p) => p.id === 1 && (p.type === 0x03 || p.type === 0x04));
  assert.equal(answer.type, 0x04, 'no CONTINUE before the connection opens');
  assert.equal(answer.payload[0], CloseReason.Throttled);
  ws.close();
  await relay.close();
});
