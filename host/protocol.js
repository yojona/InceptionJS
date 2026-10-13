// The InceptionJS protocol: JSON-RPC 2.0 messages over any transport. A
// connection starts with `hello`, which settles the protocol version and the
// capability set; methods outside that set fail with a typed error. Events are
// notifications named "event" with {name, data}. The element, remote agents and
// a future CDP adapter are all clients of this one surface.
//
// A connection is bound to one window of the engine (window 1 unless it was
// served for another, or names one in `hello` it may bind to). Methods act on
// that window and its events reach only connections bound to it; a client
// cannot name another window.

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
  // Failures of view and agent methods. Each also carries its stable name in
  // error.data.reason (see REASON_CODES).
  NotReady: -32010,
  NoSuchRef: -32011,
  StaleRef: -32012,
  Timeout: -32013,
  NavigationFailed: -32014,
  DeniedByPolicy: -32015,
  NotSupported: -32016,
  ControlHeld: -32017,
  EngineCrashed: -32018,
  RateLimited: -32019,
  NotActionable: -32020,
  UnsupportedMode: -32021,
});

// Stable error names, as data.reason, and their codes. Names the engine
// reports that are not listed map to InvalidParams.
export const REASON_CODES = Object.freeze({
  not_ready: ErrorCode.NotReady,
  no_such_ref: ErrorCode.NoSuchRef,
  stale_ref: ErrorCode.StaleRef,
  timeout: ErrorCode.Timeout,
  navigation_failed: ErrorCode.NavigationFailed,
  denied_by_policy: ErrorCode.DeniedByPolicy,
  not_supported: ErrorCode.NotSupported,
  control_held: ErrorCode.ControlHeld,
  engine_crashed: ErrorCode.EngineCrashed,
  rate_limited: ErrorCode.RateLimited,
  not_actionable: ErrorCode.NotActionable,
  not_visible: ErrorCode.NotActionable,
  not_editable: ErrorCode.NotActionable,
  focus_changed: ErrorCode.NotActionable,
  no_such_option: ErrorCode.NotActionable,
  unsupported_mode: ErrorCode.UnsupportedMode,
  invalid_params: ErrorCode.InvalidParams,
});

