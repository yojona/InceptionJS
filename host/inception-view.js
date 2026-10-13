import { writeClipboard } from './input.js';
import { answerDialog, chooseFiles } from './ui.js';
import { Preferences } from './preferences.js';
import { ENGINE_VERSION, defaultUserAgent } from './identity.js';
import { PROVENANCE_STYLE, Provenance } from './provenance.js';
import { MediaHost, probeMediaCapabilities } from './media.js';
import { probeOpfs } from './opfs.js';
import { EncryptedMedia } from './eme.js';
import { AudioHost } from './audio.js';
import { Modules } from './modules.js';
import { Downloads } from './downloads.js';
import { hostRules, resolvePolicy } from './policy.js';
import { EngineRuntime } from './runtime.js';
import { ProfileService } from './profile-service.js';
import { WasmTranslator } from './wasm-translator.js';
import { ProtocolClient, ProtocolError, ProtocolServer, createInPagePair } from './protocol.js';
import { AgentClient, AgentHost, registerAgentMethods } from './agent.js';
import { Display, serveDisplay } from './display.js';
import { ATTACH_DISPLAY, HostWindow, InceptionWindow } from './window.js';
import { AttachHost, AttachUnavailableError, DOM_EVENT_NAMES, ProfileConnection, VIEW_EVENTS, hostPresent } from './attach.js';
import { profileLockName, tryLock, waitLock } from './profile-lock.js';

export { AttachUnavailableError, connectProfile } from './attach.js';

// The attach host of each profile this document holds.
const attachHosts = new Map();

const config = { engineUrl: null, relayUrl: null, binaryenUrl: null, storage: null, policy: null, debug: false, agent: null, webglContexts: 0, modules: {}, isolation: 'shared', attach: true, brokerUrl: undefined };
const policy = () => resolvePolicy(config.policy);
let translator = null;

export const Inception = {
  // engineUrl: URL of inception-engine.js; relayUrl: the network relay (ws:// or
  // wss://); binaryenUrl: binaryen.js, loaded when a page first uses WebAssembly;
  // webglContexts: how many WebGL contexts pages may hold (default: derived
  // from the browser's renderer); modules: what pages get for geolocation and
  // notifications (host/modules.js); policy: what pages may do to the person's
  // browser, safe unless the embedder opts in (host/policy.js); debug: enable
  // the view's debugEvaluate, debugCommand and debugHeap (development only);
  // maxMemoryMB: how far a view's engine memory may grow (default 2048, 512
  // to 4096); agent: true or the agent options (host/agent.js) to offer the agent
  // namespace on every view, which is off otherwise. isolation: 'shared'
  // (default: one engine runs every window of a view, with the profile in it)
  // or 'window' (a profile service owns the profile, the network and the
  // files; each window opened with openWindow() gets an engine of its own,
  // with the popups its pages open; see host/profile-service.js). attach (default
  // true): a view whose profile another document of the site already holds
  // attaches to that document and shows a window of it, instead of failing; the
  // document that holds the profile accepts such views (host/attach.js). false
  // restores the error. brokerUrl: where the site serves host/broker.js, if not
  // next to the host modules (documents of one site must agree on it).
  configure(options) {
    const { wispUrl, ...rest } = options;
    // wispUrl: the earlier name of relayUrl, still accepted.
    Object.assign(config, wispUrl !== undefined && rest.relayUrl === undefined ? { relayUrl: wispUrl } : {}, rest);
  },
};

// User styles: CSS the embedder gives every page this view shows (its scrollbars, say),
// as a browser's user stylesheet. Set with Inception.configure({ userStyles }) or the
// view's `userStyles` property before it starts. Added to each document in a cascade
// layer, so any style of the page's own still wins over it.
const userStylesShim = (css) =>
  css
    ? `\n;(() => {\n  try {\n    const sheet = new CSSStyleSheet();\n    sheet.replaceSync(${JSON.stringify(`@layer inception-user {\n${css}\n}`)});\n    document.adoptedStyleSheets = [sheet, ...document.adoptedStyleSheets];\n  } catch {}\n})();\n`
    : '';

// WebGL contexts pages may hold unless the embedder says otherwise: browsers
// keep four per worker and lose the oldest past that, which is the engine's
// own (it is created first). Sent explicitly so engines built before this
// default (which allowed more off Chromium) keep it too.
const PAGE_WEBGL_CONTEXTS = 3;

// How long after the person's input a page may still write the clipboard.
const CLIPBOARD_GESTURE_MS = 2000;

// Events the engine reports that the view re-dispatches as DOM events (VIEW_EVENTS,
// under the names in DOM_EVENT_NAMES where the engine's would clash with the
// element's own DOM events).
// What the view's own client negotiates; remote clients get less (serve()).
const PROTOCOL_CAPABILITIES = ['view', 'history', 'find', 'observe', 'windows'];
const EVENT_CAPABILITY = { console: 'observe', 'find.result': 'find' };
// Events of the agent namespace (host/agent.js), re-dispatched the same way.
const AGENT_EVENTS = ['control', 'agent.action', 'agent.blocked'];
// Events of the windows capability, on the view.
const WINDOW_EVENTS = ['windows.created', 'windows.closed', 'windows.updated'];
const WINDOW_DOM_EVENTS = { 'windows.created': 'windowcreated', 'windows.closed': 'windowclosed', 'windows.updated': 'windowupdated' };
// Engine events a window's display draws.
const DISPLAY_EVENT_NAMES = new Set(['cursor', 'select.show', 'select.update', 'select.hide']);
// Numbers for content engines and history requests, unique in the document
// (several views may share one profile service).
let lastEngineNumber = 0;
let lastHistoryRequest = 0;

// One engine of a view and what lives next to it in this document: its
// runtime, encrypted media, audio and page modules, and the mapping between
// the window ids it allocates and the ones the view gives out. With
// isolation 'shared' there is one, and the ids are the engine's own.
class EngineSlot {
  constructor({ runtime, primary, allocate }) {
    this.runtime = runtime;
    this.primary = primary;
    this.number = ++lastEngineNumber;
    this.link = null;
    this.windows = new Map();
    this.locals = new Map();
    this.root = null;
    // Audio rings played by a display in another document, by ring id.
    this.remoteRings = new Map();
    this.closed = false;
    this.#allocate = allocate;
    const slot = this;
    // What a window record sends through: its window id becomes the
    // engine's own.
    this.adapter = {
      send: (command, args = {}) => runtime.send(command, Number.isInteger(args?.window) ? { ...args, window: slot.localOf(args.window) } : args),
      sendFile: (name, bytes) => runtime.sendFile(name, bytes),
      get crash() { return runtime.crash; },
    };
  }

  #allocate;

  // The view's id for a window of this engine.
  publicOf(local) {
    let id = this.windows.get(local);
    if (id === undefined) {
      id = this.#allocate(local);
      this.windows.set(local, id);
      this.locals.set(id, local);
    }
    return id;
  }

  localOf(id) {
    return this.locals.get(id) ?? (this.primary && id === 1 ? 1 : 0);
  }
}

// <inception-view src gpu="auto|on|off" muted media profile fresh-profile user-agent
//                 provenance-corner provenance="off" agent>
//
// A thin client: it speaks the protocol to a server bound to its own engine,
// exactly as a remote agent would. `serve(transport)` connects more clients.
export class InceptionView extends HTMLElement {
  static observedAttributes = ['src', 'provenance-corner', 'provenance', 'volume', 'muted'];

