// TCP streams for the engine (net/Sockets.cpp), carried over one WebSocket to
// a Wisp relay that the engine worker opens itself. Each stream is a socket
// descriptor; events go straight to the engine and wake its network pump.
addToLibrary({
  $inceptionTcp__deps: ['malloc', 'free', 'inception_loop_schedule'],
  $inceptionTcp: {
    url: null,
    connection: null,

    // Engine thread: data, open and close reach the socket table, then the
    // schedulers run a pass.
    notify() {
      Module._inception_net_pump();
      _inception_loop_schedule(0);
    },

    deliver(fd, payload) {
      const pointer = _malloc(payload.length);
      HEAPU8.set(payload, pointer);
      Module._inception_tcp_data(fd, pointer, payload.length);
      _free(pointer);
    },

    Connection: class {
      constructor(url) {
        this.streams = new Map();
        this.nextId = 1;
        this.initialBuffer = null;
        this.waiting = [];
        this.closed = false;
        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';
        this.ws.onmessage = (e) => this.receive(new Uint8Array(e.data));
        this.ws.onclose = this.ws.onerror = () => this.fail();
      }

      packet(type, id, payload) {
        const packet = new Uint8Array(5 + payload.length);
        const view = new DataView(packet.buffer);
        view.setUint8(0, type);
        view.setUint32(1, id, true);
        packet.set(payload, 5);
        this.ws.send(packet);
      }

      open(fd, host, port) {
        const stream = { id: this.nextId++, fd, buffer: 0, queue: [], open: false, received: false };
        this.streams.set(stream.id, stream);
        const name = new TextEncoder().encode(host);
        const payload = new Uint8Array(3 + name.length);
        payload[0] = 0x01; // TCP
        new DataView(payload.buffer).setUint16(1, port, true);
        payload.set(name, 3);
        const start = () => {
          this.packet(0x01, stream.id, payload);
          stream.buffer = this.initialBuffer;
          // Wisp has no connect acknowledgement: the stream counts as open
          // now, and a refusal arrives as a close before any data.
          stream.open = true;
          Module._inception_tcp_opened(fd);
          inceptionTcp.notify();
          this.flush(stream);
        };
        if (this.initialBuffer !== null) queueMicrotask(start);
        else this.waiting.push(start);
        return stream;
      }

      send(stream, bytes) {
        stream.queue.push(bytes);
        this.flush(stream);
      }

      flush(stream) {
        if (!stream.open) return;
        while (stream.queue.length && stream.buffer > 0) {
          this.packet(0x02, stream.id, stream.queue.shift());
          stream.buffer--;
        }
      }

      close(stream) {
        this.streams.delete(stream.id);
        if (!this.closed && this.ws.readyState === 1) this.packet(0x04, stream.id, new Uint8Array([0x02]));
      }

      receive(packet) {
        if (packet.length < 5) return;
        const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
        const type = view.getUint8(0);
        const id = view.getUint32(1, true);
        const payload = packet.subarray(5);
        if (type === 0x03 && id === 0) {
          this.initialBuffer = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
          for (const start of this.waiting.splice(0)) start();
          return;
        }
        const stream = this.streams.get(id);
        if (!stream) return;
        if (type === 0x02) {
          stream.received = true;
          inceptionTcp.deliver(stream.fd, payload);
        } else if (type === 0x03) {
          stream.buffer = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
          this.flush(stream);
          return;
        } else if (type === 0x04) {
          this.streams.delete(id);
          Module._inception_tcp_closed(stream.fd, stream.received ? 0 : 1);
        }
        inceptionTcp.notify();
      }

      fail() {
        if (this.closed) return;
        this.closed = true;
        for (const stream of this.streams.values()) Module._inception_tcp_closed(stream.fd, stream.received ? 0 : 1);
        this.streams.clear();
        for (const start of this.waiting.splice(0)) start();
        inceptionTcp.notify();
      }
    },

    connect() {
      if (!inceptionTcp.connection || inceptionTcp.connection.closed)
        inceptionTcp.connection = new inceptionTcp.Connection(inceptionTcp.url);
      return inceptionTcp.connection;
    },

    byFd: new Map(),
  },

  inception_tcp_configure__deps: ['$inceptionTcp', '$UTF8ToString'],
  inception_tcp_configure: (url) => {
    inceptionTcp.url = UTF8ToString(url);
  },

  inception_tcp_open__deps: ['$inceptionTcp', '$UTF8ToString'],
  inception_tcp_open: (fd, host, port) => {
    const hostName = UTF8ToString(host);
    if (!inceptionTcp.url) {
      setTimeout(() => {
        Module._inception_tcp_closed(fd, 1);
        inceptionTcp.notify();
      });
      return;
    }
    const connection = inceptionTcp.connect();
    inceptionTcp.byFd.set(fd, { connection, stream: connection.open(fd, hostName, port) });
  },

  inception_tcp_send__deps: ['$inceptionTcp'],
  inception_tcp_send: (fd, data, length) => {
    const entry = inceptionTcp.byFd.get(fd);
    if (entry) entry.connection.send(entry.stream, HEAPU8.slice(data, data + length));
  },

  inception_tcp_close__deps: ['$inceptionTcp'],
  inception_tcp_close: (fd) => {
    const entry = inceptionTcp.byFd.get(fd);
    if (!entry) return;
    inceptionTcp.byFd.delete(fd);
    entry.connection.close(entry.stream);
  },
});
