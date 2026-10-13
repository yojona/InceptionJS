import { writeClipboard } from './input.js';
import { answerDialog, chooseFiles } from './ui.js';
import { Preferences } from './preferences.js';
import { ENGINE_VERSION, defaultUserAgent } from './identity.js';
import { PROVENANCE_STYLE, Provenance } from './provenance.js';
import { MediaHost, probeMediaCapabilities } from './media.js';
import { EncryptedMedia } from './eme.js';
import { AudioHost } from './audio.js';
import { Modules } from './modules.js';
import { Downloads } from './downloads.js';
import { resolvePolicy } from './policy.js';
import { EngineRuntime } from './runtime.js';
import { WasmTranslator } from './wasm-translator.js';
import { ProtocolClient, ProtocolError, ProtocolServer, createInPagePair } from './protocol.js';
import { AgentClient, AgentHost, registerAgentMethods } from './agent.js';
import { Display, serveDisplay } from './display.js';
import { ATTACH_DISPLAY, HostWindow, InceptionWindow } from './window.js';

const config = { engineUrl: null, relayUrl: null, binaryenUrl: null, storage: null, policy: null, debug: false, agent: null, webglContexts: 0, modules: {} };
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
  // namespace on every view, which is off otherwise.
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

// Events the engine reports that the view re-dispatches as DOM events.
const VIEW_EVENTS = ['security.state', 'security.certificateError', 'navigate', 'title', 'loading', 'popup', 'console', 'crash', 'cursor', 'navigation.state', 'find.result', 'zoom', 'contextmenu'];
// Names the view dispatches them under where the engine's would clash with
// the element's own DOM events.
// What the view's own client negotiates; remote clients get less (serve()).
const PROTOCOL_CAPABILITIES = ['view', 'history', 'find', 'observe', 'windows'];
const EVENT_CAPABILITY = { console: 'observe', 'find.result': 'find' };
const DOM_EVENT_NAMES = { 'security.state': 'securitystate', 'security.certificateError': 'certificateerror', contextmenu: 'contextmenurequest', 'navigation.state': 'navigationstate', 'find.result': 'findresult', 'agent.action': 'agentaction', 'agent.blocked': 'agentblocked' };
// Events of the agent namespace (host/agent.js), re-dispatched the same way.
const AGENT_EVENTS = ['control', 'agent.action', 'agent.blocked'];
// Events of the windows capability, on the view.
const WINDOW_EVENTS = ['windows.created', 'windows.closed', 'windows.updated'];
const WINDOW_DOM_EVENTS = { 'windows.created': 'windowcreated', 'windows.closed': 'windowclosed', 'windows.updated': 'windowupdated' };
// Engine events a window's display draws.
const DISPLAY_EVENT_NAMES = new Set(['cursor', 'select.show', 'select.update', 'select.hide']);

// <inception-view src gpu="auto|on|off" muted media profile fresh-profile user-agent
//                 provenance-corner provenance="off" agent>
//
// A thin client: it speaks the protocol to a server bound to its own engine,
// exactly as a remote agent would. `serve(transport)` connects more clients.
export class InceptionView extends HTMLElement {
  static observedAttributes = ['src', 'provenance-corner', 'provenance', 'volume', 'muted'];

  /** CSS for every page this view shows (see userStylesShim); set before it starts. */
  userStyles = null;
  #runtime = null;
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
  #preferences = new Preferences((changed) => this.#runtime?.send('preferences', changed));
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
  get #state() { return this.#main.state; }
  get #tabs() { return this.#main.tabs; }
  get #agentHost() { return this.#main.agent; }

