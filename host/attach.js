// Documents that share a profile. One document holds the profile's lock and
// hosts it: the engine, the profile service and every window run there. Another
// document of the same site (a second tab, a popup) cannot open the profile's
// files, so it attaches: it asks the host for windows, shows them with the
// display channel (host/display.js) and drives them over the protocol
// (host/protocol.js), as if they were its own.
//
//   AttachHost      the host's side: accepts clients, opens windows for them,
//                   closes those of a client that goes away.
//   ProfileConnection / connectProfile()
//                   a client's side: finds the host, asks for windows
//                   (RemoteWindow) and follows the profile when its host goes
//                   away: the next document to take the lock becomes the host,
//                   and every client reopens its windows there.
//
// Two ways to find the host. The opener route: a popup, or an embedded frame, of
// the host document reaches it with postMessage (same-origin pages that open
// each other keep that link, so no shared worker is needed). The broker route:
// a shared worker (host/broker.js) hands a MessagePort from the client to the
// host, whichever document that is now. Locks (host/profile-lock.js) say who is
// alive; neither route polls.
//
// The control channel between a client and the host is a MessagePort. Client to host:
//   {type: 'open', key, width, height, deviceScaleFactor, url, frames}
//   {type: 'close', key}
//   {type: 'bye'}
// host to client:
//   {type: 'welcome', version, host, profile}
//   {type: 'opened', key, window, url, tabs, activeTab, popup?, opener?, userGesture?} + [display, protocol]
//   {type: 'failed', key, reason}
//   {type: 'event', key, name, detail}      tab events, popupblocked
//   {type: 'closed', key}                   the window is gone
//   {type: 'crash', key, reason, kind?}     its engine crashed
// Everything on the channel is untrusted by the side that reads it.

import { ProtocolClient, ProtocolError, createPostMessageTransport } from './protocol.js';
import { createDisplay } from './display.js';
import { clientLockName, heldLocks, hostLockName, tryLock, whenFree } from './profile-lock.js';

export const ATTACH_VERSION = 1;

// Events the engine reports that a view re-dispatches (see host/inception-view.js).
export const VIEW_EVENTS = ['security.state', 'security.certificateError', 'navigate', 'title', 'loading', 'popup', 'console', 'crash', 'cursor', 'navigation.state', 'find.result', 'zoom', 'contextmenu'];
export const DOM_EVENT_NAMES = { 'security.state': 'securitystate', 'security.certificateError': 'certificateerror', contextmenu: 'contextmenurequest', 'navigation.state': 'navigationstate', 'find.result': 'findresult', 'agent.action': 'agentaction', 'agent.blocked': 'agentblocked' };
// What an attached client may negotiate with its window's protocol server.
export const ATTACH_CAPABILITIES = ['view', 'find', 'history', 'observe'];
// Window events the host forwards on the control channel (the protocol does
// not carry them).
const FORWARDED_EVENTS = new Set(['tabcreated', 'tabupdated', 'tabactivated', 'tabclosed', 'popupblocked']);

const MAX_WINDOWS_PER_CLIENT = 32;
const MAX_CLIENTS = 64;
const MAX_URL_LENGTH = 8192;
const WELCOME_TIMEOUT_MS = 60_000;
const OPENER_TIMEOUT_MS = 800;
const KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const ID = /^[A-Za-z0-9_.-]{1,128}$/;

export class AttachUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AttachUnavailableError';
  }
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const dimension = (value) => Number.isFinite(value) && value >= 1 && value <= 16384;

// A message from a client, normalized, or null when it must be dropped.
export function validateClientMessage(message) {
  if (!isObject(message) || typeof message.type !== 'string') return null;
  switch (message.type) {
  case 'open': {
    if (typeof message.key !== 'string' || !KEY.test(message.key)) return null;
    const { width = 800, height = 600, deviceScaleFactor = 1, url = '', frames = 'auto' } = message;
    if (!dimension(width) || !dimension(height) || !(deviceScaleFactor > 0 && deviceScaleFactor <= 8)) return null;
    if (typeof url !== 'string' || url.length > MAX_URL_LENGTH || !['auto', 'bitmap', 'pixels'].includes(frames)) return null;
    return { type: 'open', key: message.key, width: Math.round(width), height: Math.round(height), deviceScaleFactor, url, frames };
  }
  case 'close':
    return typeof message.key === 'string' && KEY.test(message.key) ? { type: 'close', key: message.key } : null;
  case 'bye':
    return { type: 'bye' };
  default:
    return null;
  }
}

