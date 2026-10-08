import { attachInput, writeClipboard } from './input.js';
import { SelectMenu, answerDialog, chooseFiles } from './ui.js';
import { Preferences } from './preferences.js';
import { defaultUserAgent } from './identity.js';
import { PROVENANCE_STYLE, Provenance } from './provenance.js';
import { MediaHost, probeMediaCapabilities } from './media.js';
import { EncryptedMedia } from './eme.js';
import { AudioHost } from './audio.js';
import { Modules } from './modules.js';
import { Downloads } from './downloads.js';
import { EngineRuntime } from './runtime.js';
import { WasmTranslator } from './wasm-translator.js';
import { ProtocolClient, ProtocolServer, createInPagePair } from './protocol.js';

const config = { engineUrl: null, wispUrl: null, binaryenUrl: null, storage: null, policy: null, webglContexts: 0, modules: {} };
let translator = null;

export const Inception = {
  // engineUrl: URL of inception-engine.js; wispUrl: the Wisp relay (ws:// or
  // wss://); binaryenUrl: binaryen.js, loaded when a page first uses WebAssembly;
  // webglContexts: how many WebGL contexts pages may hold (default: derived
  // from the browser's renderer); modules: what pages get for geolocation and
  // notifications (host/modules.js).
  configure(options) {
    Object.assign(config, options);
  },
};

// Events the engine reports that the view re-dispatches as DOM events.
const VIEW_EVENTS = ['navigate', 'title', 'loading', 'popup', 'console', 'crash', 'cursor', 'navigation.state', 'find.result', 'zoom', 'contextmenu'];
// Names the view dispatches them under where the engine's would clash with
// the element's own DOM events.
const DOM_EVENT_NAMES = { contextmenu: 'contextmenurequest', 'navigation.state': 'navigationstate', 'find.result': 'findresult' };

// <inception-view src gpu="auto|on|off" muted media profile fresh-profile user-agent
//                 provenance-corner>
//
// A thin client: it speaks the protocol to a server bound to its own engine,
// exactly as a remote agent would. `serve(transport)` connects more clients.
export class InceptionView extends HTMLElement {
  static observedAttributes = ['src', 'provenance-corner'];

