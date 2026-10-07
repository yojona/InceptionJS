// The InceptionJS protocol: JSON-RPC 2.0 messages over any transport. A
// connection starts with `hello`, which settles the protocol version and the
// capability set; methods outside that set fail with a typed error. Events are
// notifications named "event" with {name, data}. The element, remote agents and
// a future CDP adapter are all clients of this one surface.

export const PROTOCOL_VERSION = 1;

export const ErrorCode = Object.freeze({
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  VersionMismatch: -32000,
  NotNegotiated: -32001,
  CapabilityMissing: -32002,
});

export class ProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// --- transports -------------------------------------------------------------
// A transport has send(message) and an onmessage(message) slot; messages are
// plain objects. Serialization is the transport's business.

export function createInPagePair() {
  const a = { onmessage: null, send: (m) => queueMicrotask(() => b.onmessage?.(structuredClone(m))) };
  const b = { onmessage: null, send: (m) => queueMicrotask(() => a.onmessage?.(structuredClone(m))) };
  return [a, b];
}

// `target` is a Window, MessagePort or Worker. With a Window, `origin` is the
// peer's origin; messages from anywhere else are ignored.
export function createPostMessageTransport(target, origin = '*', source = self) {
  const isWindow = typeof Window !== 'undefined' && target instanceof Window;
  const transport = {
    onmessage: null,
    send: (m) => (isWindow ? target.postMessage({ inceptionProtocol: m }, origin) : target.postMessage({ inceptionProtocol: m })),
  };
  const listener = (e) => {
    if (isWindow && origin !== '*' && e.origin !== origin) return;
    if (e.data?.inceptionProtocol) transport.onmessage?.(e.data.inceptionProtocol);
  };
  (isWindow ? source : target).addEventListener('message', listener);
  target.start?.();
  return transport;
}

export function createWebSocketTransport(socket) {
  const transport = { onmessage: null, send: (m) => socket.send(JSON.stringify(m)) };
  socket.addEventListener('message', (e) => {
    try {
      transport.onmessage?.(JSON.parse(e.data));
    } catch {
      transport.send({ jsonrpc: '2.0', id: null, error: { code: ErrorCode.ParseError, message: 'invalid JSON' } });
    }
  });
  return transport;
}

// --- server -----------------------------------------------------------------

export class ProtocolServer {
  #methods = new Map();
  #capabilities;
  #connections = new Set();

  // `capabilities` lists what this server implements; each method belongs to
  // one capability ("view.navigate" -> "view").
  constructor(capabilities) {
    this.#capabilities = new Set(capabilities);
  }

  handle(name, fn) {
    this.#methods.set(name, fn);
  }

  connect(transport) {
    const connection = { transport, negotiated: null };
    this.#connections.add(connection);
    transport.onmessage = (message) => this.#receive(connection, message);
    return () => this.#connections.delete(connection);
  }

  emit(name, data) {
    for (const { transport, negotiated } of this.#connections) {
      if (negotiated) transport.send({ jsonrpc: '2.0', method: 'event', params: { name, data } });
    }
  }

  async #receive(connection, message) {
    const { id = null, method, params = {} } = message ?? {};
    const reply = (body) => id !== null && connection.transport.send({ jsonrpc: '2.0', id, ...body });
    try {
      if (message?.jsonrpc !== '2.0' || typeof method !== 'string')
        throw new ProtocolError(ErrorCode.InvalidRequest, 'not a JSON-RPC 2.0 request');
      if (method === 'hello') return reply({ result: this.#hello(connection, params) });
      if (!connection.negotiated) throw new ProtocolError(ErrorCode.NotNegotiated, 'call hello first');
      const capability = method.split('.')[0];
      if (!connection.negotiated.has(capability))
        throw new ProtocolError(ErrorCode.CapabilityMissing, `capability "${capability}" not negotiated`);
      const fn = this.#methods.get(method);
      if (!fn) throw new ProtocolError(ErrorCode.MethodNotFound, `unknown method ${method}`);
      reply({ result: (await fn(params)) ?? null });
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : ErrorCode.Internal;
      reply({ error: { code, message: error.message, data: error.data } });
    }
  }

  #hello(connection, { version, capabilities = [] }) {
    if (version !== PROTOCOL_VERSION)
      throw new ProtocolError(ErrorCode.VersionMismatch, `server speaks protocol ${PROTOCOL_VERSION}`, { version: PROTOCOL_VERSION });
    const wanted = capabilities.length ? capabilities : [...this.#capabilities];
    connection.negotiated = new Set(wanted.filter((c) => this.#capabilities.has(c)));
    return { version: PROTOCOL_VERSION, capabilities: [...connection.negotiated] };
  }
}

// --- client -----------------------------------------------------------------

export class ProtocolClient extends EventTarget {
  #transport;
  #nextId = 1;
  #inflight = new Map();
  capabilities = [];

  constructor(transport) {
    super();
    this.#transport = transport;
    transport.onmessage = (message) => this.#receive(message);
  }

  async hello(capabilities = []) {
    const result = await this.request('hello', { version: PROTOCOL_VERSION, capabilities });
    this.capabilities = result.capabilities;
    return result;
  }

  request(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#inflight.set(id, { resolve, reject });
      this.#transport.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  #receive(message) {
    if (message?.method === 'event') {
      const { name, data } = message.params ?? {};
      this.dispatchEvent(new CustomEvent(name, { detail: data }));
      return;
    }
    const pending = this.#inflight.get(message?.id);
    if (!pending) return;
    this.#inflight.delete(message.id);
    if (message.error) pending.reject(new ProtocolError(message.error.code, message.error.message, message.error.data));
    else pending.resolve(message.result);
  }
}