  /** CSS for every page this view shows (see userStylesShim); set before it starts. */
  userStyles = null;
  // The engine that shows window 1, and every engine of this view.
  #primary = null;
  #slots = [];
  #service = null;
  #nextWindow = 2;
  // The engines' events, window ids already the view's, from every engine.
  #events = new EventTarget();
  #downloads = null;
  #server = null;
  #client = null;
  #canvas;
  #mediaLayer;
  #textInput;
  #shadow;
  #display;
  #provenance;
  // Every window of this view's engine, by id; window 1 is the view itself.
  #windows = new Map();
  #windowHandles = new Map();
  #pendingWindows = [];
  #eme = null;
  #soundAllowed = false;
  #preferences = new Preferences((changed) => {
    for (const slot of this.#slots) slot.runtime.send('preferences', changed);
    this.#service?.send('preferences', changed);
  });
  #media = null;
  #audio = null;
  #volume = 1;
  #muted = false;
  #debugRequests = 0;
  // When the person last used this view (keys, pointer, copy); the system
  // clipboard is written only soon after (policy.clipboard 'user').
  #lastInput = -Infinity;
  #ready = null;
  #agentClient = new AgentClient(async (method, params) => {
    await this.ready;
    return this.#client.request(method, params);
  });
  // Window 1: the view's own page state, tabs and agent.
  #main;
  // An attached view (another document holds the profile): its window is a
  // RemoteWindow on that document, and everything below that needs an engine
  // here is unavailable.
  #remote = null;
  #connection = null;
  #standby = null;
  #attachHost = null;
  get #state() { return this.#remote ? this.#remote.state : this.#main.state; }
  get #tabs() { return this.#main.tabs; }
  get #agentHost() { return this.#main.agent; }

  constructor() {
    super();
    const view = this;
    const runtime = {
      send: (command, args) => view.#primary?.adapter.send(command, args),
      sendFile: (name, bytes) => view.#primary?.runtime.sendFile(name, bytes),
      get crash() { return view.#primary?.runtime.crash; },
    };
    this.#main = new HostWindow({ id: 1, runtime, target: this, policy });
    for (const type of ['keydown', 'pointerdown', 'copy', 'cut'])
      this.addEventListener(type, (event) => event.isTrusted && (this.#lastInput = performance.now()), { capture: true });
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host { display: block; position: relative; overflow: hidden; contain: strict; width: 800px; height: 600px; outline: none; }
      canvas, .media { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
      .media { overflow: hidden; pointer-events: none; }
      textarea { position: absolute; left: 0; top: 0; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; resize: none; pointer-events: none; }
      .message { position: absolute; inset: 0; z-index: 4; display: flex; align-items: center; justify-content: center; padding: 24px;
        text-align: center; font: 500 14px/1.5 system-ui, sans-serif; color: #333; background: #f6f6f7; }
      ${PROVENANCE_STYLE}
    </style><div class="media" part="media"></div><canvas part="screen"></canvas><textarea aria-label="Web content" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>`;
    this.#canvas = shadow.querySelector('canvas');
    this.#mediaLayer = shadow.querySelector('.media');
    this.#textInput = shadow.querySelector('textarea');
    this.#shadow = shadow;
    this.#windows.set(1, this.#main);
    this.#provenance = new Provenance(shadow, this, (hidden) => this.#provenanceHidden(hidden));
  }

  get url() { return this.#state.url; }
  get title() { return this.#state.title; }
  get loading() { return this.#state.loading; }
  get canGoBack() { return this.#state.canGoBack; }
  get canGoForward() { return this.#state.canGoForward; }
  get ready() { return this.#ready ??= this.#start(); }
  // The connection of the page shown, from the engine: {url, scheme, secure,
  // httpVersion?, certificate?: {subject, validFrom, validUntil, dnsNames,
  // verificationError}}, for the embedder's own address bar.
  get securityState() { return this.#remote ? this.#remote.security : this.#main.security; }

  // The id of the view's window on the document that runs the engine (1 on
  // the host itself; the host's own `windows` lists the rest).
  get windowId() { return this.#remote ? this.#remote.id : 1; }

  // 'host': this document holds the profile and runs the engine. 'client': the
  // profile is held by another document and this view shows a window of it.
  // null until the view has started.
  get role() { return this.#remote ? 'client' : this.#primary ? 'host' : null; }

  // Tabs share this view and its engine; one is shown (host/tabs.js).
  get tabs() { return this.#remote ? this.#remote.tabs : this.#tabs.list(); }
  get activeTab() { return this.#remote ? this.#remote.activeTab : this.#tabs.active; }
  async createTab(url = '', { activate = true } = {}) {
    await this.ready;
    if (this.#remote) await this.#remote.createTab(url, { activate });
    else this.#tabs.create(String(url), { activate });
  }
  async activateTab(id) {
    await this.ready;
    if (this.#remote) await this.#remote.activateTab(id);
    else this.#tabs.activate(id);
  }
  async closeTab(id) {
    await this.ready;
    if (this.#remote) await this.#remote.closeTab(id);
    else this.#tabs.close(id);
  }

  // See host/preferences.js. Setting merges: {colorScheme: 'dark'} keeps the
  // other fields; a field set to 'auto' follows the host again.
  get preferences() { return this.#preferences.settings; }
  set preferences(values) { this.#preferences.set(values); }

  // Master output level for everything this view plays (media and Web Audio),
  // on top of what the pages set themselves. Applies to sound already playing.
  get volume() { return this.#volume; }
  set volume(value) {
    this.#volume = Math.min(1, Math.max(0, Number(value) || 0));
    this.#applyLevel();
  }

  get muted() { return this.#muted; }
  set muted(value) {
    this.#muted = !!value;
    this.#applyLevel();
  }

  #mayWriteClipboard() {
    const { clipboard } = policy();
    return clipboard === true || (clipboard === 'user' && performance.now() - this.#lastInput < CLIPBOARD_GESTURE_MS);
  }

  #applyLevel() {
    this.#media?.setMaster({ volume: this.#volume, muted: this.#muted });
    for (const slot of this.#slots) slot.audio?.setLevel(this.#muted ? 0 : this.#volume);
    this.#remote?.display?.setLevel({ volume: this.#volume, muted: this.#muted });
  }

  // What needs an engine in this document does not exist in an attached view.
  #requireHost(what) {
    if (this.#remote) throw new Error(`${what} is not available in a view attached to a profile held by another tab`);
  }

  get #runtime() { return this.#primary?.runtime ?? null; }

  #isolation() {
    const value = this.getAttribute('isolation') ?? config.isolation;
    return value === 'window' ? 'window' : 'shared';
  }

  // Downloads and history are the profile service's when there is one.
  #profileSend(command, args = {}) {
    if (this.#service) this.#service.send(command, { ...args, link: this.#primary?.link ?? 0 });
    else this.#runtime?.send(command, args);
  }

  disconnectedCallback() {
    this.#provenance.stop();
  }

  // The embedding page hid the badge: the view does not show content unseen
  // by its provenance. The reason is shown in the view itself.
  #provenanceHidden(hidden) {
    let box = this.#shadow.querySelector('.tamper');
    if (hidden && !box) {
      box = document.createElement('div');
      box.className = 'message tamper';
      box.setAttribute('part', 'message');
      box.setAttribute('role', 'alert');
      box.textContent = 'InceptionJS: the page showing this view has hidden its notice of where the content comes from. The content is not shown while the notice is hidden.';
      this.#shadow.append(box);
    } else if (!hidden) {
      box?.remove();
    }
    this.dataset.provenance = hidden ? 'hidden' : 'shown';
    this.dispatchEvent(new CustomEvent('provenancetampered', { detail: { hidden } }));
  }

  connectedCallback() {
    this.#provenance.start();
    // Not in the constructor: an element created with document.createElement
    // must not gain attributes there.
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
    // Deferred so a page can define the element and configure it in the same
    // script, in either order.
    queueMicrotask(() => this.ready.catch((error) => {
      const reason = String(error?.message ?? error);
      this.#showMessage(reason);
      this.dispatchEvent(new CustomEvent('crash', { detail: { reason } }));
    }));
  }

  attributeChangedCallback(name, previous, value) {
    if (name === 'src' && value && value !== previous && this.#client) this.navigate(value);
    if (name === 'provenance-corner') this.#provenance.setCorner(value);
    if (name === 'volume') this.volume = value ?? 1;
    if (name === 'muted') this.muted = value !== null;
    if (name === 'provenance') this.#provenance.setEnabled(value !== 'off');
  }

  async navigate(url) {
    await this.ready;
    return this.#client.request('view.navigate', { url });
  }

  async back() { await this.ready; return this.#client.request('view.back'); }
  async forward() { await this.ready; return this.#client.request('view.forward'); }
  async reload({ bypassCache = false } = {}) { await this.ready; return this.#client.request('view.reload', { bypassCache }); }
  async stop() { await this.ready; return this.#client.request('view.stop'); }
  // Highlights every match and selects the next one: {found, matches}.
  async find(text, { backwards = false, caseSensitive = false } = {}) { await this.ready; return this.#client.request('view.find', { text, backwards, caseSensitive }); }
  async findClear() { await this.ready; return this.#client.request('view.findClear'); }
  // 1 = 100%.
  async zoom(factor) { await this.ready; return this.#client.request('view.zoom', { factor }); }

  // The profile's browsing history, newest first: [{url, title, visited}].
  async history({ text = '', limit = 100, before } = {}) { await this.ready; return this.#client.request('history.query', { text, limit, before }); }
  // {url} or {from, to} (ms since the epoch).
  // Downloads a URL with the page's cookies, as "Save link as" does.
  async download(url) { await this.ready; this.#requireHost('download()'); this.#profileSend('download.start', { url: String(url) }); }
  async cancelDownload(id) { await this.ready; this.#requireHost('cancelDownload()'); this.#profileSend('download.cancel', { id }); }
  // An editing command in the focused frame: 'Copy', 'Cut', 'Paste', 'SelectAll', 'Undo', 'Redo'.
  async edit(command) {
    await this.ready;
    // The embedder asked for it, which is as good as the person asking.
    this.#lastInput = performance.now();
    if (this.#remote) return this.#remote.display?.input('edit', { command: String(command) });
    this.#runtime.send('edit', { command: String(command) });
  }
  async pauseDownload(id) { await this.ready; this.#requireHost('pauseDownload()'); this.#profileSend('download.pause', { id }); }
  async resumeDownload(id) { await this.ready; this.#requireHost('resumeDownload()'); this.#profileSend('download.resume', { id }); }
  async deleteHistory(range) { await this.ready; return this.#client.request('history.delete', range); }

  // The debug methods run script in the page's realm and send raw engine
  // commands, so they exist only when the embedder asks for them: the `debug`
  // attribute or Inception.configure({ debug: true }).
  #debugEnabled() {
    return this.hasAttribute('debug') || config.debug === true;
  }

  #requireDebug() {
    if (!this.#debugEnabled())
      throw new Error('Debug methods are off: set the debug attribute or Inception.configure({ debug: true })');
  }

  // Development aid: evaluates script in the main frame of a window's shown
  // tab (window 1 unless `window` says otherwise).
  async debugEvaluate(source, { window = 1 } = {}) {
    this.#requireDebug();
    await this.ready;
    const id = ++this.#debugRequests;
    const record = this.#windows.get(window);
    const slot = record?.slot ?? this.#primary;
    return new Promise((resolve) => {
      const listener = (e) => {
        if (e.detail.id !== id) return;
        slot.runtime.removeEventListener('debug.result', listener);
        resolve(e.detail.value);
      };
      slot.runtime.addEventListener('debug.result', listener);
      const local = slot.localOf(window);
      slot.runtime.send('debug.evaluate', { id, source, ...(local !== 1 ? { window: local } : {}) });
    });
  }

  // Development aid: sends a raw engine command.
  // JS heap and wasm memory sizes, in bytes.
  async debugHeap() {
    this.#requireDebug();
    await this.ready;
    const reply = new Promise((resolve) => this.#runtime.addEventListener('debug.heap', (e) => resolve(e.detail), { once: true }));
    this.#runtime.send('debug.heap');
    return reply;
  }

  // `args.window` picks the window, and so the engine, it goes to.
  async debugCommand(command, args = {}) {
    this.#requireDebug();
    await this.ready;
    const record = Number.isInteger(args?.window) ? this.#windows.get(args.window) : null;
    (record?.slot?.adapter ?? this.#primary.adapter).send(command, args);
  }

  // Development aid: the profile service (isolation 'window'), or null.
  async debugProfileService() {
    this.#requireDebug();
    await this.ready;
    return this.#service;
  }

  // Connects another protocol client (an iframe, a worker, a remote agent).
  // It may negotiate only `capabilities`: by default just 'view' (navigation,
  // tabs, state). The rest need naming here: 'find' (a text search is an oracle
  // on the page's content), 'history' (the browsing history), 'observe' (the
  // page's console), 'agent' (the agent namespace, when it is enabled) and
  // 'windows' (list, open, resize and close the engine's windows, and bind to
  // another window in hello). ['agent'] alone keeps an agent runtime to the
  // policed agent namespace. `window`: the window it is bound to (default 1);
  // it acts on that window only.
  serve(transport, { capabilities = ['view'], window = 1 } = {}) {
    this.#requireHost('serve()');
    return this.#server.connect(transport, { allow: capabilities, window });
  }

  // The windows of this view's engine, window 1 (the view) first.
  get windows() {
    return this.#remote ? [] : [...this.#windows.values()].map((record) => record.info());
  }

  // Opens another window of this view's engine: same profile, cookies,
  // storage and network. It is hidden (paints nothing) until a display shows
  // it: <inception-window> here, or exportWindow() for another document.
  // `hosts` ({allow?, block?}, isolation 'window'): where its pages may go,
  // instead of policy.hosts.
  async openWindow({ width = 800, height = 600, url = '', deviceScaleFactor = devicePixelRatio, hosts } = {}) {
    await this.ready;
    this.#requireHost('openWindow()');
    const { window } = await this.#client.request('windows.create', { width, height, url, deviceScaleFactor, ...(hosts ? { hosts } : {}) });
    return this.window(window);
  }

  // The handle of a window other than 1, or null.
  window(id) {
    return this.#windowHandles.get(id) ?? null;
  }

  // A display channel for window `id` (see host/display.js): pass the port to
  // another document, which shows the window with createDisplay(canvas, port).
  // The window's earlier display, if any, is replaced. Video, audio and
  // dialogs stay in this document.
  // `frames`: 'auto' (bitmaps where the browser carries them to the other
  // document, RGBA pixels otherwise), 'bitmap' or 'pixels'.
  exportWindow(id, { frames = 'auto' } = {}) {
    if (!['auto', 'bitmap', 'pixels'].includes(frames)) throw new TypeError("frames is 'auto', 'bitmap' or 'pixels'");
    this.#requireHost('exportWindow()');
    const record = this.#windows.get(id);
    if (!record || record.closed || id === 1) throw new Error(`no window ${id} to export (window 1 is the view itself)`);
    const { port1, port2 } = new MessageChannel();
    const served = serveDisplay(port1, {
      frames,
      send: this.#inputSender(record),
      sendMedia: (command, args) => record.slot.runtime.send(command, args),
      sendFile: (name, bytes) => record.channel.sendFile(name, bytes),
      onVisibility: (visible) => this.#setVisible(record, visible),
      onClose: () => {
        if (record.display === served) this.#detachDisplay(record);
      },
    });
    this.#attachRecordDisplay(record, served, served.sink);
    return port2;
  }

  // <inception-window> asks to show window `id`; returns a detach function.
  [ATTACH_DISPLAY](id, element) {
    const record = this.#windows.get(id);
    if (!record || record.closed || id === 1) throw new Error(`no window ${id} to show`);
    const display = element.createDisplay((command, args) => record.channel.send(command, args));
    display.provenance = element.provenance;
    this.#attachRecordDisplay(record, display, display.sink);
    display.start({ input: this.#inputSender(record), clipboard: policy().clipboard !== false });
    // Its videos move under this display and play with the view's level.
    if (record.media) {
      record.media.host.setLayer(element.mediaLayer);
      record.media.host.setMaster({ volume: this.#volume, muted: this.#muted });
    }
    display.provenance?.navigated(record.state.url);
    if (record.agent) element.dataset.control = record.agent.control === 'agent' ? 'agent' : '';
    return () => {
      display.stop();
      if (record.display === display) this.#detachDisplay(record);
    };
  }

  #attachRecordDisplay(record, display, sink) {
    if (record.display && record.display !== display) record.display.close?.();
    record.display = display;
    record.detachSink?.();
    record.detachSink = record.slot.runtime.attachDisplay(record.slot.localOf(record.id), sink);
    // A display in another document plays this window's videos itself.
    if (display.media && record.media) record.media.host = display.media;
    this.#setVisible(record, true);
  }

  #detachDisplay(record) {
    const display = record.display;
    record.detachSink?.();
    record.detachSink = null;
    record.display = null;
    if (record.media) {
      record.media.host = record.media.local;
      record.media.host.setMaster({ volume: 0, muted: true });
    }
    // Sound it was playing goes back to this document.
    for (const [id, entry] of record.slot?.remoteRings ?? []) {
      if (entry.display !== display) continue;
      record.slot.remoteRings.delete(id);
      record.slot.audio.open(entry.ring);
    }
    if (!record.closed) this.#setVisible(record, false);
  }

  #setVisible(record, visible) {
    if (record.visible === visible || record.closed) return;
    record.visible = visible;
    record.channel.send('window.visibility', { visible });
    this.#server?.emit('windows.updated', record.info(), 'windows');
  }

  // Input from a display of `record`: the agent's watch takes control back
  // from it first.
  #inputSender(record) {
    const send = (command, args) => record.channel.send(command, args);
    return record.agent ? record.agent.watchInput(send) : send;
  }

  // The agent namespace (host/agent.js), or null unless the embedder enabled
  // it: the `agent` attribute or Inception.configure({ agent }).
  get agent() {
    return this.#agentEnabled() ? this.#agentClient : null;
  }

  // Who drives the view: 'human' or 'agent'. Any input from the person takes
  // control back; a "control" event reports each change.
  get control() {
    return this.#agentHost?.control ?? 'human';
  }

  async requestControl() {
    return this.#requireAgent().requestControl();
  }

  async releaseControl() {
    return this.#requireAgent().releaseControl();
  }

  #agentEnabled() {
    return this.hasAttribute('agent') || !!config.agent;
  }

  #capabilities() {
    return this.#agentEnabled() ? [...PROTOCOL_CAPABILITIES, 'agent'] : PROTOCOL_CAPABILITIES;
  }

  #requireAgent() {
    if (!this.#agentEnabled()) throw new Error('The agent namespace is off: set the agent attribute or Inception.configure({ agent: true })');
    return this.#agentClient;
  }

  // The profile's lock decides the role. The document that holds it runs the
  // engine; a view in any other document attaches to that one (or, if it
  // cannot, says why). Views of a profile whose service already runs in this
  // document share it and need no lock.
  async #start() {
    if (!config.engineUrl) throw new Error('Inception.configure({engineUrl, relayUrl}) first');
    const profile = this.getAttribute('profile') ?? config.storage?.profile ?? 'default';
    const shared = this.#isolation() === 'window' && (ProfileService.running(profile) || config.storage?.ephemeral === true);
    if (shared) return this.#startHost(profile, { lock: null });
    const lock = await tryLock(profileLockName(profile));
    return lock ? this.#startHost(profile, { lock }) : this.#startAttached(profile);
  }

  #attachEnabled() {
    return config.attach !== false && this.getAttribute('attach') !== 'off';
  }

  // This document holds the profile. `url`: where window 1 starts (the one it
  // had, for a view that took the profile over from its host).
  async #startHost(profile, { lock, url = this.getAttribute('src') ?? '' }) {
    const fresh = this.hasAttribute('fresh-profile') || config.storage?.fresh === true;
    const isolation = this.#isolation();
    // Before the engine starts, so another document can tell this one accepts
    // attachments while it is still starting.
    if (lock && this.#attachEnabled() && !attachHosts.has(profile)) {
      this.#attachHost = await AttachHost.claim(profile);
      attachHosts.set(profile, this.#attachHost);
    }
    if (isolation === 'window') {
      // The service holds the profile (and its Web Lock); views of the same
      // profile in this document share it.
      if (lock && ProfileService.running(profile)) {
        lock.release();
        lock = null;
      }
      this.#service = ProfileService.acquire({ engineUrl: config.engineUrl, relayUrl: config.relayUrl, profile, fresh, ephemeral: config.storage?.ephemeral === true, preferences: this.#preferences.resolved(), debug: this.#debugEnabled(), maxMemoryMB: config.maxMemoryMB, lock });
      await this.#service.start();
      this.#watchService(this.#service);
    } else {
      navigator.storage?.persist?.().catch(() => {});
    }
    const primary = this.#createSlot({ primary: true });
    this.#main.slot = primary;
    primary.root = this.#main;
    primary.windows.set(1, 1);
    primary.locals.set(1, 1);
    // Window 1 is this view's canvas.
    this.#display = new Display({ element: this, shadow: this.#shadow, canvas: this.#canvas, textInput: this.#textInput, send: (command, args) => this.#main.channel.send(command, args) });
    this.#main.display = this.#display;
    primary.runtime.attachDisplay(1, this.#display.sink);
    this.#server = this.#createServer();
    const [serverSide, clientSide] = createInPagePair();
    this.#server.connect(serverSide);
    this.#client = new ProtocolClient(clientSide);
    for (const name of [...VIEW_EVENTS, ...AGENT_EVENTS])
      this.#client.addEventListener(name, (e) => this.dispatchEvent(new CustomEvent(DOM_EVENT_NAMES[name] ?? name, { detail: e.detail })));
    for (const name of WINDOW_EVENTS)
      this.#client.addEventListener(name, (e) => this.dispatchEvent(new CustomEvent(WINDOW_DOM_EVENTS[name], { detail: e.detail })));

    // Videos play in the host page, under the canvas (host/media.js).
    // `autoplay-sound`: the embedder knows playback with sound is allowed here.
    const soundAllowed = this.hasAttribute('autoplay-sound') || policy().autoplaySound;
    this.#soundAllowed = soundAllowed;
    this.#media = new MediaHost(this.#mediaLayer, (command, args) => primary.runtime.send(command, args), { soundAllowed, eme: primary.eme, audio: primary.audio });
    this.#applyLevel();
    this.#downloads = new Downloads(this, (command, args) => this.#profileSend(command, args), policy);
    // binaryen next to the host modules (the package ships it there), or in the
    // repository's node_modules; resolved from this module, so a plain
    // <script type=module> setup needs no bundler.
    translator ??= new WasmTranslator(config.binaryenUrl ?? [new URL('./vendor/binaryen.js', import.meta.url).href, new URL('../node_modules/binaryen/index.js', import.meta.url).href]);
    const [wasmPolyfill, pageShims] = await Promise.all(['./guest-wasm.js', './page-shims.js'].map((path) => fetch(new URL(path, import.meta.url)).then((r) => r.text())));
    this.#pageCode = { wasmPolyfill, pageShims: pageShims.replaceAll('__INCEPTION_VERSION__', ENGINE_VERSION) + userStylesShim(this.userStyles ?? config.userStyles) };
    this.#mediaCapabilities = await probeMediaCapabilities();
    this.#opfsUsable = await probeOpfs();
    // Activation is sticky for the host page's lifetime: the first gesture
    // anywhere in it lets every later video play with sound.
    const gesture = () => {
      for (const media of this.#mediaHosts()) media.userGesture();
      for (const slot of this.#slots) slot.audio.userGesture();
    };
    for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, gesture, { capture: true });

    const { width, height } = this.#cssSize();
    const gpu = this.getAttribute('gpu') ?? 'auto';
    const ready = await this.#startSlot(primary, { width, height, deviceScaleFactor: devicePixelRatio, url, gpu }, async () => {
      await this.#client.hello(this.#capabilities());
    });
    this.#tabs.started(ready.tab ?? 1);
    this.#main.size = { width, height };
    if (gpu === 'on' && ready.renderer !== 'gpu') throw new Error('gpu="on" but WebGL2 is unavailable in the engine worker');
    this.dataset.renderer = ready.renderer;
    this.#display.start({ input: this.#inputSender(this.#main), clipboard: policy().clipboard !== false });
    if (document.activeElement === this) this.focusInput();

    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement !== this) this.#main.channel.send('fullscreen.changed', { active: false });
      this.dispatchEvent(new CustomEvent('fullscreen', { detail: { active: document.fullscreenElement === this } }));
    });
    this.#attachHost?.serve(this, { policy, brokerUrl: config.brokerUrl });
    this.dataset.role = 'host';
    return ready;
  }

  // Another document holds the profile: this view shows a window of it and
  // takes the profile over if that document goes away first (the next in line
  // for the lock does).
  async #startAttached(profile) {
    const busy = `The profile "${profile}" is already open in another tab or window. Close it there, or open this page with a different profile.`;
    if (!this.#attachEnabled() || !(await hostPresent(profile))) throw new Error(busy);
    const connection = await new ProfileConnection(profile).connect({ brokerUrl: config.brokerUrl });
    this.#connection = connection;
    const { width, height } = this.#cssSize();
    const remote = await connection.open({ width, height, deviceScaleFactor: devicePixelRatio, url: this.getAttribute('src') ?? '' });
    this.#remote = remote;
    this.#client = { request: (method, params) => remote.request(method, params) };
    this.#watchRemote(remote, connection);
    remote.show(this.#canvas, {
      element: this, textInput: this.#textInput, menuRoot: this.#shadow, mediaLayer: this.#mediaLayer, dialogTarget: this,
      dialogs: policy().dialogs, clipboard: policy().clipboard !== false, clipboardWrite: policy().clipboard, volume: this.#volume, muted: this.#muted, soundAllowed: this.hasAttribute('autoplay-sound') || policy().autoplaySound,
    });
    if (document.activeElement === this) this.focusInput();
    // Waits in line for the profile: when its host goes away and this is the
    // next document in line, this view becomes the host.
    this.#standby = new AbortController();
    waitLock(profileLockName(profile), this.#standby.signal).then((lock) => lock && this.#promote(profile, lock));
    this.dataset.renderer = 'remote';
    this.dataset.role = 'client';
    return { renderer: 'remote', window: remote.id };
  }

  #watchRemote(remote, connection) {
    for (const name of VIEW_EVENTS)
      remote.addEventListener(DOM_EVENT_NAMES[name] ?? name, (e) => this.dispatchEvent(new CustomEvent(DOM_EVENT_NAMES[name] ?? name, { detail: e.detail })));
    for (const name of ['tabcreated', 'tabupdated', 'tabactivated', 'tabclosed', 'popupblocked'])
      remote.addEventListener(name, (e) => this.dispatchEvent(new CustomEvent(name, { detail: e.detail })));
    remote.addEventListener('navigate', (e) => this.#provenance.navigated(e.detail.url));
    // A page of the window opened another window: the embedder shows it or not.
    remote.addEventListener('windowopen', (e) => {
      const forwarded = new CustomEvent('windowopen', { cancelable: true, detail: e.detail });
      this.dispatchEvent(forwarded);
      if (forwarded.defaultPrevented) e.preventDefault();
    });
    connection.addEventListener('hostlost', () => {
      this.dataset.role = 'reconnecting';
      this.#showMessage('The tab that holds this profile went away. Waiting for another one to take over...');
      this.dispatchEvent(new CustomEvent('hostlost'));
    });
    // Back on a new host: the window is open there again.
    remote.addEventListener('attached', () => {
      this.dataset.role = 'client';
      this.#hideMessage();
      this.dispatchEvent(new CustomEvent('reattached'));
    });
  }

  // The profile's lock came to this document: the view stops being a client
  // and runs the profile itself, starting where its window was.
  #promote(profile, lock) {
    const url = this.#remote?.state.url || this.getAttribute('src') || '';
    this.#connection?.close('this tab took over the profile');
    this.#connection = null;
    this.#remote = null;
    this.#client = null;
    this.#hideMessage();
    const ready = this.#startHost(profile, { lock, url });
    this.#ready = ready;
    ready.then(() => this.dispatchEvent(new CustomEvent('promoted')), (error) => {
      const reason = String(error?.message ?? error);
      this.#showMessage(reason);
      this.dispatchEvent(new CustomEvent('crash', { detail: { reason } }));
    });
  }

  #pageCode = null;
  #mediaCapabilities = null;
  #opfsUsable = true;

  // A new engine for this view (not started): its runtime and the host
  // objects that serve it.
  #createSlot({ primary }) {
    const window = this.#isolation() === 'window';
    const runtime = new EngineRuntime({ engineUrl: config.engineUrl, relayUrl: config.relayUrl, maxMemoryMB: config.maxMemoryMB, role: window ? 'content' : 'standalone' });
    const slot = new EngineSlot({ runtime, primary, allocate: (local) => (window ? (primary && local === 1 ? 1 : this.#nextWindow++) : local) });
    slot.eme = new EncryptedMedia((command, args) => runtime.send(command, args), { onKeysUsable: (mediaKeys) => this.#mediaHosts(slot).forEach((media) => media.keysUsable(mediaKeys)) });
    slot.audio = new AudioHost(() => runtime.memory(), { soundAllowed: this.hasAttribute('autoplay-sound') || policy().autoplaySound });
    slot.audio.setLevel(this.#muted ? 0 : this.#volume);
    slot.modules = new Modules(this, (command, args) => runtime.send(command, args), config.modules);
    if (primary) {
      this.#primary = slot;
      this.#eme = slot.eme;
      this.#audio = slot.audio;
    }
    runtime.onDownloadChunk = (chunk) => {
      const media = this.#mediaHosts(slot).find((host) => host.ownsFetch(chunk.id));
      return media ? media.fetchChunk(chunk) : this.#downloads?.chunk(chunk);
    };
    runtime.onAudioDecode = (request) => slot.audio.decode(request, (size) => runtime.malloc(size));
    runtime.onEngineEvent = (name, data) => this.#onSlotEvent(slot, name, data);
    runtime.onAsk = async (question) => {
      if (Number.isInteger(question?.window)) question.window = slot.publicOf(question.window);
      const record = this.#recordOf(question, slot);
      // A display in another document raises the dialog itself.
      if (record?.display?.ask) {
        const value = await record.display.ask(question);
        if (value !== undefined) return value;
      }
      return answerDialog(record?.target ?? this, question, policy);
    };
    runtime.onMediaAppend = ({ id, sb, seq, bytes }) => this.#mediaHosts(slot).find((media) => media.hasPlayer(id))?.append(id, sb, seq, bytes);
    runtime.wasmTranslator = translator;
    this.#slots.push(slot);
    return slot;
  }

  // Starts a slot's engine and sends "init"; `beforeInit` runs once the
  // engine thread is up. Resolves with "ready".
  async #startSlot(slot, { width, height, deviceScaleFactor, url, gpu = this.getAttribute('gpu') ?? 'auto' }, beforeInit) {
    const runtime = slot.runtime;
    const engineReady = new Promise((resolve, reject) => {
      runtime.addEventListener('ready', (e) => resolve(e.detail), { once: true });
      runtime.addEventListener('crash', (e) => reject(new Error(`the engine crashed while starting: ${e.detail.message}`)), { once: true });
    });
    runtime.wasmTranslator ??= translator;
    await runtime.start();
    await beforeInit?.();
    const profile = this.getAttribute('profile') ?? config.storage?.profile ?? 'default';
    const content = !!this.#service;
    runtime.send('init', {
      width, height, deviceScaleFactor, gpu: gpu !== 'off',
      media: this.#mediaCapabilities, opfs: this.#opfsUsable, ...this.#pageCode,
      // A content engine gets no relay address and no profile: the service
      // has them.
      ...(content ? { role: 'content', engine: slot.number } : { wispUrl: config.relayUrl, profile, freshProfile: this.hasAttribute('fresh-profile') || config.storage?.fresh === true }),
      userAgent: this.getAttribute('user-agent') ?? config.userAgent ?? defaultUserAgent(), preferences: this.#preferences.resolved(), webglContexts: config.webglContexts | 0, popups: policy().popups, url, debug: this.#debugEnabled(),
    });
    if (content) this.#link(slot);
    const ready = await engineReady;
    runtime.addEventListener('crash', (e) => this.#slotCrashed(slot, e.detail));
    return ready;
  }

  #link(slot) {
    if (!this.#service || slot.closed) return;
    slot.link = this.#service.connect(slot.runtime, { onClosed: () => (slot.link = null) });
    // Where its pages may go, enforced where the network is.
    const hosts = slot.hosts ?? policy().hosts;
    if (hosts) this.#service.send('link.policy', { link: slot.link, ...hosts });
  }

  // The profile service's events for this view: downloads and media fetches
  // of its engines (by link), history answers; after a restart every engine
  // of the view is linked again.
  #watchService(service) {
    const slotOf = (link) => this.#slots.find((slot) => slot.link === link) ?? null;
    service.addEventListener('engineevent', (e) => {
      const { name, data } = e.detail;
      if (name === 'history.result') return this.#events.dispatchEvent(new CustomEvent(name, { detail: data }));
      const slot = Number.isInteger(data.link) ? slotOf(data.link) : null;
      if (!slot) return;
      if (name.startsWith('download.')) this.#downloads?.handleEvent(name, data);
      if (name.startsWith('media.fetch.')) this.#mediaHosts(slot).forEach((media) => media.handleFetchEvent(name, data));
    });
    service.addEventListener('chunk', (e) => {
      const chunk = e.detail;
      const slot = slotOf(chunk.link);
      if (!slot) return;
      if (chunk.media) this.#mediaHosts(slot).find((host) => host.ownsFetch(chunk.id))?.fetchChunk(chunk);
      else this.#downloads?.chunk(chunk);
    });
    service.addEventListener('restart', () => {
      for (const slot of this.#slots) this.#link(slot);
    });
  }

  // An engine event: its window ids become the view's, then the view
  // handles it and every listener of the view's engines hears it.
  #onSlotEvent(slot, name, data) {
    if (Number.isInteger(data.window)) data.window = slot.publicOf(data.window);
    if (Number.isInteger(data.openerWindow)) data.openerWindow = slot.publicOf(data.openerWindow);
    if (name === 'ready' && !slot.primary) return;
    this.#handleEngineEvent(slot, name, data);
    this.#events.dispatchEvent(new CustomEvent(name, { detail: data }));
  }

  #handleEngineEvent(slot, name, data) {
    const record = this.#recordOf(data, slot);
    if (name === 'window.created' || name === 'window.opened') return this.#windowCreated(slot, name, data);
    if (name === 'window.closed') return this.#windowClosed(data.window);
    if (name === 'window.focus') return record?.target.dispatchEvent(new CustomEvent('windowfocusrequest', { detail: { window: record.id } }));
    if (name === 'fullscreen') this.#setFullscreen(record, data.active);
    if (name.startsWith('media.') && !name.startsWith('media.fetch.')) this.#mediaFor(data, slot)?.handleEvent(name, data);
    if (name.startsWith('eme.')) slot.eme.handleEvent(name, data);
    if (name.startsWith('download.')) this.#downloads?.handleEvent(name, data);
    if (name.startsWith('media.fetch.')) this.#mediaHosts(slot).forEach((media) => media.handleFetchEvent(name, data));
    if (name.startsWith('tab.') && record) {
      record.tabs.handleEvent(name, data);
      if (name === 'tab.activated') this.#showTab(record, data.tab);
    }
    if (name === 'audio.open') this.#audioOpen(slot, data);
    if (name === 'audio.close') this.#audioClose(slot, data);
    if (name.startsWith('permission.') || name.startsWith('geolocation.') || name.startsWith('notification.')) slot.modules.handleEvent(name, data);
    if (DISPLAY_EVENT_NAMES.has(name)) {
      const display = record?.display;
      if (display?.handleEvent) display.handleEvent(name, data);
      else display?.post?.(name, data);
    }
    // A display in another document raises the picker itself.
    if (name === 'file.choose' && record) {
      if (record.display?.post) record.display.post(name, data);
      else chooseFiles(record.target, record.channel, data);
    }
    if (name === 'field.focus') this.#provenanceOf(record)?.fieldFocused(data.kind, data.origin);
    if (name === 'clipboard.write') {
      if (record?.display?.post) record.display.post(name, { items: data.items });
      else if (this.#mayWriteClipboard()) writeClipboard(data.items);
    }
    if (record && record !== this.#main) record.channel.dispatchEvent(new CustomEvent(name, { detail: data }));
  }

  // Web Audio of an engine plays in this document, unless the window that engine
  // was made for is shown by another document: then the samples go there.
  // The engine does not say which window an audio context belongs to, so this
  // is exact for an engine with one window (isolation 'window') and leaves
  // the sound with the view's own display otherwise.
  #audioOpen(slot, ring) {
    const display = slot.root?.display;
    if (display?.audio) {
      display.audio.open(ring, slot.runtime.memory());
      slot.remoteRings.set(ring.id, { display, ring });
    } else {
      slot.audio.open(ring);
    }
  }

  #audioClose(slot, { id }) {
    const remote = slot.remoteRings.get(id);
    if (!remote) return slot.audio.close({ id });
    slot.remoteRings.delete(id);
    remote.display.audio.close(id);
  }

  // An engine crashed. The view's own engine takes window 1 and its windows
  // down (as a single engine always did); another engine takes only its own
  // windows, which close.
  #slotCrashed(slot, crash) {
    if (slot.closed) return;
    if (this.#service && slot.link) this.#service.disconnect(slot.link);
    slot.link = null;
    if (slot.primary) return this.#crashed(crash);
    const windows = [...this.#windows.values()].filter((record) => record.slot === slot).map((record) => record.id);
    const detail = { reason: crash.message, stack: crash.stack, ...(crash.kind ? { kind: crash.kind } : {}), windows };
    for (const id of windows) {
      const record = this.#windows.get(id);
      record.channel.dispatchEvent(new CustomEvent('crash', { detail: crash }));
      record.target.dispatchEvent(new CustomEvent('crash', { detail }));
      this.#server.emit('crash', { ...crash, windows }, 'view', id);
    }
    this.#closeSlot(slot);
  }

  // Stops an engine the view no longer needs (its last window closed, or it
  // crashed): its windows close.
  #closeSlot(slot) {
    if (slot.closed || slot.primary) return;
    slot.closed = true;
    if (this.#service && slot.link) this.#service.disconnect(slot.link);
    slot.link = null;
    for (const record of [...this.#windows.values()]) {
      if (record.slot === slot) this.#windowClosed(record.id);
    }
    slot.runtime.terminate();
    this.#slots = this.#slots.filter((other) => other !== slot);
  }

  // isolation 'window': a window in an engine of its own.
  async #openEngineWindow({ width, height, deviceScaleFactor, url, hosts }) {
    const slot = this.#createSlot({ primary: false });
    slot.hosts = hostRules(hosts);
    try {
      const ready = await this.#startSlot(slot, { width, height, deviceScaleFactor, url: '' });
      // "ready" already carries the view's id for the engine's first window.
      const id = ready.window ?? slot.publicOf(1);
      this.#windowCreated(slot, 'window.created', { window: id, tab: ready.tab });
      const record = this.#windows.get(id);
      slot.root = record;
      record.size = { width, height };
      // Its first window starts hidden, as a window of one engine does.
      record.channel.send('window.visibility', { visible: false });
      if (url) record.channel.send('load', { url });
      return record;
    } catch (error) {
      this.#closeSlot(slot);
      throw error;
    }
  }

  // The view's engine crashed: every window's connections and handles hear
  // it, with the windows it took down (those of other engines live on).
  #crashed(crash) {
    const windows = [...this.#windows.values()].filter((record) => record.slot === this.#primary).map((record) => record.id);
    const detail = { reason: crash.message, stack: crash.stack, ...(crash.kind ? { kind: crash.kind } : {}), windows };
    this.#server.emit('crash', crash, 'view', 1);
    this.dispatchEvent(new CustomEvent('crash', { detail }));
    for (const record of this.#windows.values()) {
      if (record === this.#main || record.slot !== this.#primary) continue;
      record.channel.dispatchEvent(new CustomEvent('crash', { detail: crash }));
      record.target.dispatchEvent(new CustomEvent('crash', { detail }));
      this.#server.emit('crash', { ...crash, windows }, 'view', record.id);
    }
  }

  // The window an engine event or question belongs to; when it names none
  // (engine-wide events, an engine without windows), the first window of the
  // engine it came from: window 1 for the view's.
  #recordOf(data, slot = this.#primary) {
    const id = data?.window;
    return Number.isInteger(id) ? this.#windows.get(id) ?? null : slot?.root ?? this.#main;
  }

  // Media hosts of one engine's windows, or of all.
  #mediaHosts(slot = null) {
    const hosts = this.#media && (!slot || slot === this.#primary) ? [this.#media] : [];
    for (const record of this.#windows.values()) {
      if (record.media && (!slot || record.slot === slot)) hosts.push(record.media.host);
    }
    return hosts;
  }

  #mediaFor(data, slot = this.#primary) {
    const record = this.#recordOf(data, slot);
    if (!record || record === this.#main) return this.#media;
    return record.media?.host ?? null;
  }

  #provenanceOf(record) {
    if (!record || record === this.#main) return this.#provenance;
    return record.display?.provenance ?? null;
  }

  // A window appeared in the engine: the embedder's (openWindow,
  // windows.create) or a page's (window.open with popups: 'window').
  #windowCreated(slot, name, data) {
    const id = data.window;
    if (!Number.isInteger(id) || id < 2 || this.#windows.has(id)) return;
    let handle = null;
    const target = { dispatchEvent: (event) => handle.dispatchEvent(event) };
    const record = new HostWindow({ id, runtime: slot.adapter, target, policy });
    record.slot = slot;
    handle = new InceptionWindow({
      id,
      record,
      connect: (transport) => this.#server.connect(transport, { window: id }),
      serve: (transport, { capabilities = ['view'] } = {}) => this.#server.connect(transport, { allow: capabilities, window: id }),
      events: [...VIEW_EVENTS, ...AGENT_EVENTS].map((event) => [event, DOM_EVENT_NAMES[event] ?? event]),
      capabilities: this.#capabilities(),
      agentEnabled: this.#agentEnabled(),
    });
    record.target = handle;
    if (Number.isInteger(data.tab)) record.tabs.started(data.tab);
    // Its videos play muted, off screen, until a display here shows it.
    const host = new MediaHost(document.createElement('div'), (command, args) => slot.runtime.send(command, args), { soundAllowed: this.#soundAllowed, eme: slot.eme, audio: slot.audio });
    host.setMaster({ volume: 0, muted: true });
    record.media = { host, local: host };
    if (this.#agentEnabled()) record.agent = this.#createAgent(record);
    this.#windows.set(id, record);
    this.#windowHandles.set(id, handle);
    if (name === 'window.created' && slot.primary) this.#pendingWindows.shift()?.(record);
    this.#server.emit('windows.created', record.info(), 'windows');
    if (name === 'window.opened') this.#windowOpened(record, handle, data);
  }

  // A page opened a window (popups: 'window'): the embedder decides as for a
  // new tab ("windowopen", then policy.newTabs); a refused one is closed.
  #windowOpened(record, handle, data) {
    const detail = { window: handle, opener: data.opener, openerWindow: data.openerWindow, url: data.url ?? '', userGesture: !!data.userGesture };
    let accepted = false;
    const event = new CustomEvent('windowopen', { cancelable: true, detail: { ...detail, allow: () => (accepted = true) } });
    this.dispatchEvent(event);
    const keep = !event.defaultPrevented && (accepted || (detail.userGesture && policy().newTabs !== 'block'));
    if (keep) return;
    record.channel.send('window.close');
    if (!event.defaultPrevented) this.dispatchEvent(new CustomEvent('popupblocked', { detail: { tab: data.tab, opener: data.opener, url: detail.url, userGesture: detail.userGesture, window: record.id } }));
  }

  #windowClosed(id) {
    const record = this.#windows.get(id);
    if (!record || record === this.#main || record.closed) return;
    record.closed = true;
    record.display?.close?.();
    this.#detachDisplay(record);
    this.#windows.delete(id);
    this.#windowHandles.delete(id);
    record.channel.dispatchEvent(new CustomEvent('window.closed', { detail: { window: id } }));
    record.target.dispatchEvent(new CustomEvent('close', { detail: { window: id } }));
    this.#server.emit('windows.closed', { window: id }, 'windows');
    // The first window of an engine of its own takes the engine with it.
    if (record.slot && !record.slot.primary && record.slot.root === record) this.#closeSlot(record.slot);
  }

  #createAgent(record) {
    const isMain = record === this.#main;
    return new AgentHost({
      element: isMain ? this : null,
      shadow: isMain ? this.#shadow : null,
      runtime: isMain ? this.#mainChannel() : record.channel,
      server: this.#server,
      window: record.id,
      options: () => (typeof config.agent === 'object' && config.agent ? config.agent : {}),
      state: () => ({ ...record.state }),
      captureFrame: () => (isMain ? this.#canvas : record.display?.canvas ?? null),
    });
  }

  // Window 1's agent hears the engine's events for window 1 (and the
  // engine-wide ones an older engine sends without a window).
  #mainChannel() {
    const runtime = this.#runtime;
    const main = this.#main;
    const mine = (detail) => detail?.window === undefined || detail.window === 1;
    const wrapped = new Map();
    return {
      send: (command, args) => main.channel.send(command, args),
      get crash() { return runtime.crash; },
      addEventListener(name, listener, options) {
        const filtered = (e) => (name === 'crash' || mine(e.detail)) && listener(e);
        wrapped.set(listener, filtered);
        runtime.addEventListener(name, filtered, options);
      },
      removeEventListener(name, listener) {
        runtime.removeEventListener(name, wrapped.get(listener) ?? listener);
      },
    };
  }

  // Another tab is shown: the window's state and events follow it.
  #showTab(record, id) {
    const tab = record.tabs.get(id);
    if (!tab) return;
    Object.assign(record.state, { url: tab.url, title: tab.title, loading: tab.loading, canGoBack: tab.canGoBack, canGoForward: tab.canGoForward });
    this.#provenanceOf(record)?.navigated(tab.url);
    for (const [name, detail] of [['navigate', { url: tab.url }], ['title', { title: tab.title }], ['loading', { loading: tab.loading }]])
      this.#server?.emit(name, { tab: id, ...detail }, 'view', record.id);
  }

  #hideMessage() {
    this.#shadow.querySelector('.message:not(.tamper)')?.remove();
  }

  // Why the view cannot start, shown in the view itself so it never just stays
  // blank (e.g. the profile is open in another tab).
  #showMessage(text) {
    let box = this.#shadow.querySelector('.message');
    if (!box) {
      box = document.createElement('div');
      box.className = 'message';
      box.setAttribute('part', 'message');
      box.setAttribute('role', 'alert');
      this.#shadow.append(box);
    }
    box.textContent = text;
  }

  // The page asked for fullscreen (or to leave it): window 1's is the view
  // element's own; another window's is its <inception-window>'s, when one in
  // this document shows it.
  async #setFullscreen(record, active) {
    if (!record) return;
    const element = record === this.#main ? this : record.display?.element;
    try {
      if (!element) throw new Error('no element shows this window here');
      if (active && document.fullscreenElement !== element) await element.requestFullscreen();
      if (!active && document.fullscreenElement === element) await document.exitFullscreen();
      if (active) record.channel.send('fullscreen.changed', { active: true });
    } catch (error) {
      record.channel.send('fullscreen.changed', { active: false, error: String(error?.message ?? error) });
    }
  }

  // The window a protocol call acts on: the calling connection's.
  #windowFor(window) {
    const record = this.#windows.get(window ?? 1);
    if (!record || record.closed) throw ProtocolError.fromReason('not_ready', 'the window is closed');
    return record;
  }

  #createServer() {
    const server = new ProtocolServer(this.#capabilities(), { optIn: ['history', 'find', 'observe', 'agent', 'windows'], windowExists: (id) => !!this.#windows.get(id) && !this.#windows.get(id).closed });
    this.#server = server;
    const events = this.#events;
    if (this.#agentEnabled()) {
      this.#main.agent = this.#createAgent(this.#main);
      registerAgentMethods(server, (window) => this.#windows.get(window)?.agent ?? null);
    }
    const send = (window, command, args) => this.#windowFor(window).channel.send(command, args);
    server.handle('view.navigate', ({ url }, { window }) => {
      if (typeof url !== 'string' || !url) throw new TypeError('url must be a non-empty string');
      send(window, 'load', { url });
    });
    server.handle('view.state', (params, { window }) => ({ ...this.#windowFor(window).state }));
    server.handle('view.back', (params, { window }) => send(window, 'back'));
    server.handle('view.forward', (params, { window }) => send(window, 'forward'));
    server.handle('view.reload', ({ bypassCache } = {}, { window }) => send(window, 'reload', { bypassCache: !!bypassCache }));
    server.handle('view.stop', (params, { window }) => send(window, 'stop'));
    server.handle('view.find', ({ text, backwards, caseSensitive } = {}, { window }) => new Promise((resolve) => {
      const record = this.#windowFor(window);
      const listener = (e) => {
        if ((e.detail.window ?? 1) !== record.id) return;
        events.removeEventListener('find.result', listener);
        resolve({ found: e.detail.found, matches: e.detail.matches });
      };
      events.addEventListener('find.result', listener);
      record.channel.send('find', { text: String(text ?? ''), backwards: !!backwards, caseSensitive: !!caseSensitive });
    }), 'find');
    server.handle('view.findClear', (params, { window }) => send(window, 'find.clear'), 'find');
    server.handle('history.query', (args = {}) => new Promise((resolve) => {
      const id = ++lastHistoryRequest;
      const listener = (e) => {
        if (e.detail.id !== id) return;
        events.removeEventListener('history.result', listener);
        resolve(e.detail.entries);
      };
      events.addEventListener('history.result', listener);
      this.#profileSend('history.query', { id, text: String(args.text ?? ''), limit: args.limit | 0 || 100, ...(args.before ? { before: Number(args.before) } : {}) });
    }));
    server.handle('history.delete', (args = {}) => this.#profileSend('history.delete', args.url ? { url: String(args.url) } : { from: Number(args.from ?? 0), to: Number(args.to ?? Number.MAX_VALUE) }));
    server.handle('view.zoom', ({ factor } = {}, { window }) => {
      if (!(factor > 0)) throw new TypeError('factor must be a positive number');
      send(window, 'zoom', { factor });
    });
    server.handle('view.tabs', (params, { window }) => this.#windowFor(window).tabs.list());
    server.handle('view.createTab', ({ url = '', activate = true } = {}, { window }) => this.#windowFor(window).tabs.create(String(url), { activate: !!activate }));
    server.handle('view.activateTab', ({ tab } = {}, { window }) => this.#windowFor(window).tabs.activate(Number(tab)));
    server.handle('view.closeTab', ({ tab } = {}, { window }) => this.#windowFor(window).tabs.close(Number(tab)));

    // The windows capability. A window it opens is not bound to the caller:
    // driving it takes a connection bound to it.
    const windowId = (value) => {
      if (!Number.isInteger(value) || value < 1) throw ProtocolError.fromReason('invalid_params', 'window must be a positive integer');
      return value;
    };
    const dimension = (value, name) => {
      if (!Number.isFinite(value) || value < 1 || value > 16384) throw ProtocolError.fromReason('invalid_params', `${name} must be between 1 and 16384`);
      return Math.round(value);
    };
    server.handle('windows.list', () => this.windows);
    server.handle('windows.create', ({ width = 800, height = 600, url = '', deviceScaleFactor = 1, hosts } = {}) => new Promise((resolve, reject) => {
      if (typeof url !== 'string') throw ProtocolError.fromReason('invalid_params', 'url must be a string');
      const size = { width: dimension(width, 'width'), height: dimension(height, 'height') };
      const scale = Number(deviceScaleFactor) > 0 && Number(deviceScaleFactor) <= 8 ? Number(deviceScaleFactor) : 1;
      if (this.#service) {
        this.#openEngineWindow({ ...size, deviceScaleFactor: scale, url, hosts }).then((record) => resolve(record.info()), (error) => reject(ProtocolError.fromReason('not_ready', String(error?.message ?? error))));
        return;
      }
      const timer = setTimeout(() => reject(ProtocolError.fromReason('timeout', 'the engine did not open the window')), 10000);
      this.#pendingWindows.push((record) => {
        clearTimeout(timer);
        record.size = size;
        resolve(record.info());
      });
      this.#main.channel.send('window.create', { ...size, deviceScaleFactor: scale, url });
    }));
    server.handle('windows.close', ({ window } = {}) => {
      if (windowId(window) === 1) throw ProtocolError.fromReason('invalid_params', 'window 1 is the view and cannot be closed');
      const record = this.#windowFor(window);
      // A window with an engine of its own closes with the engine.
      if (record.slot && !record.slot.primary && record.slot.root === record) return this.#closeSlot(record.slot);
      record.channel.send('window.close');
    });
    server.handle('windows.resize', ({ window, width, height, deviceScaleFactor = 1 } = {}) => {
      const record = this.#windowFor(windowId(window));
      if (record.display) throw ProtocolError.fromReason('invalid_params', 'a display sets the size of the window it shows');
      record.size = { width: dimension(width, 'width'), height: dimension(height, 'height') };
      record.channel.send('resize', { ...record.size, deviceScaleFactor: Number(deviceScaleFactor) > 0 ? Number(deviceScaleFactor) : 1 });
      server.emit('windows.updated', record.info(), 'windows');
    });

    for (const name of VIEW_EVENTS) {
      if (name === 'crash') continue;
      events.addEventListener(name, (e) => {
        const record = this.#recordOf(e.detail);
        if (!record) return;
        // A hidden tab's page events update its tab record only.
        if (!record.track(name, e.detail)) return;
        if (name === 'navigate') this.#provenanceOf(record)?.navigated(e.detail.url);
        server.emit(name, e.detail, EVENT_CAPABILITY[name], record.id);
      });
    }
    return server;
  }

  #cssSize() {
    const rect = this.getBoundingClientRect();
    return { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
  }
}

customElements.define('inception-view', InceptionView);