// What a client asks of a host in the hand-off: {version, id}, or null.
export function validateRequest(request) {
  if (!isObject(request) || request.version !== ATTACH_VERSION || typeof request.id !== 'string' || !ID.test(request.id)) return null;
  return { version: ATTACH_VERSION, id: request.id };
}

// A message from the host, normalized, or null. `ports` are what came with it.
export function validateHostMessage(message, ports = []) {
  if (!isObject(message) || typeof message.type !== 'string') return null;
  const key = typeof message.key === 'string' && KEY.test(message.key) ? message.key : null;
  switch (message.type) {
  case 'welcome':
    return message.version === ATTACH_VERSION && typeof message.host === 'string' && ID.test(message.host) ? { type: 'welcome', host: message.host } : null;
  case 'opened': {
    if (!key || !Number.isInteger(message.window) || message.window < 1 || ports.length < 2) return null;
    const tabs = Array.isArray(message.tabs) ? message.tabs.filter((tab) => isObject(tab) && Number.isInteger(tab.id)).slice(0, 256).map((tab) => ({
      id: tab.id, url: String(tab.url ?? ''), title: String(tab.title ?? ''), loading: !!tab.loading, canGoBack: !!tab.canGoBack, canGoForward: !!tab.canGoForward, audible: !!tab.audible, icons: Array.isArray(tab.icons) ? tab.icons.slice(0, 16) : [],
    })) : [];
    return {
      type: 'opened', key, window: message.window, url: String(message.url ?? ''), tabs, activeTab: Number.isInteger(message.activeTab) ? message.activeTab : 0,
      popup: !!message.popup, opener: typeof message.opener === 'string' && KEY.test(message.opener) ? message.opener : null, userGesture: !!message.userGesture,
    };
  }
  case 'failed':
    return key ? { type: 'failed', key, reason: String(message.reason ?? 'the host could not open the window').slice(0, 500) } : null;
  case 'event': {
    if (!key || !FORWARDED_EVENTS.has(message.name) || !isObject(message.detail)) return null;
    return { type: 'event', key, name: message.name, detail: message.detail };
  }
  case 'closed':
    return key ? { type: 'closed', key } : null;
  case 'crash':
    return key ? { type: 'crash', key, reason: String(message.reason ?? '').slice(0, 2000), ...(typeof message.kind === 'string' ? { kind: message.kind.slice(0, 64) } : {}) } : null;
  default:
    return null;
  }
}

// The broker's address: next to this module unless the embedder says where
// else the site serves it (a worker script is identified by its URL, so
// documents that reach this module through different paths must agree).
const brokerAddress = (url) => url ?? new URL('./broker.js', import.meta.url);

// A shared worker port to the broker. `onRestart` runs when the broker started
// over (see host/broker.js): the owner then says again what it is.
function openBroker(url, onRestart) {
  const worker = new SharedWorker(brokerAddress(url), { name: 'inception-broker' });
  let ready = 0;
  worker.port.addEventListener('message', (event) => {
    if (event.data?.type === 'ready' && ++ready > 1) onRestart();
  });
  worker.port.start();
  return worker;
}

const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

// An event detail that survives structured cloning, or {}.
function plain(detail) {
  try {
    return JSON.parse(JSON.stringify(detail ?? {}));
  } catch {
    return {};
  }
}

// --- the host ----------------------------------------------------------------

