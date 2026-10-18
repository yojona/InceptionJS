// The relay: the engine's TCP connections, multiplexed over one WebSocket per
// view with the Wisp protocol (version 1). TLS ends inside the engine, so the
// relay only ever forwards ciphertext; it sees destination names and ports, and
// enforces where connections may go (./policy.js).
//
// Packets: type (u8), stream id (u32 LE), payload.
//   0x01 CONNECT  stream type (u8, 1 = TCP), port (u16 LE), hostname (UTF-8)
//   0x02 DATA     bytes
//   0x03 CONTINUE buffer window (u32 LE): how many DATA packets the client may send
//   0x04 CLOSE    reason (u8)

import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { WebSocketServer } from 'ws';
import { connectRefusal, nameRefusal } from './policy.js';
import { RelayTokenError, verifyRelayToken } from './token.js';

const CONNECT = 0x01;
const DATA = 0x02;
const CONTINUE = 0x03;
const CLOSE = 0x04;

export const CloseReason = Object.freeze({
  Unknown: 0x01,
  Voluntary: 0x02,
  NetworkError: 0x03,
  Invalid: 0x41,
  Unreachable: 0x42,
  ConnectTimeout: 0x43,
  Refused: 0x44,
  Timeout: 0x47,
  Blocked: 0x48,
  Throttled: 0x49,
});

const WINDOW = 128;

function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || (net.isIPv4(host) && host.startsWith('127.'));
}
// Stop reading from a remote socket while this much is queued towards the page.
const HIGH_WATER = 4 * 1024 * 1024;
// What a stream may queue while its connection opens. Before the connection
// the page sends little more than a TLS hello; the window is only granted once
// the connection is up, so a page that keeps sending past this ignores it.
const PENDING_MAX = 1024 * 1024;

function packet(type, id, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32LE(id, 1);
  return Buffer.concat([header, payload]);
}

const u32 = (value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value, 0);
  return b;
};

/**
 * Starts a relay. Options:
 *   port, host           where to listen (default 127.0.0.1, port 0 = any free port)
 *   secret               require a signed token (?token=) from inceptionjs/server
 *   origins              allowed page origins (array); empty allows any
 *   dev, devPorts        allow loopback to these local development ports
 *   maxStreams           per connection (default 256)
 *   maxConnections       open WebSockets in total (default 500)
 *   maxBytes             bytes a session may move in both directions (default 4 GiB)
 *   connectsPerMinute    new streams a session may open per minute (default 600)
 *   connectTimeoutMs     default 10000
 *   log                  (level, message) => void; it gets destinations, ports
 *                        and sizes, never content
 *   hooks                { resolve(hostname), connect(options) } replace DNS and
 *                        TCP, for tests
 *
 * Listening on anything but a loopback address requires `secret`: an open relay
 * would let anyone on the internet use the host as a proxy.
 * Resolves to {url, port, close()}.
 */
