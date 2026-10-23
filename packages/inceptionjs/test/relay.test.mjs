import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';
import { startRelay } from '../src/server/relay.js';
import { signRelayToken } from '../src/server/token.js';

const quiet = () => {};

function packet(type, id, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32LE(id, 1);
  return Buffer.concat([header, payload]);
}

function connectPayload(host, port) {
  const p = Buffer.alloc(3);
  p.writeUInt8(1, 0);
  p.writeUInt16LE(port, 1);
  return Buffer.concat([p, Buffer.from(host)]);
}

async function client(url, headers = {}) {
  const ws = new WebSocket(url, { headers });
  const packets = [];
  const waiters = [];
  ws.on('message', (data) => {
    const p = { type: data[0], id: data.readUInt32LE(1), payload: data.subarray(5) };
    packets.push(p);
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
  return { ws, next };
}

test('greets with a window, relays to an allowed dev port, refuses others', async () => {
  const echo = net.createServer((s) => s.pipe(s)).listen(0, '127.0.0.1');
  await new Promise((r) => echo.once('listening', r));
  const echoPort = echo.address().port;
  const relay = await startRelay({ dev: true, devPorts: [echoPort], log: quiet });
  const { ws, next } = await client(relay.url);

  const hello = await next((p) => p.type === 0x03 && p.id === 0);
  assert.equal(hello.payload.readUInt32LE(0), 128);

  ws.send(packet(0x01, 1, connectPayload('127.0.0.1', echoPort)));
  ws.send(packet(0x02, 1, Buffer.from('hola')));
  const data = await next((p) => p.type === 0x02 && p.id === 1);
  assert.equal(data.payload.toString(), 'hola');

  ws.send(packet(0x01, 2, connectPayload('127.0.0.1', 22)));
  const closed = await next((p) => p.type === 0x04 && p.id === 2);
  assert.equal(closed.payload[0], 0x48);

  ws.close();
  await relay.close();
  echo.close();
});

test('requires a valid token when a secret is set, and checks the origin', async () => {
  const secret = 's'.repeat(40);
  const relay = await startRelay({ secret, origins: ['https://app.example'], log: quiet });
  await assert.rejects(client(relay.url, { Origin: 'https://app.example' }));
  await assert.rejects(client(`${relay.url}?token=${signRelayToken({ secret })}`, { Origin: 'https://evil.example' }));
  const ok = await client(`${relay.url}?token=${signRelayToken({ secret, origin: 'https://app.example' })}`, { Origin: 'https://app.example' });
  await ok.next((p) => p.type === 0x03);
  ok.ws.close();
  await relay.close();
});

test('/healthz answers, /metrics only when asked for, and counters add up', async () => {
  const plain = await startRelay({ log: () => {} });
  const base = plain.url.replace('ws://', 'http://');
  const health = await fetch(`${base}healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal((await fetch(`${base}metrics`)).status, 404);
  await plain.close();

  const relay = await startRelay({ log: () => {}, metrics: true, origins: ['https://app.example'] });
  const http = relay.url.replace('ws://', 'http://');
  // A refused origin is counted.
  await new Promise((resolve) => {
    const ws = new WebSocket(relay.url, { headers: { Origin: 'https://other.example' } });
    ws.on('error', resolve);
    ws.on('close', resolve);
  });
  const text = await (await fetch(`${http}metrics`)).text();
  assert.match(text, /^inception_relay_sessions 0$/m);
  assert.match(text, /^inception_relay_refused_total\{reason="origin"\} 1$/m);
  assert.match(text, /^inception_relay_bytes_total\{direction="in"\} 0$/m);
  assert.equal(relay.stats().refused.origin, 1);
  await relay.close();
});

test('stream counters follow streams through relaying and refusal', async () => {
  const echo = net.createServer((s) => s.pipe(s)).listen(0, '127.0.0.1');
  await new Promise((r) => echo.once('listening', r));
  const echoPort = echo.address().port;
  const relay = await startRelay({ dev: true, devPorts: [echoPort], log: quiet, metrics: true });
  const { ws, next } = await client(relay.url);
  ws.send(packet(0x01, 1, connectPayload('127.0.0.1', echoPort)));
  ws.send(packet(0x02, 1, Buffer.from('ping')));
  await next((p) => p.type === 0x02 && p.id === 1);
  assert.equal(relay.stats().streams, 1);
  ws.send(packet(0x01, 2, connectPayload('127.0.0.1', 9)));
  await next((p) => p.type === 0x04 && p.id === 2);
  ws.send(packet(0x04, 1, Buffer.from([0x02])));
  await new Promise((r) => setTimeout(r, 50));
  const stats = relay.stats();
  assert.equal(stats.streamsOpened, 2);
  assert.equal(stats.streams, 0);
  assert.equal(stats.closed.blocked, 1);
  assert.equal(stats.closed.voluntary, 1);
  assert.ok(stats.bytesIn > 0 && stats.bytesOut >= 4);
  ws.close();
  await relay.close();
  echo.close();
});
