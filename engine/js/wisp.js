// TCP for the engine. curl opens sockets through emscripten's SOCKFS, which
// models each TCP connection as a WebSocket tagged with the "inception-tcp"
// subprotocol. Socket calls are proxied to the page's main thread, so that is
// where these "WebSockets" are made: streams multiplexed over one WebSocket to
// a Wisp relay, which does the actual TCP. TLS is end to end, inside the
// engine; the relay only sees ciphertext. Whenever a stream changes state the
// engine thread is poked so its network schedulers run at once.
addToLibrary({
  $inceptionWisp__deps: ['$PThread'],
  $inceptionWisp__postset: 'inceptionWisp.install();',
  $inceptionWisp: {
    url: null,
    connection: null,
    NativeWebSocket: null,

    install() {
      if (ENVIRONMENT_IS_PTHREAD || inceptionWisp.NativeWebSocket) return;
      inceptionWisp.url = Module['inceptionWispUrl'] ?? null;
      inceptionWisp.NativeWebSocket = self.WebSocket;
      const Native = inceptionWisp.NativeWebSocket;
      self.WebSocket = function (url, protocols) {
        const list = Array.isArray(protocols) ? protocols : [protocols];
        if (!list.includes('inception-tcp')) return new Native(url, protocols);
        const target = new URL(url);
        return inceptionWisp.connect(target.hostname, Number(target.port) || 443);
      };
      Object.assign(self.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    },

    // Runs after SOCKFS has queued the event, so the engine sees it.
    poke() {
      PThread.runningWorkers[0]?.postMessage({ inceptionPump: 1 });
    },

    connect(host, port) {
      if (!inceptionWisp.connection || inceptionWisp.connection.closed) {
        inceptionWisp.connection = new inceptionWisp.Connection(inceptionWisp.url);
      }
      return inceptionWisp.connection.open(host, port);
    },

    Connection: class {
      constructor(url) {
        this.streams = new Map();
        this.nextId = 1;
        this.initialBuffer = null;
        this.waiting = [];
        this.closed = false;
        if (!url) {
          this.closed = true;
          return;
        }
        this.ws = new inceptionWisp.NativeWebSocket(url);
        this.ws.binaryType = 'arraybuffer';
        this.ws.onmessage = (e) => this.receive(new Uint8Array(e.data));
        this.ws.onclose = this.ws.onerror = () => this.fail();
      }

      open(host, port) {
        const stream = new inceptionWisp.Stream(this, this.nextId++);
        this.streams.set(stream.id, stream);
        if (this.closed) {
          setTimeout(() => stream.remoteClose());
          return stream;
        }
        const name = new TextEncoder().encode(host);
        const payload = new Uint8Array(3 + name.length);
        payload[0] = 0x01; // TCP
        new DataView(payload.buffer).setUint16(1, port, true);
        payload.set(name, 3);
        this.whenReady(() => {
          this.send(0x01, stream.id, payload);
          stream.buffer = this.initialBuffer;
          stream.opened();
        });
        return stream;
      }

      whenReady(fn) {
        if (this.initialBuffer !== null) fn();
        else this.waiting.push(fn);
      }

      send(type, id, payload) {
        const packet = new Uint8Array(5 + payload.length);
        const view = new DataView(packet.buffer);
        view.setUint8(0, type);
        view.setUint32(1, id, true);
        packet.set(payload, 5);
        this.ws.send(packet);
      }

      receive(packet) {
        if (packet.length < 5) return;
        const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
        const type = view.getUint8(0);
        const id = view.getUint32(1, true);
        const payload = packet.subarray(5);
        if (type === 0x03 && id === 0) {
          // The relay announces how many packets each stream may have in flight.
          this.initialBuffer = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
          const waiting = this.waiting;
          this.waiting = [];
          waiting.forEach((fn) => fn());
          return;
        }
        const stream = this.streams.get(id);
        if (!stream) return;
        if (type === 0x02) stream.deliver(payload);
        else if (type === 0x03) stream.grant(new DataView(payload.buffer, payload.byteOffset).getUint32(0, true));
        else if (type === 0x04) stream.remoteClose();
      }

      fail() {
        this.closed = true;
        for (const stream of this.streams.values()) stream.remoteClose();
        this.streams.clear();
      }
    },

    // Looks enough like a WebSocket for SOCKFS.
    Stream: class {
      constructor(connection, id) {
        this.connection = connection;
        this.id = id;
        this.readyState = 0;
        this.binaryType = 'arraybuffer';
        this.buffer = 0;
        this.queue = [];
        this.onopen = this.onmessage = this.onclose = this.onerror = null;
        Object.assign(this, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
      }

      opened() {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.();
        inceptionWisp.poke();
      }

      send(data) {
        if (this.readyState !== 1) return;
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        this.queue.push(bytes.slice());
        this.flush();
      }

      flush() {
        while (this.queue.length && this.buffer > 0) {
          this.connection.send(0x02, this.id, this.queue.shift());
          this.buffer--;
        }
      }

      grant(remaining) {
        this.buffer = remaining;
        this.flush();
      }

      deliver(payload) {
        if (this.readyState !== 1) return;
        this.onmessage?.({ data: payload.slice().buffer });
        inceptionWisp.poke();
      }

      close() {
        if (this.readyState >= 2) return;
        this.readyState = 3;
        this.connection.streams.delete(this.id);
        if (!this.connection.closed) this.connection.send(0x04, this.id, new Uint8Array([0x02]));
      }

      remoteClose() {
        if (this.readyState === 3) return;
        const wasOpen = this.readyState === 1;
        this.readyState = 3;
        this.connection.streams.delete(this.id);
        if (!wasOpen) this.onerror?.(new Event('error'));
        this.onclose?.();
        inceptionWisp.poke();
      }
    },
  },
});
