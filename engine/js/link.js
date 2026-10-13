// Links between engines of one profile (link/Link.cpp). The host gives each
// end {inceptionLink: {id, port, buffer, serviceEnd}}: a MessagePort for
// asynchronous frames (ArrayBuffers) and a SharedArrayBuffer for calls a
// content engine waits on. A worker blocked in Atomics.wait never sees port
// messages, so a waiting call is written to the shared buffer, the service is
// poked over the port, and the content engine waits on the buffer until the
// service has answered there.
//
// Shared buffer: four Int32 words, then data from byte 64.
//   [0] state: 0 idle, 1 a chunk for the service, 2 a reply chunk, 3 closed,
//       4 the service took a request chunk and wants the next one
//   [1] bytes in the current chunk   [2] total bytes of the request or reply
//   [3] what a state-1 chunk is: 0 part of a request, 1 asks for the next
//       reply chunk
addToLibrary({
  $inceptionLinks: { table: null },

  inception_link_install__deps: ['$inceptionLinks', '$inceptionGuard', 'malloc', 'free', 'inception_loop_schedule'],
  inception_link_install: () => {
    if (inceptionLinks.table) return;
    const table = inceptionLinks.table = new Map();
    const HEADER = 64;

    const deliver = (id, bytes) => {
      const pointer = _malloc(Math.max(bytes.length, 1));
      HEAPU8.set(bytes, pointer);
      try {
        Module._inception_link_receive(id, pointer, bytes.length);
      } finally {
        _free(pointer);
      }
      _inception_loop_schedule(0);
    };

    // Service end: one step of a waiting call.
    const serve = (link) => {
      const { control, data } = link;
      if (Atomics.load(control, 0) !== 1) return;
      const length = control[1];
      if (control[3] === 1) {
        link.replyOffset += link.sentChunk;
        return sendReplyChunk(link);
      }
      const total = control[2];
      if (!link.request || link.request.length !== total) {
        link.request = new Uint8Array(total);
        link.received = 0;
      }
      if (link.received + length > total) return close(link);
      link.request.set(data.subarray(0, length), link.received);
      link.received += length;
      if (link.received < total) {
        Atomics.store(control, 0, 4);
        Atomics.notify(control, 0);
        return;
      }
      const request = link.request;
      link.request = null;
      const pointer = _malloc(Math.max(request.length, 1));
      const lengthOut = _malloc(4);
      HEAPU8.set(request, pointer);
      let reply;
      try {
        const answer = Module._inception_link_receive_sync(link.id, pointer, request.length, lengthOut);
        const size = HEAPU32[lengthOut >> 2];
        reply = HEAPU8.slice(answer, answer + size);
        _free(answer);
      } finally {
        _free(pointer);
        _free(lengthOut);
      }
      link.reply = reply;
      link.replyOffset = 0;
      sendReplyChunk(link);
      _inception_loop_schedule(0);
    };

    const sendReplyChunk = (link) => {
      const { control, data, reply } = link;
      if (!reply) return close(link);
      const chunk = reply.subarray(link.replyOffset, link.replyOffset + data.length);
      data.set(chunk);
      link.sentChunk = chunk.length;
      control[1] = chunk.length;
      control[2] = reply.length;
      if (link.replyOffset + chunk.length >= reply.length) link.reply = null;
      Atomics.store(control, 0, 2);
      Atomics.notify(control, 0);
    };

    // `tellEngine` is false when the engine is the one closing it.
    const close = (link, tellEngine = true) => {
      if (link.closed) return;
      link.closed = true;
      Atomics.store(link.control, 0, 3);
      Atomics.notify(link.control, 0);
      link.port.close();
      table.delete(link.id);
      if (!tellEngine) return;
      Module._inception_link_closed(link.id);
      _inception_loop_schedule(0);
    };
    inceptionLinks.close = close;

    self.addEventListener('message', (e) => {
      const closed = e.data?.inceptionLinkClosed;
      if (typeof closed === 'number') {
        const link = table.get(closed);
        if (link) close(link);
        return;
      }
      const message = e.data?.inceptionLink;
      if (!message || typeof message.id !== 'number' || table.has(message.id)) return;
      const { id, port, buffer, serviceEnd } = message;
      const link = { id, port, serviceEnd: !!serviceEnd, control: new Int32Array(buffer, 0, 4), data: new Uint8Array(buffer, HEADER), closed: false, reply: null, request: null };
      table.set(id, link);
      port.onmessage = (event) => {
        if (link.closed) return;
        if (event.data instanceof ArrayBuffer) return deliver(id, new Uint8Array(event.data));
        if (event.data === 0 && link.serviceEnd) serve(link);
      };
      Module._inception_link_opened(id, link.serviceEnd ? 1 : 0);
      _inception_loop_schedule(0);
    });
  },

  inception_link_post__deps: ['$inceptionLinks'],
  inception_link_post: (id, pointer, length) => {
    const link = inceptionLinks.table?.get(id);
    if (!link || link.closed) return;
    const frame = HEAPU8.slice(pointer, pointer + length);
    link.port.postMessage(frame.buffer, [frame.buffer]);
  },

  // Content end: sends a request and waits for the whole reply, which it
  // returns malloc'd (the caller frees it), or 0 when the link is closed or
  // the service did not answer in time.
  inception_link_call_sync__deps: ['$inceptionLinks', 'malloc'],
  inception_link_call_sync: (id, pointer, length, lengthOut) => {
    const link = inceptionLinks.table?.get(id);
    if (!link || link.closed || link.serviceEnd) return 0;
    const { control, data, port } = link;
    // Longer than any real call takes; a service this slow is treated as gone.
    const TIMEOUT_MS = 60000;
    const wait = (state) => {
      Atomics.store(control, 0, state);
      port.postMessage(0);
      Atomics.wait(control, 0, state, TIMEOUT_MS);
      return Atomics.load(control, 0);
    };
    const request = HEAPU8.slice(pointer, pointer + length);
    let offset = 0;
    let state;
    do {
      const chunk = request.subarray(offset, offset + data.length);
      data.set(chunk);
      control[1] = chunk.length;
      control[2] = request.length;
      control[3] = 0;
      offset += chunk.length;
      state = wait(1);
      if (state === 4 && offset >= request.length) state = 3;
    } while (state === 4);
    let reply = null;
    let received = 0;
    while (state === 2) {
      const size = control[1];
      const total = control[2];
      reply ??= new Uint8Array(total);
      if (received + size > total) break;
      reply.set(data.subarray(0, size), received);
      received += size;
      if (received >= total) {
        Atomics.store(control, 0, 0);
        const answer = _malloc(Math.max(total, 1));
        HEAPU8.set(reply, answer);
        HEAPU32[lengthOut >> 2] = total;
        return answer;
      }
      control[3] = 1;
      state = wait(1);
    }
    inceptionLinks.close(link, false);
    return 0;
  },
});