// Serves the clients of one profile from `view` (an InceptionView that holds
// the profile). Created as soon as the document holds the profile lock
// (AttachHost.claim) so that other documents can tell an attach-capable host
// from a page that merely holds the lock, and put to work with serve() once
// the view has started.
export class AttachHost {
  static async claim(profile) {
    const host = new AttachHost(profile);
    host.#lock = await tryLock(hostLockName(profile, host.id));
    return host;
  }

  id = randomId();
  #profile;
  #lock = null;
  #view = null;
  #policy = () => ({});
  #clients = new Map();
  #owner = new Map();
  #broker = null;
  #onMessage = null;
  #onWindowOpen = null;
  #brokerUrl;
  #nextPopup = 1;
  stopped = false;

  constructor(profile) {
    this.#profile = profile;
  }

  get clients() { return [...this.#clients.keys()]; }

  // Starts accepting clients: through the broker when this browser has shared
  // workers, and from the popups and frames of this document.
  serve(view, { policy, brokerUrl } = {}) {
    this.#view = view;
    if (policy) this.#policy = policy;
    this.#brokerUrl = brokerUrl;
    this.#onMessage = (event) => this.#fromWindow(event);
    addEventListener('message', this.#onMessage);
    this.#onWindowOpen = (event) => this.#popup(event);
    view.addEventListener('windowopen', this.#onWindowOpen);
    this.#joinBroker();
  }

  #joinBroker() {
    if (typeof SharedWorker === 'undefined') return;
    try {
      const worker = openBroker(this.#brokerUrl, () => this.#announce());
      this.#broker = worker;
      worker.port.addEventListener('message', (event) => {
        const message = event.data;
        if (message?.type === 'client' && event.ports[0]) this.#accept(event.ports[0], message.request);
        else if (message?.type === 'client-gone' && typeof message.from === 'string') this.#drop(message.from);
      });
      this.#announce();
    } catch (error) {
      console.warn('[attach] the broker could not start:', error);
    }
  }

  #announce() {
    if (this.stopped) return;
    this.#broker.port.postMessage({ type: 'join', profile: this.#profile, id: this.id, role: 'host' });
    this.#broker.port.postMessage({ type: 'host', profile: this.#profile, id: this.id });
  }

  // A popup or frame of this document asking to attach.
  #fromWindow(event) {
    const { data, source, ports } = event;
    if (event.origin !== location.origin || !isObject(data) || data.inceptionAttach !== 'hello' || data.profile !== this.#profile || !ports[0]) return;
    let child = false;
    try {
      child = !!source && (source.opener === window || source.parent === window);
    } catch {}
    if (!child) return;
    this.#accept(ports[0], data);
  }

  #accept(port, rawRequest) {
    const request = validateRequest(rawRequest);
    if (!request || this.stopped || !this.#view || (this.#clients.size >= MAX_CLIENTS && !this.#clients.has(request.id))) {
      port.close();
      return;
    }
    this.#drop(request.id);
    const client = { id: request.id, port, windows: new Map(), abort: new AbortController() };
    this.#clients.set(request.id, client);
    port.onmessage = (event) => this.#fromClient(client, event.data);
    port.start?.();
    port.postMessage({ type: 'welcome', version: ATTACH_VERSION, host: this.id, profile: this.#profile });
    // A client that is gone releases its lock.
    whenFree(clientLockName(this.#profile, request.id), client.abort.signal).then((gone) => gone && this.#drop(request.id, client));
  }

  #fromClient(client, raw) {
    const message = validateClientMessage(raw);
    if (!message) return;
    if (message.type === 'bye') return this.#drop(client.id, client);
    if (message.type === 'close') return client.windows.get(message.key)?.handle.close();
    this.#open(client, message);
  }

  async #open(client, { key, width, height, deviceScaleFactor, url, frames }) {
    const fail = (reason) => client.port.postMessage({ type: 'failed', key, reason });
    if (client.windows.has(key) || client.windows.size >= MAX_WINDOWS_PER_CLIENT) return fail('too many windows, or the key is in use');
    client.windows.set(key, null);
    try {
      const handle = await this.#view.openWindow({ width, height, url, deviceScaleFactor });
      if (client.abort.signal.aborted || this.#clients.get(client.id) !== client) {
        handle.close();
        return;
      }
      this.#register(client, key, handle, { frames });
    } catch (error) {
      client.windows.delete(key);
      fail(String(error?.message ?? error));
    }
  }

  // Gives the client its window: the display channel, and a protocol
  // connection bound to the window and limited to what a client may do.
  #register(client, key, handle, { frames, popup = false, opener = null, userGesture = false }) {
    const display = this.#view.exportWindow(handle.id, { frames });
    const { port1, port2 } = new MessageChannel();
    handle.serve(createPostMessageTransport(port1), { capabilities: ATTACH_CAPABILITIES });
    const entry = { handle, listeners: [] };
    client.windows.set(key, entry);
    this.#owner.set(handle.id, { client, key });
    const post = (message) => client.port.postMessage(message);
    for (const name of FORWARDED_EVENTS) {
      const listener = (event) => post({ type: 'event', key, name, detail: plain(event.detail) });
      handle.addEventListener(name, listener);
      entry.listeners.push([name, listener]);
    }
    const onClose = () => {
      this.#owner.delete(handle.id);
      if (client.windows.get(key) === entry) client.windows.delete(key);
      post({ type: 'closed', key });
    };
    const onCrash = (event) => post({ type: 'crash', key, reason: String(event.detail?.reason ?? ''), ...(event.detail?.kind ? { kind: event.detail.kind } : {}) });
    handle.addEventListener('close', onClose, { once: true });
    handle.addEventListener('crash', onCrash);
    entry.listeners.push(['close', onClose], ['crash', onCrash]);
    client.port.postMessage({
      type: 'opened', key, window: handle.id, url: handle.url, tabs: handle.tabs, activeTab: handle.activeTab,
      ...(popup ? { popup: true, opener, userGesture } : {}),
    }, [display, port2]);
  }

  // A page of a client's window opened a window of its own (policy.popups
  // 'window'): if the host's policy keeps it, the client gets it. The view
  // decides by the same rule right after this event.
  #popup(event) {
    const { window: handle, openerWindow, url, userGesture } = event.detail;
    const owner = this.#owner.get(openerWindow);
    if (!owner || !handle) return;
    const { client, key: opener } = owner;
    if (!(userGesture && this.#policy().newTabs !== 'block')) {
      client.port.postMessage({ type: 'event', key: opener, name: 'popupblocked', detail: { url: String(url ?? ''), userGesture: !!userGesture, window: handle.id } });
      return;
    }
    event.detail.allow();
    this.#register(client, `popup-${this.#nextPopup++}`, handle, { frames: 'auto', popup: true, opener, userGesture });
  }

  #drop(id, only = null) {
    const client = this.#clients.get(id);
    if (!client || (only && client !== only)) return;
    this.#clients.delete(id);
    client.abort.abort();
    for (const [, entry] of client.windows) {
      if (!entry) continue;
      for (const [name, listener] of entry.listeners) entry.handle.removeEventListener(name, listener);
      this.#owner.delete(entry.handle.id);
      try {
        entry.handle.close();
      } catch {}
    }
    client.windows.clear();
    client.port.close();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const id of [...this.#clients.keys()]) this.#drop(id);
    if (this.#onMessage) removeEventListener('message', this.#onMessage);
    this.#view?.removeEventListener('windowopen', this.#onWindowOpen);
    if (this.#broker) {
      this.#broker.port.postMessage({ type: 'leave', profile: this.#profile, id: this.id });
      this.#broker.port.close();
    }
    this.#lock?.release();
  }
}

// --- a client ----------------------------------------------------------------

// Whether another document of this profile can be reached from here, and how.
export async function hostPresent(profile) {
  const prefix = `inception-host:${profile}:`;
  for (let attempt = 0; attempt < 8; attempt++) {
    if ((await heldLocks(prefix)).length) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A window of the profile's host, shown and driven from this document. It is
// an EventTarget with the navigation, tab and state surface of a view
// (events: navigate, title, loading, navigationstate, tabcreated, ...; "close"
// when the window is gone; "hostlost" and "attached" around a failover). Call
// show(canvas) to draw it.
export class RemoteWindow extends EventTarget {
  #connection;
  #options;
  #client = null;
  #displayPort = null;
  #display = null;
  #canvas = null;
  #showOptions = null;
  #attached = null;
  #tabs = new Map();
  #activeTab = 0;
  closed = false;
  // The window's id on the host, 0 while it has none (the host is gone).
  id = 0;
  state = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, zoom: 1 };
  security = null;
  // Opened by a page of another window rather than by this document.
  popup = false;
  opener = null;

  constructor(connection, key, options) {
    super();
    this.#connection = connection;
    this.key = key;
    this.#options = options;
    this.state.url = options.url ?? '';
    this.#reset();
  }

  #resolveAttached = null;
  #rejectAttached = null;

  #reset() {
    this.#attached = new Promise((resolve, reject) => {
      this.#resolveAttached = resolve;
      this.#rejectAttached = reject;
    });
    // A request waiting for the window must not become an unhandled rejection
    // if nobody asks.
    this.#attached.catch(() => {});
  }

  get options() { return this.#options; }
  get url() { return this.state.url; }
  get title() { return this.state.title; }
  get loading() { return this.state.loading; }
  get canGoBack() { return this.state.canGoBack; }
  get canGoForward() { return this.state.canGoForward; }
  get securityState() { return this.security; }
  get tabs() { return [...this.#tabs.values()].map((tab) => ({ ...tab, active: tab.id === this.#activeTab })); }
  get activeTab() { return this.#activeTab; }
  // Resolves once the window is open on the host (again, after a failover).
  get ready() { return this.#attached; }
  get display() { return this.#display; }

  // Called by the connection when the host opened the window.
  async _attach(message, [displayPort, protocolPort]) {
    this.id = message.window;
    this.popup = message.popup;
    this.opener = message.opener;
    this.#tabs = new Map(message.tabs.map((tab) => [tab.id, tab]));
    this.#activeTab = message.activeTab;
    const client = new ProtocolClient(createPostMessageTransport(protocolPort));
    this.#client = client;
    for (const name of VIEW_EVENTS) {
      client.addEventListener(name, (event) => {
        this.#track(name, event.detail);
        this.dispatchEvent(new CustomEvent(DOM_EVENT_NAMES[name] ?? name, { detail: event.detail }));
      });
    }
    this.#displayPort = displayPort;
    try {
      await client.hello(ATTACH_CAPABILITIES);
    } catch (error) {
      this.#rejectAttached(error);
      return;
    }
    if (this.#canvas) this.#drawOn(this.#canvas, this.#showOptions);
    this.#resolveAttached();
    this.dispatchEvent(new CustomEvent('attached', { detail: { window: this.id } }));
  }

  #track(name, detail) {
    if (name === 'navigate') this.state.url = detail.url;
    if (name === 'title') this.state.title = detail.title;
    if (name === 'loading') this.state.loading = detail.loading;
    if (name === 'navigation.state') {
      const { window, ...state } = detail;
      Object.assign(this.state, state);
    }
    if (name === 'zoom') this.state.zoom = detail.factor;
    if (name === 'security.state') this.security = Object.freeze({ ...detail });
  }

  // A forwarded window event (a tab appeared, a popup was blocked).
  _event(name, detail) {
    const id = detail.tab;
    if (name === 'tabcreated') this.#tabs.set(id, { id, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, audible: false, icons: [], ...(detail.opener ? { opener: detail.opener } : {}) });
    else if (name === 'tabupdated') {
      const { tab, ...changes } = detail;
      Object.assign(this.#tabs.get(id) ?? {}, changes);
    } else if (name === 'tabactivated') this.#activeTab = id;
    else if (name === 'tabclosed') this.#tabs.delete(id);
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  // The host went away: the window waits for the next one.
  _detach() {
    this.#display?.close(false);
    this.#display = null;
    // What it asked the host that went away is not coming back.
    this.#client?.close?.(ProtocolError.fromReason('not_ready', "the profile's host went away"));
    this.#client = null;
    this.#displayPort?.close();
    this.#displayPort = null;
    this.id = 0;
    this.#reset();
    this.dispatchEvent(new CustomEvent('hostlost'));
  }

  _closed(reason) {
    if (this.closed) return;
    this.closed = true;
    this.#client?.close?.(ProtocolError.fromReason('not_ready', reason ?? 'the window is closed'));
    this.#display?.close(false);
    this.#display = null;
    this.#rejectAttached(new Error(reason ?? 'the window is closed'));
    this.dispatchEvent(new CustomEvent('close', { detail: { window: this.id, reason } }));
  }

  _crashed(detail) {
    this.dispatchEvent(new CustomEvent('crash', { detail }));
  }

  // Draws the window on `canvas` and sends it the person's input.
  // `options`: see createDisplay (host/display.js).
  show(canvas, options = {}) {
    this.#canvas = canvas;
    this.#showOptions = options;
    if (this.#displayPort) this.#drawOn(canvas, options);
  }

  #drawOn(canvas, options) {
    this.#display?.close(false);
    this.#display = createDisplay(canvas, this.#displayPort, options);
    this.#displayPort = null;
  }

  // The window stops being drawn; it stays open on the host.
  hide() {
    this.#canvas = null;
    this.#display?.close();
    this.#display = null;
  }

  async request(method, params) {
    await this.#attached;
    return this.#client.request(method, params);
  }

  navigate(url) { return this.request('view.navigate', { url }); }
  back() { return this.request('view.back'); }
  forward() { return this.request('view.forward'); }
  reload({ bypassCache = false } = {}) { return this.request('view.reload', { bypassCache }); }
  stop() { return this.request('view.stop'); }
  find(text, { backwards = false, caseSensitive = false } = {}) { return this.request('view.find', { text, backwards, caseSensitive }); }
  findClear() { return this.request('view.findClear'); }
  zoom(factor) { return this.request('view.zoom', { factor }); }
  history(options = {}) { return this.request('history.query', options); }
  deleteHistory(range = {}) { return this.request('history.delete', range); }
  createTab(url = '', { activate = true } = {}) { return this.request('view.createTab', { url: String(url), activate }); }
  activateTab(id) { return this.request('view.activateTab', { tab: id }); }
  closeTab(id) { return this.request('view.closeTab', { tab: id }); }

  // Closes the window on the host.
  close() {
    this.#connection._closeWindow(this);
  }
}

// This document's attachment to a profile whose host is another document.
export class ProfileConnection extends EventTarget {
  #profile;
  #id = randomId();
  #windows = new Map();
  #control = null;
  #hostId = null;
  #clientLock = null;
  #worker = null;
  #abort = new AbortController();
  #nextKey = 1;
  #hostWatch = null;
  #brokerUrl;
  #resend = null;
  state = 'new';

  constructor(profile) {
    super();
    this.#profile = profile;
  }

  get profile() { return this.#profile; }
  get id() { return this.#id; }
  get hostId() { return this.#hostId; }
  get windows() { return [...this.#windows.values()]; }

  // Finds the host. `via`: the routes to try, in order. `brokerUrl`: where
  // the site serves host/broker.js, if not next to this module.
  async connect({ via = ['opener', 'broker'], brokerUrl } = {}) {
    this.#brokerUrl = brokerUrl;
    this.#clientLock = await tryLock(clientLockName(this.#profile, this.#id));
    const problems = [];
    for (const route of via) {
      try {
        const control = route === 'opener' ? await this.#viaOpener() : await this.#viaBroker(true);
        if (control) {
          this.#adopt(control);
          return this;
        }
      } catch (error) {
        problems.push(error);
      }
    }
    this.close();
    throw problems.find((error) => error instanceof AttachUnavailableError) ?? problems[0] ?? new AttachUnavailableError('This profile is open in another tab and that tab cannot be reached from here.');
  }

  // Resolves with the control port once a host answers.
  #hello(port, timeout) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = (value, error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      port.onmessage = (event) => {
        const message = validateHostMessage(event.data);
        if (message?.type !== 'welcome') return;
        this.#hostId = message.host;
        done(port);
      };
      port.start?.();
      if (timeout) timer = setTimeout(() => {
        port.close();
        done(null, new AttachUnavailableError('The profile\'s other tab did not answer.'));
      }, timeout);
      this.#abort.signal.addEventListener('abort', () => done(null, new Error('closed')), { once: true });
    });
  }

  async #viaOpener() {
    const targets = [];
    try {
      if (window.opener && !window.opener.closed) targets.push(window.opener);
      if (window.parent !== window) targets.push(window.parent);
    } catch {}
    for (const target of targets) {
      const { port1, port2 } = new MessageChannel();
      try {
        target.postMessage({ inceptionAttach: 'hello', profile: this.#profile, id: this.#id, version: ATTACH_VERSION }, location.origin, [port2]);
      } catch {
        continue;
      }
      try {
        return await this.#hello(port1, OPENER_TIMEOUT_MS);
      } catch {}
    }
    return null;
  }

  #openBroker() {
    if (typeof SharedWorker === 'undefined')
      throw new AttachUnavailableError('This profile is open in another tab, and attaching to it needs SharedWorker, which this browser does not provide here. Close the other tab, or open this page with a different profile.');
    if (this.#worker) return this.#worker;
    let worker;
    try {
      worker = openBroker(this.#brokerUrl, () => {
        worker.port.postMessage({ type: 'join', profile: this.#profile, id: this.#id, role: 'client' });
        // Asking for a host that has not answered yet: the broker forgot.
        this.#resend?.();
      });
    } catch (error) {
      throw new AttachUnavailableError(`This profile is open in another tab, and the shared worker that connects tabs could not start (${error?.message ?? error}).`);
    }
    worker.port.postMessage({ type: 'join', profile: this.#profile, id: this.#id, role: 'client' });
    worker.port.addEventListener('message', (event) => {
      const message = event.data;
      if (message?.type === 'host-lost' && message.id === this.#hostId) this.#hostLost();
    });
    this.#worker = worker;
    return worker;
  }

  // Asks the broker for the host. `limited`: give up after a while (the first
  // attach); a reconnect waits for the next host as long as it takes.
  async #viaBroker(limited) {
    const worker = this.#openBroker();
    const attempts = [];
    let settle;
    const answered = new Promise((resolve) => { settle = resolve; });
    const ask = () => {
      const { port1, port2 } = new MessageChannel();
      attempts.push(port1);
      worker.port.postMessage({ type: 'connect', profile: this.#profile, id: this.#id, request: { version: ATTACH_VERSION, id: this.#id } }, [port2]);
      const attempt = this.#hello(port1, limited ? WELCOME_TIMEOUT_MS : 0);
      attempt.then(settle, () => {});
      return attempt;
    };
    // The broker started over before a host answered: ask it again. Whichever
    // request the host answers first wins.
    this.#resend = ask;
    try {
      const control = await Promise.race([ask(), answered]);
      for (const port of attempts) if (port !== control) port.close();
      return control;
    } finally {
      this.#resend = null;
    }
  }

  #adopt(control) {
    this.#control = control;
    this.state = 'attached';
    control.onmessage = (event) => this.#fromHost(event.data, event.ports);
    // The host's lock is released when its document goes away.
    this.#hostWatch = new AbortController();
    whenFree(hostLockName(this.#profile, this.#hostId), this.#hostWatch.signal).then((gone) => gone && this.#hostLost());
  }

  #fromHost(raw, ports) {
    const message = validateHostMessage(raw, ports);
    if (!message) return;
    if (message.type === 'opened') {
      const existing = this.#windows.get(message.key);
      if (existing) return existing._attach(message, ports);
      if (!message.popup) {
        for (const port of ports) port.close();
        return;
      }
      const popup = new RemoteWindow(this, message.key, { url: message.url });
      this.#windows.set(message.key, popup);
      popup._attach(message, ports).then(() => {
        const opener = this.#windows.get(message.opener);
        const event = new CustomEvent('windowopen', { cancelable: true, detail: { window: popup, opener: message.opener, url: message.url, userGesture: message.userGesture } });
        (opener ?? this).dispatchEvent(event);
        this.dispatchEvent(new CustomEvent('windowopen', { detail: event.detail }));
        if (event.defaultPrevented) popup.close();
      });
      return;
    }
    const target = this.#windows.get(message.key);
    if (!target) return;
    if (message.type === 'failed') {
      this.#windows.delete(message.key);
      target._closed(message.reason);
    } else if (message.type === 'event') target._event(message.name, message.detail);
    else if (message.type === 'closed') {
      this.#windows.delete(message.key);
      target._closed();
    } else if (message.type === 'crash') target._crashed({ reason: message.reason, ...(message.kind ? { kind: message.kind } : {}) });
  }

  // Opens a window on the host. Resolves with the RemoteWindow once it is
  // open. `key` names it across a failover (default: a counter).
  async open({ width = 800, height = 600, deviceScaleFactor = devicePixelRatio, url = '', frames = 'auto', key = `w${this.#nextKey++}` } = {}) {
    if (this.state === 'closed') throw new Error('the connection is closed');
    const options = { width, height, deviceScaleFactor, url, frames };
    const remote = new RemoteWindow(this, key, options);
    this.#windows.set(key, remote);
    this.#sendOpen(remote);
    await remote.ready;
    return remote;
  }

  #sendOpen(remote) {
    if (!this.#control) return;
    const { width, height, deviceScaleFactor, frames } = remote.options;
    this.#control.postMessage({ type: 'open', key: remote.key, width, height, deviceScaleFactor, url: remote.url || remote.options.url, frames });
  }

  _closeWindow(remote) {
    this.#windows.delete(remote.key);
    this.#control?.postMessage({ type: 'close', key: remote.key });
    remote._closed();
  }

  // The host went away. Windows wait; the next host gets them back.
  async #hostLost() {
    if (this.state !== 'attached') return;
    this.state = 'lost';
    this.#hostWatch?.abort();
    this.#control?.close();
    this.#control = null;
    for (const remote of this.#windows.values()) {
      // Windows a page opened were children of windows that are gone.
      if (remote.popup) remote._closed('the profile\'s host went away');
      else remote._detach();
    }
    for (const [key, remote] of [...this.#windows]) if (remote.closed) this.#windows.delete(key);
    this.dispatchEvent(new CustomEvent('hostlost'));
    try {
      // A client that found its host through its opener has no broker yet.
      this.#openBroker();
    } catch {
      this.close('the profile\'s host went away and no shared worker can find the next one');
      return;
    }
    try {
      const control = await this.#viaBroker(false);
      if (this.state === 'closed') return;
      this.#adopt(control);
      for (const remote of this.#windows.values()) this.#sendOpen(remote);
      this.dispatchEvent(new CustomEvent('attached', { detail: { host: this.#hostId } }));
    } catch {}
  }

  close(reason) {
    if (this.state === 'closed') return;
    const attached = this.state === 'attached';
    this.state = 'closed';
    if (attached) this.#control?.postMessage({ type: 'bye' });
    this.#abort.abort();
    this.#hostWatch?.abort();
    this.#control?.close();
    this.#control = null;
    if (this.#worker) {
      this.#worker.port.postMessage({ type: 'leave', profile: this.#profile, id: this.#id });
      this.#worker.port.close();
    }
    for (const remote of this.#windows.values()) remote._closed(reason);
    this.#windows.clear();
    this.#clientLock?.release();
    this.dispatchEvent(new CustomEvent('close', { detail: { reason } }));
  }
}

// Attaches this document to the host of `profile`. Rejects with an
// AttachUnavailableError when no host can be reached.
export async function connectProfile(profile = 'default', options) {
  return new ProfileConnection(profile).connect(options);
}