  #runtime = null;
  #server = null;
  #client = null;
  #canvas;
  #mediaLayer;
  #textInput;
  #shadow;
  #selectMenu = null;
  #provenance;
  #preferences = new Preferences((changed) => this.#runtime?.send('preferences', changed));
  #media = null;
  #debugRequests = 0;
  #ready = null;
  #state = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, zoom: 1 };

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host { display: block; position: relative; overflow: hidden; contain: strict; width: 800px; height: 600px; outline: none; }
      canvas, .media { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
      .media { overflow: hidden; pointer-events: none; }
      textarea { position: absolute; left: 0; top: 0; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; resize: none; pointer-events: none; }
      ${PROVENANCE_STYLE}
    </style><div class="media" part="media"></div><canvas part="screen"></canvas><textarea aria-label="Contenido web" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>`;
    this.#canvas = shadow.querySelector('canvas');
    this.#mediaLayer = shadow.querySelector('.media');
    this.#textInput = shadow.querySelector('textarea');
    this.#shadow = shadow;
    this.#provenance = new Provenance(shadow, this);
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
  }

  get url() { return this.#state.url; }
  get title() { return this.#state.title; }
  get loading() { return this.#state.loading; }
  get canGoBack() { return this.#state.canGoBack; }
  get canGoForward() { return this.#state.canGoForward; }
  get ready() { return this.#ready ??= this.#start(); }

  // See host/preferences.js. Setting merges: {colorScheme: 'dark'} keeps the
  // other fields; a field set to 'auto' follows the host again.
  get preferences() { return this.#preferences.settings; }
  set preferences(values) { this.#preferences.set(values); }

  connectedCallback() {
    // Deferred so a page can define the element and configure it in the same
    // script, in either order.
    queueMicrotask(() => this.ready.catch((error) => this.dispatchEvent(new CustomEvent('crash', { detail: { reason: String(error?.message ?? error) } }))));
  }

  attributeChangedCallback(name, previous, value) {
    if (name === 'src' && value && value !== previous && this.#client) this.navigate(value);
    if (name === 'provenance-corner') this.#provenance.setCorner(value);
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
  async deleteHistory(range) { await this.ready; return this.#client.request('history.delete', range); }

  // Development aid: evaluates script in the engine's main frame.
  async debugEvaluate(source) {
    await this.ready;
    const id = ++this.#debugRequests;
    return new Promise((resolve) => {
      const listener = (e) => {
        if (e.detail.id !== id) return;
        this.#runtime.removeEventListener('debug.result', listener);
        resolve(e.detail.value);
      };
      this.#runtime.addEventListener('debug.result', listener);
      this.#runtime.send('debug.evaluate', { id, source });
    });
  }

  // Development aid: sends a raw engine command.
  // JS heap and wasm memory sizes, in bytes.
  async debugHeap() {
    await this.ready;
    const reply = new Promise((resolve) => this.#runtime.addEventListener('debug.heap', (e) => resolve(e.detail), { once: true }));
    this.#runtime.send('debug.heap');
    return reply;
  }

  async debugCommand(command, args = {}) {
    await this.ready;
    this.#runtime.send(command, args);
  }

  serve(transport) {
    return this.#server.connect(transport);
  }

  async #start() {
    if (!config.engineUrl) throw new Error('Inception.configure({engineUrl, wispUrl}) first');
    // A profile's files are open by one engine at a time: the second tab would
    // get read-only file handles. Held for the life of this page.
    const profile = this.getAttribute('profile') ?? config.storage?.profile ?? 'default';
    if (navigator.locks) {
      const acquired = await new Promise((resolve) => navigator.locks.request(`inception-profile:${profile}`, { ifAvailable: true }, (lock) => {
        resolve(!!lock);
        return lock ? new Promise(() => {}) : undefined;
      }));
      if (!acquired) throw new Error(`The profile "${profile}" is open in another tab or window`);
    }
    navigator.storage?.persist?.().catch(() => {});
    this.#runtime = new EngineRuntime({ engineUrl: config.engineUrl, wispUrl: config.wispUrl, canvas: this.#canvas });
    this.#server = this.#createServer();
    const [serverSide, clientSide] = createInPagePair();
    this.#server.connect(serverSide);
    this.#client = new ProtocolClient(clientSide);
    for (const name of VIEW_EVENTS)
      this.#client.addEventListener(name, (e) => this.dispatchEvent(new CustomEvent(DOM_EVENT_NAMES[name] ?? name, { detail: e.detail })));

    // Videos play in the host page, under the canvas (host/media.js).
    // `autoplay-sound`: the embedder knows playback with sound is allowed here.
    const soundAllowed = this.hasAttribute('autoplay-sound') || config.policy?.autoplaySound === true;
    const eme = new EncryptedMedia((command, args) => this.#runtime.send(command, args));
    this.#media = new MediaHost(this.#mediaLayer, (command, args) => this.#runtime.send(command, args), { soundAllowed, eme });
    const audio = new AudioHost(() => this.#runtime.memory(), { soundAllowed });
    const modules = new Modules(this, (command, args) => this.#runtime.send(command, args), config.modules);
    const downloads = new Downloads(this);
    this.#runtime.onDownloadChunk = (chunk) => downloads.chunk(chunk);
    this.#runtime.onAudioDecode = (request) => audio.decode(request, (size) => this.#runtime.malloc(size));
    this.#runtime.onEngineEvent = (name, data) => {
      if (name === 'cursor') this.#canvas.style.cursor = data.cursor;
      if (name === 'fullscreen') this.#setFullscreen(data.active);
      if (name.startsWith('media.')) this.#media.handleEvent(name, data);
      if (name.startsWith('eme.')) eme.handleEvent(name, data);
      if (name.startsWith('download.')) downloads.handleEvent(name, data);
      if (name === 'audio.open') audio.open(data);
      if (name === 'audio.close') audio.close(data);
      if (name.startsWith('permission.') || name.startsWith('geolocation.') || name.startsWith('notification.')) modules.handleEvent(name, data);
      if (name === 'select.show') this.#selectMenu.show(this, data);
      if (name === 'select.update') this.#selectMenu.update(data);
      if (name === 'select.hide') this.#selectMenu.hide(data.id);
      if (name === 'file.choose') chooseFiles(this, this.#runtime, data);
      if (name === 'field.focus') this.#provenance.fieldFocused(data.kind);
      if (name === 'clipboard.write' && config.policy?.clipboard !== false) writeClipboard(data.items);
    };
    this.#selectMenu = new SelectMenu(this.#shadow, (command, args) => this.#runtime.send(command, args));
    this.#runtime.onAsk = (question) => answerDialog(this, question);
    this.#runtime.onMediaAppend = ({ id, sb, seq, bytes }) => this.#media.append(id, sb, seq, bytes);
    translator ??= new WasmTranslator(config.binaryenUrl ?? new URL('../node_modules/binaryen/index.js', import.meta.url).href);
    this.#runtime.wasmTranslator = translator;
    const [wasmPolyfill, pageShims] = await Promise.all(['./guest-wasm.js', './page-shims.js'].map((path) => fetch(new URL(path, import.meta.url)).then((r) => r.text())));
    // Activation is sticky for the host page's lifetime: the first gesture
    // anywhere in it lets every later video play with sound.
    const gesture = () => {
      this.#media.userGesture();
      audio.userGesture();
    };
    for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, gesture, { capture: true });

    const engineReady = new Promise((resolve, reject) => {
      this.#runtime.addEventListener('ready', (e) => resolve(e.detail), { once: true });
      this.#runtime.addEventListener('crash', (e) => reject(new Error(`the engine crashed while starting: ${e.detail.message}`)), { once: true });
    });
    await this.#runtime.start();
    await this.#client.hello();

    const { width, height } = this.#cssSize();
    const gpu = this.getAttribute('gpu') ?? 'auto';
    this.#runtime.send('init', { width, height, deviceScaleFactor: devicePixelRatio, gpu: gpu !== 'off', media: await probeMediaCapabilities(), wasmPolyfill, pageShims, wispUrl: config.wispUrl, profile, freshProfile: this.hasAttribute('fresh-profile') || config.storage?.fresh === true, userAgent: this.getAttribute('user-agent') ?? config.userAgent ?? defaultUserAgent(), preferences: this.#preferences.resolved(), webglContexts: config.webglContexts | 0, url: this.getAttribute('src') ?? '' });
    const ready = await engineReady;
    this.#runtime.addEventListener('crash', (e) => this.dispatchEvent(new CustomEvent('crash', { detail: { reason: e.detail.message, stack: e.detail.stack } })));
    if (gpu === 'on' && ready.renderer !== 'gpu') throw new Error('gpu="on" but WebGL2 is unavailable in the engine worker');
    this.dataset.renderer = ready.renderer;
    attachInput(this, this.#canvas, this.#textInput, (command, args) => this.#runtime.send(command, args), { clipboard: config.policy?.clipboard !== false });
    if (document.activeElement === this) this.focusInput();

    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement !== this) this.#runtime.send('fullscreen.changed', { active: false });
      this.dispatchEvent(new CustomEvent('fullscreen', { detail: { active: document.fullscreenElement === this } }));
    });

    new ResizeObserver(() => {
      const size = this.#cssSize();
      this.#runtime.send('resize', { ...size, deviceScaleFactor: devicePixelRatio });
    }).observe(this);
    return ready;
  }

  // The page asked for fullscreen (or to leave it); the view element itself
  // goes fullscreen in the host page.
  async #setFullscreen(active) {
    try {
      if (active && document.fullscreenElement !== this) await this.requestFullscreen();
      if (!active && document.fullscreenElement === this) await document.exitFullscreen();
      if (active) this.#runtime.send('fullscreen.changed', { active: true });
    } catch (error) {
      this.#runtime.send('fullscreen.changed', { active: false, error: String(error?.message ?? error) });
    }
  }

  #createServer() {
    const server = new ProtocolServer(['view', 'history']);
    const runtime = this.#runtime;
    server.handle('view.navigate', ({ url }) => {
      if (typeof url !== 'string' || !url) throw new TypeError('url must be a non-empty string');
      runtime.send('load', { url });
    });
    server.handle('view.state', () => ({ ...this.#state }));
    server.handle('view.back', () => runtime.send('back'));
    server.handle('view.forward', () => runtime.send('forward'));
    server.handle('view.reload', ({ bypassCache } = {}) => runtime.send('reload', { bypassCache: !!bypassCache }));
    server.handle('view.stop', () => runtime.send('stop'));
    server.handle('view.find', ({ text, backwards, caseSensitive } = {}) => new Promise((resolve) => {
      runtime.addEventListener('find.result', (e) => resolve({ found: e.detail.found, matches: e.detail.matches }), { once: true });
      runtime.send('find', { text: String(text ?? ''), backwards: !!backwards, caseSensitive: !!caseSensitive });
    }));
    server.handle('view.findClear', () => runtime.send('find.clear'));
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
    server.handle('view.zoom', ({ factor } = {}) => {
      if (!(factor > 0)) throw new TypeError('factor must be a positive number');
      runtime.send('zoom', { factor });
    });
    for (const name of VIEW_EVENTS) {
      runtime.addEventListener(name, (e) => {
        if (name === 'navigate') {
          this.#state.url = e.detail.url;
          this.#provenance.navigated(e.detail.url);
        }
        if (name === 'title') this.#state.title = e.detail.title;
        if (name === 'loading') this.#state.loading = e.detail.loading;
        if (name === 'navigation.state') Object.assign(this.#state, e.detail);
        if (name === 'zoom') this.#state.zoom = e.detail.factor;
        server.emit(name, e.detail);
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
