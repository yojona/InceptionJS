// The broker: a shared worker that introduces the documents of one site to the
// document that hosts their profile. It is pure JavaScript and holds no state
// of a profile; a shared worker is never cross-origin isolated, cannot share
// memory with the engine and cannot start workers in every browser, so it
// only hands MessagePorts from one document to another. After the
// introduction the documents talk to each other directly and the broker is out
// of the path.
//
// Messages from a document (on its port to the broker):
//   {type: 'join', profile, id, role}   role: 'host' | 'client'. The document
//                                       holds the Web Lock of its role (see
//                                       host/profile-lock.js) before it joins;
//                                       the broker forgets it when that lock
//                                       is released, which is how it learns a
//                                       document is gone.
//   {type: 'host', profile, id}         the host is ready for clients
//   {type: 'connect', profile, id, request} + [port]
//                                       a client wants the host; `port` is its
//                                       end of a new channel. Kept until a host
//                                       is ready, so a client that arrives or
//                                       reconnects while a host starts is not
//                                       lost.
//   {type: 'leave', profile, id}
//   {type: 'status', profile}           answered with {type: 'status', host,
//                                       clients, pending}
// Messages to a document:
//   {type: 'ready'}                     the document's port is connected
//   {type: 'joined', profile, host}     host: the id of the ready host, or null
//   {type: 'host', profile, id}         a host is ready (to clients)
//   {type: 'host-lost', profile, id}    the host went away (to clients)
//   {type: 'client', from, request} + [port]   (to the host)
//   {type: 'client-gone', from}                (to the host)

const profiles = new Map();

const entryOf = (name) => {
  let entry = profiles.get(name);
  if (!entry) {
    entry = { host: null, docs: new Map(), pending: [] };
    profiles.set(name, entry);
  }
  return entry;
};

const valid = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128;

const lockNames = {
  host: (profile, id) => `inception-host:${profile}:${id}`,
  client: (profile, id) => `inception-client:${profile}:${id}`,
};

function post(port, message, transfer = []) {
  try {
    port.postMessage(message, transfer);
  } catch {
    // The document is gone; its lock will say so.
  }
}

function forget(profile, id) {
  const entry = profiles.get(profile);
  const doc = entry?.docs.get(id);
  if (!doc) return;
  entry.docs.delete(id);
  doc.watch?.abort();
  if (entry.host?.id === id) {
    entry.host = null;
    for (const [, other] of entry.docs) {
      if (other.role === 'client') post(other.port, { type: 'host-lost', profile, id });
    }
  }
  if (doc.role === 'client') {
    entry.pending = entry.pending.filter((item) => item.from !== id);
    if (entry.host) post(entry.host.port, { type: 'client-gone', from: id });
  }
  if (!entry.docs.size && !entry.pending.length) profiles.delete(profile);
}

// Forgets the document when its lock is released. A document that never held
// the lock is forgotten at once: it did not follow the rules.
function watch(profile, doc) {
  if (!navigator.locks) return;
  doc.watch = new AbortController();
  navigator.locks.request(lockNames[doc.role](profile, doc.id), { signal: doc.watch.signal }, () => {
    forget(profile, doc.id);
  }).catch(() => {});
}

function deliver(entry, item) {
  post(entry.host.port, { type: 'client', from: item.from, request: item.request }, [item.port]);
}

function handle(port, message, ports) {
  if (!message || typeof message !== 'object' || !valid(message.profile)) return;
  route(port, message, ports);
  const entry = profiles.get(message.profile);
  if (entry && !entry.docs.size && !entry.pending.length) profiles.delete(message.profile);
}

function route(port, message, ports) {
  const { profile, id } = message;
  const entry = entryOf(profile);
  switch (message.type) {
  case 'join': {
    if (!valid(id) || (message.role !== 'host' && message.role !== 'client')) return;
    const existing = entry.docs.get(id);
    existing?.watch?.abort();
    const doc = { id, port, role: message.role, watch: null };
    entry.docs.set(id, doc);
    watch(profile, doc);
    post(port, { type: 'joined', profile, host: entry.host?.id ?? null });
    return;
  }
  case 'host': {
    const doc = entry.docs.get(id);
    if (!doc || doc.role !== 'host') return;
    entry.host = { id, port: doc.port };
    for (const [, other] of entry.docs) {
      if (other.role === 'client') post(other.port, { type: 'host', profile, id });
    }
    for (const item of entry.pending.splice(0)) deliver(entry, item);
    return;
  }
  case 'connect': {
    const doc = entry.docs.get(id);
    if (!doc || doc.role !== 'client' || !ports[0]) return;
    const item = { from: id, request: message.request, port: ports[0] };
    if (entry.host) deliver(entry, item);
    else entry.pending.push(item);
    return;
  }
  case 'leave':
    forget(profile, id);
    return;
  case 'status': {
    const clients = [];
    for (const [docId, doc] of entry.docs) if (doc.role === 'client') clients.push(docId);
    post(port, { type: 'status', profile, host: entry.host?.id ?? null, clients, pending: entry.pending.length });
    return;
  }
  }
}

// A browser may stop this worker when the document that started it closes and
// start it again for the documents still holding ports to it (WebKit does),
// with nothing remembered. "ready" tells a document each time its port is
// connected: the second one it hears means the broker started over, and it
// says again what it is (join, and for a host, host).
onconnect = (event) => {
  const port = event.ports[0];
  port.onmessage = (e) => handle(port, e.data, e.ports);
  post(port, { type: 'ready' });
};
