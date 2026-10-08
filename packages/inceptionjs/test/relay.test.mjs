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
