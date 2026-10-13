// The profile service: one engine per profile, in the role "profile" (see
// engine/link/Link.h). It owns the profile's files, cookies, storage,
// IndexedDB, history and downloads, and the only connection to the relay; it
// shows no page. Content engines in this document join it through links: a
// MessagePort each way and a SharedArrayBuffer for the calls a content engine
// waits on. Content engines get no relay address and no files.
//
// One service per profile per document: views of the same profile attach to
// the one that runs (ProfileService.acquire), and its Web Lock keeps other
// documents off the profile's files.
import { EngineRuntime } from './runtime.js';

// Room for a waiting call's chunk; longer requests and replies cross in
// several chunks.
export const LINK_BUFFER_BYTES = 64 + 1024 * 1024;
const CLOSED = 3;

export class ProfileService extends EventTarget {
  static #open = new Map();

  // The running service for `profile` in this document, or a new one. Each
  // acquire is paired with a release(); the last release stops it.
  // Ephemeral services are never shared.
  static acquire(options) {
    const key = options.ephemeral ? null : `profile:${options.profile ?? 'default'}`;
    let service = key ? ProfileService.#open.get(key) : null;
    if (!service || service.stopped) {
      service = new ProfileService(options);
      if (key) {
        ProfileService.#open.set(key, service);
        service.#key = key;
      }
    }
    service.#users++;
    return service;
  }

  #options;
  #runtime = null;
  #links = new Map();
  #nextLink = 1;
  #users = 0;
  #key = null;
  #unlock = null;
  #started = null;
  #restarts = 0;
  stopped = false;
  // What the service reported at start: {persistent}.
  info = null;

  // {engineUrl, relayUrl, profile, fresh, ephemeral, preferences, debug,
  // maxMemoryMB, restart (default true: a crashed service starts again)}
  constructor(options) {
    super();
    this.#options = { restart: true, ...options };
  }

  get profile() { return this.#options.ephemeral ? null : (this.#options.profile ?? 'default'); }
  get ephemeral() { return !!this.#options.ephemeral; }
  get runtime() { return this.#runtime; }
  get restarts() { return this.#restarts; }

  start() {
    return this.#started ??= this.#start();
  }

  async #start() {
    if (!this.ephemeral && navigator.locks) {
      // The profile's files are open by one service at a time; a second
      // document would get read-only handles.
      const acquired = await new Promise((resolve) => navigator.locks.request(`inception-profile:${this.profile}`, { ifAvailable: true }, (lock) => {
        if (!lock) return resolve(false);
        return new Promise((release) => {
          this.#unlock = release;
          resolve(true);
        });
      }));
      if (!acquired) throw new Error(`The profile "${this.profile}" is already open in another tab or window. Close it there, or open this page with a different profile.`);
    }
    navigator.storage?.persist?.().catch(() => {});
    await this.#launch(this.#options.fresh === true);
    return this.info;
  }

  async #launch(fresh) {
    const options = this.#options;
    const runtime = new EngineRuntime({ engineUrl: options.engineUrl, relayUrl: options.relayUrl, maxMemoryMB: options.maxMemoryMB });
    this.#runtime = runtime;
    const ready = new Promise((resolve, reject) => {
      runtime.addEventListener('ready', (e) => resolve(e.detail), { once: true });
      runtime.addEventListener('crash', (e) => reject(new Error(`the profile service crashed while starting: ${e.detail.message}`)), { once: true });
    });
    await runtime.start();
    runtime.send('init', {
      role: 'profile',
      profile: options.profile ?? 'default',
      freshProfile: fresh,
      ephemeral: !!options.ephemeral,
      wispUrl: options.relayUrl,
      preferences: options.preferences ?? {},
      debug: !!options.debug,
    });
    this.info = await ready;
    runtime.addEventListener('crash', (e) => this.#crashed(runtime, e.detail));
    runtime.onEngineEvent = (name, data) => this.dispatchEvent(new CustomEvent('engineevent', { detail: { name, data } }));
  }

  // Joins a content engine (an EngineRuntime) to the service; returns the
  // link's id. `onClosed(reason)` hears when the link goes away.
  connect(content, { onClosed } = {}) {
    if (this.stopped) throw new Error('the profile service is stopped');
    const id = this.#nextLink++;
    const buffer = new SharedArrayBuffer(LINK_BUFFER_BYTES);
    const { port1, port2 } = new MessageChannel();
    this.#runtime.postToEngine({ inceptionLink: { id, port: port1, buffer, serviceEnd: true } }, [port1]);
    content.postToEngine({ inceptionLink: { id, port: port2, buffer, serviceEnd: false } }, [port2]);
    this.#links.set(id, { content, buffer, onClosed });
    return id;
  }

  // The content engine of link `id` is gone (closed or crashed).
  disconnect(id) {
    const link = this.#links.get(id);
    if (!link) return;
    this.#links.delete(id);
    this.#wake(link);
    this.#runtime?.postToEngine({ inceptionLinkClosed: id });
  }

  // A content engine waiting on the service must not wait forever.
  #wake(link) {
    const control = new Int32Array(link.buffer, 0, 4);
    Atomics.store(control, 0, CLOSED);
    Atomics.notify(control, 0);
  }

  // Sends a command to the service engine itself (history, downloads).
  send(command, args) {
    this.#runtime?.send(command, args);
  }

  async #crashed(runtime, crash) {
    if (runtime !== this.#runtime || this.stopped) return;
    const links = [...this.#links.entries()];
    this.#links.clear();
    for (const [id, link] of links) {
      this.#wake(link);
      link.content.postToEngine({ inceptionLinkClosed: id });
    }
    // Its threads still hold the profile's file handles.
    runtime.terminate();
    this.#runtime = null;
    this.dispatchEvent(new CustomEvent('crash', { detail: crash }));
    for (const [, link] of links) link.onClosed?.('crash');
    if (!this.#options.restart) return;
    try {
      await this.#relaunch();
      this.#restarts++;
      this.dispatchEvent(new CustomEvent('restart', { detail: { restarts: this.#restarts } }));
    } catch (error) {
      this.dispatchEvent(new CustomEvent('failed', { detail: { reason: String(error?.message ?? error) } }));
    }
  }

  // The new service opens the same files; a terminated worker's access
  // handles are released shortly after, so opening is retried briefly.
  async #relaunch() {
    let lastError;
    for (const delay of [0, 100, 300, 1000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await this.#launch(false);
        return;
      } catch (error) {
        lastError = error;
        this.#runtime?.terminate();
        this.#runtime = null;
      }
    }
    throw lastError;
  }

  release() {
    if (--this.#users > 0) return;
    this.stop();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const [id, link] of this.#links) {
      this.#wake(link);
      link.content.postToEngine({ inceptionLinkClosed: id });
    }
    this.#links.clear();
    this.#runtime?.terminate();
    this.#runtime = null;
    this.#unlock?.();
    if (this.#key && ProfileService.#open.get(this.#key) === this) ProfileService.#open.delete(this.#key);
  }
}