export class ProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }

  // The stable name of the failure ('stale_ref', 'denied_by_policy', ...).
  get reason() {
    return this.data?.reason;
  }

  // A failure by name, with its code: fail('stale_ref', 'the node is gone').
  static fromReason(reason, message, data = {}) {
    return new ProtocolError(REASON_CODES[reason] ?? ErrorCode.InvalidParams, message, { ...data, reason });
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
// peer's origin and is required: messages from any other origin or window are
// ignored, and ours are sent to that origin only. Passing '*' accepts any
// origin, which is almost never what a page that holds a view wants.
export function createPostMessageTransport(target, origin, source = self) {
  const isWindow = typeof Window !== 'undefined' && target instanceof Window;
  if (isWindow && typeof origin !== 'string') throw new TypeError("a Window peer needs its origin: createPostMessageTransport(window, 'https://peer.example')");
  const transport = {
    onmessage: null,
    send: (m) => (isWindow ? target.postMessage({ inceptionProtocol: m }, origin) : target.postMessage({ inceptionProtocol: m })),
  };
  const listener = (e) => {
    if (isWindow && ((origin !== '*' && e.origin !== origin) || e.source !== target)) return;
    if (e.data?.inceptionProtocol) transport.onmessage?.(e.data.inceptionProtocol);
  };
  (isWindow ? source : target).addEventListener('message', listener);
  target.start?.();
  return transport;
}

// Messages from a socket are untrusted: anything over `maxMessageBytes`
// (default 1 MiB) is refused before it is parsed.
export function createWebSocketTransport(socket, { maxMessageBytes = 1024 * 1024 } = {}) {
  const transport = { onmessage: null, send: (m) => socket.send(JSON.stringify(m)) };
  socket.addEventListener('message', (e) => {
    if (typeof e.data !== 'string' || e.data.length > maxMessageBytes) {
      transport.send({ jsonrpc: '2.0', id: null, error: { code: ErrorCode.InvalidRequest, message: 'message too large or not text' } });
      return;
    }
    try {
      transport.onmessage?.(JSON.parse(e.data));
    } catch {
      transport.send({ jsonrpc: '2.0', id: null, error: { code: ErrorCode.ParseError, message: 'invalid JSON' } });
    }
  });
  return transport;
}

// --- server -----------------------------------------------------------------

const isWindowId = (value) => Number.isInteger(value) && value > 0;

export class ProtocolServer {
  #methods = new Map();
  #capabilities;
  #optIn;
  #connections = new Set();

  #windowExists;

  // `capabilities` lists what this server implements; each method belongs to
  // one capability (by default the part of its name before the dot). Those in
  // `optIn` are sensitive: a client gets them only by asking for them by name,
  // and only if the connection was allowed them (see connect). `windowExists`
  // says whether a window id names a live window (default: only window 1).
  constructor(capabilities, { optIn = [], windowExists = (id) => id === 1 } = {}) {
    this.#capabilities = new Set(capabilities);
    this.#optIn = new Set(optIn);
    this.#windowExists = windowExists;
  }

  // `fn(params, {window})` runs for the window the calling connection is
  // bound to.
  handle(name, fn, capability = name.split('.')[0]) {
    this.#methods.set(name, { fn, capability });
  }

  // `allow`: the capabilities this connection may negotiate (default: all).
  // `window`: the window it is bound to (default 1). It may bind to another
  // window in `hello` only if it may negotiate 'windows' (connections with no
  // `allow`, the embedder's own, may).
  connect(transport, { allow, window = 1 } = {}) {
    if (!isWindowId(window)) throw new TypeError('window must be a positive integer');
    const connection = { transport, negotiated: null, allow: allow ? new Set(allow) : null, window };
    this.#connections.add(connection);
    transport.onmessage = (message) => this.#receive(connection, message);
    return () => this.#connections.delete(connection);
  }

  // Events go to the connections that negotiated `capability` and, when
  // `window` is given, are bound to that window.
  emit(name, data, capability = 'view', window = undefined) {
    for (const { transport, negotiated, window: bound } of this.#connections) {
      if (window !== undefined && bound !== window) continue;
      if (negotiated?.has(capability)) transport.send({ jsonrpc: '2.0', method: 'event', params: { name, data } });
    }
  }

  async #receive(connection, message) {
    const { id: requested = null, method, params } = message ?? {};
    const validId = requested === null || typeof requested === 'number' || typeof requested === 'string';
    const id = validId ? requested : null;
    // A request without an id is a notification: it gets no answer.
    const reply = (body) => (id !== null || !validId) && connection.transport.send({ jsonrpc: '2.0', id, ...body });
    try {
      if (!validId || message?.jsonrpc !== '2.0' || typeof method !== 'string' || method.length > 64)
        throw new ProtocolError(ErrorCode.InvalidRequest, 'not a JSON-RPC 2.0 request');
      if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params)))
        throw new ProtocolError(ErrorCode.InvalidParams, 'params must be an object');
      if (method === 'hello') return reply({ result: this.#hello(connection, params ?? {}) });
      if (!connection.negotiated) throw new ProtocolError(ErrorCode.NotNegotiated, 'call hello first');
      const entry = this.#methods.get(method);
      const capability = entry?.capability ?? method.split('.')[0];
      if (!connection.negotiated.has(capability))
        throw new ProtocolError(ErrorCode.CapabilityMissing, `capability "${capability}" not negotiated`);
      if (!entry) throw new ProtocolError(ErrorCode.MethodNotFound, `unknown method ${method}`);
      reply({ result: (await entry.fn(params ?? {}, { window: connection.window })) ?? null });
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : ErrorCode.Internal;
      reply({ error: { code, message: error.message, data: error.data } });
    }
  }

  #hello(connection, { version, capabilities, window }) {
    if (version !== PROTOCOL_VERSION)
      throw new ProtocolError(ErrorCode.VersionMismatch, `server speaks protocol ${PROTOCOL_VERSION}`, { version: PROTOCOL_VERSION });
    if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.some((c) => typeof c !== 'string')))
      throw new ProtocolError(ErrorCode.InvalidParams, 'capabilities must be a list of names');
    if (window !== undefined) {
      if (!isWindowId(window)) throw ProtocolError.fromReason('invalid_params', 'window must be a positive integer');
      const mayBind = window === connection.window || !connection.allow || connection.allow.has('windows');
      if (!mayBind) throw ProtocolError.fromReason('denied_by_policy', 'this connection is bound to its own window');
      if (!this.#windowExists(window)) throw ProtocolError.fromReason('invalid_params', 'no such window');
      connection.window = window;
    }
    const wanted = capabilities?.length ? capabilities : [...this.#capabilities].filter((c) => !this.#optIn.has(c));
    connection.negotiated = new Set(wanted.filter((c) => this.#capabilities.has(c) && (!connection.allow || connection.allow.has(c))));
    return { version: PROTOCOL_VERSION, capabilities: [...connection.negotiated], window: connection.window };
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

  // `window`: bind to that window instead of the one the server chose.
  async hello(capabilities = [], { window } = {}) {
    const result = await this.request('hello', { version: PROTOCOL_VERSION, capabilities, ...(window !== undefined ? { window } : {}) });
    this.capabilities = result.capabilities;
    this.window = result.window ?? 1;
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