export async function startRelay(options = {}) {
  const {
    port = 0,
    host = '127.0.0.1',
    secret = process.env.INCEPTION_RELAY_SECRET || undefined,
    origins = [],
    dev = false,
    devPorts = [],
    maxStreams = 256,
    maxConnections = 500,
    maxBytes = 4 * 1024 ** 3,
    connectsPerMinute = 600,
    connectTimeoutMs = 10_000,
    log = (level, message) => console[level === 'warn' ? 'warn' : 'log'](`[relay] ${message}`),
    hooks = {},
  } = options;
  const resolveName = hooks.resolve ?? ((hostname) => lookup(hostname, { all: true, order: 'ipv4first' }));
  const connectTcp = hooks.connect ?? net.connect;
  if (!secret && !isLoopbackHost(host))
    throw new Error(`the relay would listen on ${host} without a secret: set INCEPTION_RELAY_SECRET (or secret), or listen on 127.0.0.1`);
  const policy = { dev, devPorts: new Set(devPorts.map(Number)) };

  const server = http.createServer((req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    if (wss.clients.size >= maxConnections) {
      log('warn', `refused connection: ${maxConnections} sessions are open`);
      socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return;
    }
    const origin = req.headers.origin ?? '';
    if (origins.length && !origins.includes(origin)) {
      log('warn', `refused origin ${origin || '(none)'}`);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    if (secret) {
      const token = new URL(req.url, 'http://relay').searchParams.get('token');
      try {
        verifyRelayToken(token, { secret, origin });
      } catch (error) {
        log('warn', `refused token: ${error instanceof RelayTokenError ? error.message : 'invalid'}`);
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => serveConnection(ws));
  });

  function serveConnection(ws) {
    const streams = new Map();
    const session = { bytesIn: 0, bytesOut: 0, opened: 0, recent: [] };
    const overBudget = () => {
      if (session.bytesIn + session.bytesOut <= maxBytes) return false;
      log('warn', `session over its ${maxBytes} byte budget, closed`);
      ws.close(1008, 'byte budget exhausted');
      return true;
    };
    const send = (type, id, payload) => {
      if (ws.readyState === ws.OPEN) ws.send(packet(type, id, payload));
    };
    const close = (id, reason) => {
      const stream = streams.get(id);
      if (!stream) return;
      streams.delete(id);
      stream.socket?.destroy();
      send(CLOSE, id, Buffer.from([reason]));
    };
    // Reading resumes once the page has drained what is queued.
    const drainTimer = setInterval(() => {
      if (ws.bufferedAmount >= HIGH_WATER) return;
      for (const stream of streams.values()) if (stream.socket?.isPaused()) stream.socket.resume();
    }, 50);

    send(CONTINUE, 0, u32(WINDOW));

    ws.on('message', (data, isBinary) => {
      if (!isBinary || data.length < 5) return;
      session.bytesIn += data.length;
      if (overBudget()) return;
      const type = data.readUInt8(0);
      const id = data.readUInt32LE(1);
      const payload = data.subarray(5);
      if (type === CONNECT) open(id, payload);
      else if (type === DATA) write(id, payload);
      else if (type === CLOSE) close(id, CloseReason.Voluntary);
    });
    ws.on('close', () => {
      clearInterval(drainTimer);
      log('info', `session closed: ${session.opened} streams, ${session.bytesIn} bytes from the page, ${session.bytesOut} bytes to it`);
      for (const stream of streams.values()) stream.socket?.destroy();
      streams.clear();
    });

    async function open(id, payload) {
      if (streams.has(id) || id === 0) return;
      if (streams.size >= maxStreams) {
        send(CLOSE, id, Buffer.from([CloseReason.Throttled]));
        return;
      }
      if (payload.length < 4 || payload.readUInt8(0) !== 1) {
        send(CLOSE, id, Buffer.from([CloseReason.Invalid]));
        return;
      }
      const now = Date.now();
      session.recent = session.recent.filter((time) => now - time < 60_000);
      if (session.recent.length >= connectsPerMinute) {
        log('warn', `session opened more than ${connectsPerMinute} streams in a minute`);
        send(CLOSE, id, Buffer.from([CloseReason.Throttled]));
        return;
      }
      session.recent.push(now);
      session.opened++;
      const port = payload.readUInt16LE(1);
      const hostname = payload.subarray(3).toString('utf8');
      const stream = { socket: null, pending: [], pendingBytes: 0, owed: false, sinceContinue: 0, bytesIn: 0, bytesOut: 0 };
      streams.set(id, stream);

      const refused = nameRefusal(hostname, policy);
      if (refused) {
        log('warn', `blocked ${hostname}:${port} (${refused})`);
        close(id, CloseReason.Blocked);
        return;
      }
      let address;
      try {
        const candidates = net.isIP(hostname) ? [{ address: hostname }] : await resolveName(hostname);
        const reasons = [];
        address = candidates.map((c) => c.address).find((a) => {
          const reason = connectRefusal(a, port, policy);
          if (reason) reasons.push(`${a}: ${reason}`);
          return !reason;
        });
        if (!address) {
          log('warn', `blocked ${hostname}:${port} (${reasons.join(', ')})`);
          close(id, CloseReason.Blocked);
          return;
        }
      } catch {
        close(id, CloseReason.Unreachable);
        return;
      }
      if (!streams.has(id)) return;

      // Connecting to the checked address, never to the name again, so a
      // second resolution cannot point somewhere else.
      const socket = connectTcp({ host: address, port });
      stream.socket = socket;
      socket.setNoDelay(true);
      socket.setTimeout(connectTimeoutMs, () => close(id, socket.connecting ? CloseReason.ConnectTimeout : CloseReason.Timeout));
      socket.once('connect', () => {
        socket.setTimeout(0);
        for (const chunk of stream.pending.splice(0)) socket.write(chunk);
        stream.pendingBytes = 0;
        if (stream.owed) grant(id, stream);
      });
      socket.on('data', (chunk) => {
        stream.bytesOut += chunk.length;
        session.bytesOut += chunk.length;
        if (overBudget()) return;
        send(DATA, id, chunk);
        if (ws.bufferedAmount >= HIGH_WATER) socket.pause();
      });
      socket.on('error', (error) => close(id, error.code === 'ECONNREFUSED' ? CloseReason.Refused : CloseReason.NetworkError));
      socket.on('close', () => {
        log('info', `closed ${hostname}:${port}: ${stream.bytesIn} bytes sent, ${stream.bytesOut} received`);
        close(id, CloseReason.Voluntary);
      });
    }

    function write(id, payload) {
      const stream = streams.get(id);
      if (!stream) return;
      stream.bytesIn += payload.length;
      const connecting = !stream.socket || stream.socket.connecting;
      if (connecting) {
        stream.pendingBytes += payload.length;
        if (stream.pendingBytes > PENDING_MAX) {
          log('warn', `stream sent ${stream.pendingBytes} bytes before its connection opened, closed`);
          close(id, CloseReason.Throttled);
          return;
        }
        stream.pending.push(Buffer.from(payload));
      } else stream.socket.write(payload);
      // Grant a new window once half of it is used and the remote side keeps
      // up; a connection that is still opening gets it once it opens.
      if (++stream.sinceContinue < WINDOW / 2) return;
      if (connecting) stream.owed = true;
      else grant(id, stream);
    }

    function grant(id, stream) {
      stream.owed = false;
      const grantWindow = () => {
        if (!streams.has(id)) return;
        stream.sinceContinue = 0;
        send(CONTINUE, id, u32(WINDOW));
      };
      if (stream.socket.writableNeedDrain) stream.socket.once('drain', grantWindow);
      else grantWindow();
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  const url = `ws://${host}:${actualPort}/`;
  log('info', `listening on ${url}${secret ? ' (tokens required)' : ''}${dev ? ` (dev: loopback to ports ${[...policy.devPorts].join(', ') || 'none'})` : ''}`);
  return {
    url,
    port: actualPort,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}
