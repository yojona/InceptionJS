// Host side of Encrypted Media Extensions. The engine has no CDM; every EME
// object a page creates inside it is mirrored here on the host browser's real
// EME, and the MediaKeys are set on the host <video> that plays the page's
// media. The host CDM requests licenses and decrypts. License messages go back
// to the page, which sends them to its license server itself; this side only
// relays opaque bytes, size-limited.

const MAX_MESSAGE = 1024 * 1024;

const toBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const fromBase64 = (text) => {
  if (typeof text !== 'string' || text.length > MAX_MESSAGE * 1.4) throw new RangeError('EME message too large');
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
};

export class EncryptedMedia {
  #send;
  #accesses = new Map(); // keySystem -> [{configuration, access}]
  #keys = new Map(); // engine MediaKeys id -> Promise<MediaKeys>
  #sessions = new Map(); // engine session id -> {keys, native}

  constructor(send) {
    this.#send = send;
  }

  // The host MediaKeys mirroring engine MediaKeys `id`, or null.
  mediaKeys(id) {
    return this.#keys.get(id) ?? Promise.resolve(null);
  }

  handleEvent(name, data) {
    const handlers = {
      'eme.access': () => this.#access(data),
      'eme.createKeys': () => this.#createKeys(data),
      'eme.serverCertificate': () => this.#serverCertificate(data),
      'eme.generateRequest': () => this.#generateRequest(data),
      'eme.update': () => this.#update(data),
      'eme.load': () => this.#load(data),
      'eme.close': () => this.#close(data),
      'eme.remove': () => this.#remove(data),
      'eme.dropSession': () => { this.#sessions.get(data.session)?.native?.close().catch(() => {}); this.#sessions.delete(data.session); },
      'eme.dropKeys': () => this.#keys.delete(data.keys),
    };
    const handler = handlers[name];
    if (!handler) return false;
    const reply = handler();
    if (reply instanceof Promise && data.req !== undefined) {
      reply.then((result) => this.#send('eme.reply', { req: data.req, ok: true, ...result }), (error) => {
        console.warn(`[eme] ${name}:`, error);
        this.#send('eme.reply', { req: data.req, ok: false, error: String(error?.message ?? error) });
      });
    }
    return true;
  }

  async #access({ keySystem, configuration }) {
    const access = await navigator.requestMediaKeySystemAccess(keySystem, [configuration]);
    const granted = access.getConfiguration();
    const list = this.#accesses.get(keySystem) ?? [];
    list.push({ configuration: granted, access });
    this.#accesses.set(keySystem, list);
    return { configuration: granted };
  }

  // The engine created MediaKeys from a configuration the host granted.
  #createKeys({ keys, keySystem, configuration }) {
    const promise = (async () => {
      const known = (this.#accesses.get(keySystem) ?? []).find((entry) => JSON.stringify(entry.configuration) === JSON.stringify(configuration));
      const access = known?.access ?? await navigator.requestMediaKeySystemAccess(keySystem, [configuration]);
      return access.createMediaKeys();
    })();
    this.#keys.set(keys, promise);
    return promise.then(() => ({}));
  }

  async #serverCertificate({ keys, certificate }) {
    const mediaKeys = await this.mediaKeys(keys);
    if (!mediaKeys) throw new Error('no MediaKeys');
    await mediaKeys.setServerCertificate(fromBase64(certificate));
    return {};
  }

  async #nativeSession(keys, session, sessionType) {
    let entry = this.#sessions.get(session);
    if (entry) return entry.native;
    const mediaKeys = await this.mediaKeys(keys);
    if (!mediaKeys) throw new Error('no MediaKeys');
    const native = mediaKeys.createSession(sessionType);
    entry = { keys, native, first: null };
    this.#sessions.set(session, entry);
    native.addEventListener('message', (event) => {
      if (event.message.byteLength > MAX_MESSAGE) return;
      const message = { messageType: event.messageType, message: toBase64(event.message) };
      // The first message answers generateRequest; later ones are renewals.
      if (entry.first) {
        const resolve = entry.first;
        entry.first = null;
        return resolve(message);
      }
      this.#send('eme.message', { session, ...message });
    });
    native.addEventListener('keystatuseschange', () => this.#send('eme.keyStatuses', { session, statuses: this.#statuses(native) }));
    return native;
  }

  #statuses(native) {
    const statuses = [];
    native.keyStatuses.forEach((status, keyId) => statuses.push([toBase64(keyId), status]));
    return statuses;
  }

  async #generateRequest({ keys, session, sessionType, initDataType, initData }) {
    const native = await this.#nativeSession(keys, session, sessionType);
    const entry = this.#sessions.get(session);
    const first = new Promise((resolve) => { entry.first = resolve; });
    await native.generateRequest(initDataType, fromBase64(initData));
    const message = await first;
    return { sessionId: native.sessionId, ...message };
  }

  async #update({ session, response }) {
    const native = this.#sessions.get(session)?.native;
    if (!native) throw new Error('no session');
    await native.update(fromBase64(response));
    const expiration = Number.isFinite(native.expiration) ? native.expiration : null;
    return { statuses: this.#statuses(native), expiration, closed: false };
  }

  async #load({ keys, session, sessionType, sessionId }) {
    const native = await this.#nativeSession(keys, session, sessionType);
    const found = await native.load(sessionId);
    return { found, statuses: this.#statuses(native) };
  }

  async #close({ session }) {
    await this.#sessions.get(session)?.native?.close();
    return {};
  }

  async #remove({ session }) {
    const native = this.#sessions.get(session)?.native;
    if (!native) throw new Error('no session');
    await native.remove();
    return { statuses: this.#statuses(native) };
  }
}

export const encodeInitData = toBase64;