  constructor() {
    super();
    const view = this;
    const runtime = {
      send: (command, args) => view.#runtime?.send(command, args),
      sendFile: (name, bytes) => view.#runtime?.sendFile(name, bytes),
      get crash() { return view.#runtime?.crash; },
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
  get securityState() { return this.#main.security; }

  // Tabs share this view and its engine; one is shown (host/tabs.js).
  get tabs() { return this.#tabs.list(); }
  get activeTab() { return this.#tabs.active; }
  async createTab(url = '', { activate = true } = {}) { await this.ready; this.#tabs.create(String(url), { activate }); }
  async activateTab(id) { await this.ready; this.#tabs.activate(id); }
  async closeTab(id) { await this.ready; this.#tabs.close(id); }

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
    this.#audio?.setLevel(this.#muted ? 0 : this.#volume);
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
  async download(url) { await this.ready; this.#runtime.send('download.start', { url: String(url) }); }
  async cancelDownload(id) { await this.ready; this.#runtime.send('download.cancel', { id }); }
  // An editing command in the focused frame: 'Copy', 'Cut', 'Paste', 'SelectAll', 'Undo', 'Redo'.
  async edit(command) {
    await this.ready;
    // The embedder asked for it, which is as good as the person asking.
    this.#lastInput = performance.now();
    this.#runtime.send('edit', { command: String(command) });
  }
  async pauseDownload(id) { await this.ready; this.#runtime.send('download.pause', { id }); }
  async resumeDownload(id) { await this.ready; this.#runtime.send('download.resume', { id }); }
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
    return new Promise((resolve) => {
      const listener = (e) => {
        if (e.detail.id !== id) return;
        this.#runtime.removeEventListener('debug.result', listener);
        resolve(e.detail.value);
      };
      this.#runtime.addEventListener('debug.result', listener);
      this.#runtime.send('debug.evaluate', { id, source, ...(window !== 1 ? { window } : {}) });
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

  async debugCommand(command, args = {}) {
    this.#requireDebug();
    await this.ready;
    this.#runtime.send(command, args);
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
    return this.#server.connect(transport, { allow: capabilities, window });
  }

  // The windows of this view's engine, window 1 (the view) first.
  get windows() {
    return [...this.#windows.values()].map((record) => record.info());
  }

  // Opens another window of this view's engine: same profile, cookies,
  // storage and network. It is hidden (paints nothing) until a display shows
  // it: <inception-window> here, or exportWindow() for another document.
  async openWindow({ width = 800, height = 600, url = '', deviceScaleFactor = devicePixelRatio } = {}) {
    await this.ready;
    const { window } = await this.#client.request('windows.create', { width, height, url, deviceScaleFactor });
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
    const record = this.#windows.get(id);
    if (!record || record.closed || id === 1) throw new Error(`no window ${id} to export (window 1 is the view itself)`);
    const { port1, port2 } = new MessageChannel();
    const served = serveDisplay(port1, {
      frames,
      send: this.#inputSender(record),
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
    record.detachSink = this.#runtime.attachDisplay(record.id, sink);
    this.#setVisible(record, true);
  }

  #detachDisplay(record) {
    record.detachSink?.();
    record.detachSink = null;
    record.display = null;
    if (record.media) record.media.host.setMaster({ volume: 0, muted: true });
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

  async #start() {
    if (!config.engineUrl) throw new Error('Inception.configure({engineUrl, relayUrl}) first');
    // A profile's files are open by one engine at a time: the second tab would
    // get read-only file handles. Held for the life of this page.
    const profile = this.getAttribute('profile') ?? config.storage?.profile ?? 'default';
    if (navigator.locks) {
      const acquired = await new Promise((resolve) => navigator.locks.request(`inception-profile:${profile}`, { ifAvailable: true }, (lock) => {
        resolve(!!lock);
        return lock ? new Promise(() => {}) : undefined;
      }));
      if (!acquired) throw new Error(`The profile "${profile}" is already open in another tab or window. Close it there, or open this page with a different profile.`);
    }
    navigator.storage?.persist?.().catch(() => {});
    this.#runtime = new EngineRuntime({ engineUrl: config.engineUrl, relayUrl: config.relayUrl, maxMemoryMB: config.maxMemoryMB });
    // Window 1 is this view's canvas.
    this.#display = new Display({ element: this, shadow: this.#shadow, canvas: this.#canvas, textInput: this.#textInput, send: (command, args) => this.#main.channel.send(command, args) });
    this.#main.display = this.#display;
    this.#runtime.attachDisplay(1, this.#display.sink);
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
    const eme = new EncryptedMedia((command, args) => this.#runtime.send(command, args), { onKeysUsable: (mediaKeys) => this.#mediaHosts().forEach((media) => media.keysUsable(mediaKeys)) });
    this.#eme = eme;
    const audio = new AudioHost(() => this.#runtime.memory(), { soundAllowed });
    this.#audio = audio;
    this.#media = new MediaHost(this.#mediaLayer, (command, args) => this.#runtime.send(command, args), { soundAllowed, eme, audio });
    this.#applyLevel();
    const modules = new Modules(this, (command, args) => this.#runtime.send(command, args), config.modules);
    const downloads = new Downloads(this, (command, args) => this.#runtime.send(command, args), policy);
    this.#runtime.onDownloadChunk = (chunk) => {
      const media = this.#mediaHosts().find((host) => host.ownsFetch(chunk.id));
      return media ? media.fetchChunk(chunk) : downloads.chunk(chunk);
    };
    this.#runtime.onAudioDecode = (request) => audio.decode(request, (size) => this.#runtime.malloc(size));
    this.#runtime.onEngineEvent = (name, data) => {
      const record = this.#recordOf(data);
      if (name === 'window.created' || name === 'window.opened') return this.#windowCreated(name, data);
      if (name === 'window.closed') return this.#windowClosed(data.window);
      if (name === 'window.focus') return record?.target.dispatchEvent(new CustomEvent('windowfocusrequest', { detail: { window: record.id } }));
      if (name === 'fullscreen') this.#setFullscreen(record, data.active);
      if (name.startsWith('media.') && !name.startsWith('media.fetch.')) this.#mediaFor(data)?.handleEvent(name, data);
      if (name.startsWith('eme.')) eme.handleEvent(name, data);
      if (name.startsWith('download.')) downloads.handleEvent(name, data);
      if (name.startsWith('media.fetch.')) this.#mediaHosts().forEach((media) => media.handleFetchEvent(name, data));
      if (name.startsWith('tab.') && record) {
        record.tabs.handleEvent(name, data);
        if (name === 'tab.activated') this.#showTab(record, data.tab);
      }
      if (name === 'audio.open') audio.open(data);
      if (name === 'audio.close') audio.close(data);
      if (name.startsWith('permission.') || name.startsWith('geolocation.') || name.startsWith('notification.')) modules.handleEvent(name, data);
      if (DISPLAY_EVENT_NAMES.has(name)) {
        const display = record?.display;
        if (display?.handleEvent) display.handleEvent(name, data);
        else display?.post?.(name, data);
      }
      if (name === 'file.choose' && record) chooseFiles(record.target, record.channel, data);
      if (name === 'field.focus') this.#provenanceOf(record)?.fieldFocused(data.kind, data.origin);
      if (name === 'clipboard.write' && this.#mayWriteClipboard()) writeClipboard(data.items);
      if (record && record !== this.#main) record.channel.dispatchEvent(new CustomEvent(name, { detail: data }));
    };
    this.#runtime.onAsk = (question) => answerDialog(this.#recordOf(question)?.target ?? this, question, policy);
    this.#runtime.onMediaAppend = ({ id, sb, seq, bytes }) => this.#mediaHosts().find((media) => media.hasPlayer(id))?.append(id, sb, seq, bytes);
    // binaryen next to the host modules (the package ships it there), or in the
    // repository's node_modules; resolved from this module, so a plain
    // <script type=module> setup needs no bundler.
    translator ??= new WasmTranslator(config.binaryenUrl ?? [new URL('./vendor/binaryen.js', import.meta.url).href, new URL('../node_modules/binaryen/index.js', import.meta.url).href]);
    this.#runtime.wasmTranslator = translator;
    const [wasmPolyfill, pageShims] = await Promise.all(['./guest-wasm.js', './page-shims.js'].map((path) => fetch(new URL(path, import.meta.url)).then((r) => r.text())));
    // Activation is sticky for the host page's lifetime: the first gesture
    // anywhere in it lets every later video play with sound.
    const gesture = () => {
      for (const media of this.#mediaHosts()) media.userGesture();
      audio.userGesture();
    };
    for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, gesture, { capture: true });

    const engineReady = new Promise((resolve, reject) => {
      this.#runtime.addEventListener('ready', (e) => resolve(e.detail), { once: true });
      this.#runtime.addEventListener('crash', (e) => reject(new Error(`the engine crashed while starting: ${e.detail.message}`)), { once: true });
    });
    await this.#runtime.start();
    await this.#client.hello(this.#capabilities());

    const { width, height } = this.#cssSize();
    const gpu = this.getAttribute('gpu') ?? 'auto';
    this.#runtime.send('init', { width, height, deviceScaleFactor: devicePixelRatio, gpu: gpu !== 'off', media: await probeMediaCapabilities(), wasmPolyfill, pageShims: pageShims.replaceAll('__INCEPTION_VERSION__', ENGINE_VERSION) + userStylesShim(this.userStyles ?? config.userStyles), wispUrl: config.relayUrl, profile, freshProfile: this.hasAttribute('fresh-profile') || config.storage?.fresh === true, userAgent: this.getAttribute('user-agent') ?? config.userAgent ?? defaultUserAgent(), preferences: this.#preferences.resolved(), webglContexts: config.webglContexts | 0 || PAGE_WEBGL_CONTEXTS, popups: policy().popups, url: this.getAttribute('src') ?? '', debug: this.#debugEnabled() });
    const ready = await engineReady;
    this.#tabs.started(ready.tab ?? 1);
    this.#main.size = { width, height };
    this.#runtime.addEventListener('crash', (e) => this.#crashed(e.detail));
    if (gpu === 'on' && ready.renderer !== 'gpu') throw new Error('gpu="on" but WebGL2 is unavailable in the engine worker');
    this.dataset.renderer = ready.renderer;
    this.#display.start({ input: this.#inputSender(this.#main), clipboard: policy().clipboard !== false });
    if (document.activeElement === this) this.focusInput();

    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement !== this) this.#main.channel.send('fullscreen.changed', { active: false });
      this.dispatchEvent(new CustomEvent('fullscreen', { detail: { active: document.fullscreenElement === this } }));
    });
    return ready;
  }

  // The engine crashed: every window's connections and handles hear it, with
  // the windows it took down.
  #crashed(crash) {
    const windows = [...this.#windows.keys()];
    const detail = { reason: crash.message, stack: crash.stack, ...(crash.kind ? { kind: crash.kind } : {}), windows };
    this.dispatchEvent(new CustomEvent('crash', { detail }));
    for (const record of this.#windows.values()) {
      if (record === this.#main) continue;
      record.channel.dispatchEvent(new CustomEvent('crash', { detail: crash }));
      record.target.dispatchEvent(new CustomEvent('crash', { detail }));
      this.#server.emit('crash', { ...crash, windows }, 'view', record.id);
    }
  }

  // The window an engine event or question belongs to; window 1 when it names
  // none (engine-wide events, an engine without windows).
  #recordOf(data) {
    const id = data?.window;
    return Number.isInteger(id) ? this.#windows.get(id) ?? null : this.#main;
  }

  #mediaHosts() {
    const hosts = this.#media ? [this.#media] : [];
    for (const record of this.#windows.values()) if (record.media) hosts.push(record.media.host);
    return hosts;
  }

  #mediaFor(data) {
    const record = this.#recordOf(data);
    if (!record || record === this.#main) return this.#media;
    return record.media?.host ?? null;
  }

  #provenanceOf(record) {
    if (!record || record === this.#main) return this.#provenance;
    return record.display?.provenance ?? null;
  }

  // A window appeared in the engine: the embedder's (openWindow,
  // windows.create) or a page's (window.open with popups: 'window').
  #windowCreated(name, data) {
    const id = data.window;
    if (!Number.isInteger(id) || id < 2 || this.#windows.has(id)) return;
    let handle = null;
    const target = { dispatchEvent: (event) => handle.dispatchEvent(event) };
    const record = new HostWindow({ id, runtime: this.#runtime, target, policy });
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
    const host = new MediaHost(document.createElement('div'), (command, args) => this.#runtime.send(command, args), { soundAllowed: this.#soundAllowed, eme: this.#eme, audio: this.#audio });
    host.setMaster({ volume: 0, muted: true });
    record.media = { host };
    if (this.#agentEnabled()) record.agent = this.#createAgent(record);
    this.#windows.set(id, record);
    this.#windowHandles.set(id, handle);
    if (name === 'window.created') this.#pendingWindows.shift()?.(record);
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
    if (!record || record === this.#main) return;
    record.closed = true;
    record.display?.close?.();
    this.#detachDisplay(record);
    this.#windows.delete(id);
    this.#windowHandles.delete(id);
    record.channel.dispatchEvent(new CustomEvent('window.closed', { detail: { window: id } }));
    record.target.dispatchEvent(new CustomEvent('close', { detail: { window: id } }));
    this.#server.emit('windows.closed', { window: id }, 'windows');
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
    const runtime = this.#runtime;
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
        runtime.removeEventListener('find.result', listener);
        resolve({ found: e.detail.found, matches: e.detail.matches });
      };
      runtime.addEventListener('find.result', listener);
      record.channel.send('find', { text: String(text ?? ''), backwards: !!backwards, caseSensitive: !!caseSensitive });
    }), 'find');
    server.handle('view.findClear', (params, { window }) => send(window, 'find.clear'), 'find');
    let historyRequests = 0;
    server.handle('history.query', (args = {}) => new Promise((resolve) => {
      const id = ++historyRequests;
      const listener = (e) => {
        if (e.detail.id !== id) return;
        runtime.removeEventListener('history.result', listener);
        resolve(e.detail.entries);
      };
      runtime.addEventListener('history.result', listener);
      runtime.send('history.query', { id, text: String(args.text ?? ''), limit: args.limit | 0 || 100, ...(args.before ? { before: Number(args.before) } : {}) });
    }));
    server.handle('history.delete', (args = {}) => runtime.send('history.delete', args.url ? { url: String(args.url) } : { from: Number(args.from ?? 0), to: Number(args.to ?? Number.MAX_VALUE) }));
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
    server.handle('windows.create', ({ width = 800, height = 600, url = '', deviceScaleFactor = 1 } = {}) => new Promise((resolve, reject) => {
      if (typeof url !== 'string') throw ProtocolError.fromReason('invalid_params', 'url must be a string');
      const size = { width: dimension(width, 'width'), height: dimension(height, 'height') };
      const scale = Number(deviceScaleFactor) > 0 && Number(deviceScaleFactor) <= 8 ? Number(deviceScaleFactor) : 1;
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
      this.#windowFor(window).channel.send('window.close');
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
      runtime.addEventListener(name, (e) => {
        const record = this.#recordOf(e.detail);
        if (!record) return;
        // A hidden tab's page events update its tab record only.
        if (!record.track(name, e.detail)) return;
        if (name === 'navigate') this.#provenanceOf(record)?.navigated(e.detail.url);
        server.emit(name, e.detail, EVENT_CAPABILITY[name], record.id);
      });
    }
    runtime.addEventListener('crash', (e) => server.emit('crash', e.detail, 'view', 1));
    return server;
  }

  #cssSize() {
    const rect = this.getBoundingClientRect();
    return { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
  }
}

customElements.define('inception-view', InceptionView);
