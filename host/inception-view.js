import { attachInput } from './input.js';
import { MediaHost, probeMediaCapabilities } from './media.js';
import { EngineRuntime } from './runtime.js';
import { ProtocolClient, ProtocolServer, createInPagePair } from './protocol.js';

const config = { engineUrl: null, wispUrl: null, storage: null, policy: null };

export const Inception = {
  // engineUrl: URL of inception-engine.js; wispUrl: the Wisp relay (ws:// or wss://).
  configure(options) {
    Object.assign(config, options);
  },
};

// Events the engine reports that the view re-dispatches as DOM events.
const VIEW_EVENTS = ['navigate', 'title', 'loading', 'popup', 'console', 'crash'];

// <inception-view src gpu="auto|on|off" muted media profile>
//
// A thin client: it speaks the protocol to a server bound to its own engine,
// exactly as a remote agent would. `serve(transport)` connects more clients.
export class InceptionView extends HTMLElement {
  static observedAttributes = ['src'];

  #runtime = null;
  #server = null;
  #client = null;
  #canvas;
  #mediaLayer;
  #media = null;
  #debugRequests = 0;
  #ready = null;
  #state = { url: '', title: '', loading: false };

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host { display: block; position: relative; overflow: hidden; contain: strict; width: 800px; height: 600px; outline: none; }
      canvas, .media { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
      .media { overflow: hidden; pointer-events: none; }
    </style><div class="media" part="media"></div><canvas part="screen"></canvas>`;
    this.#canvas = shadow.querySelector('canvas');
    this.#mediaLayer = shadow.querySelector('.media');
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
  }

  get url() { return this.#state.url; }
  get title() { return this.#state.title; }
  get loading() { return this.#state.loading; }
  get ready() { return this.#ready ??= this.#start(); }

  connectedCallback() {
    // Deferred so a page can define the element and configure it in the same
    // script, in either order.
    queueMicrotask(() => this.ready.catch((error) => this.dispatchEvent(new CustomEvent('crash', { detail: { reason: String(error?.message ?? error) } }))));
  }

  attributeChangedCallback(name, previous, value) {
    if (name === 'src' && value && value !== previous && this.#client) this.navigate(value);
  }

  async navigate(url) {
    await this.ready;
    return this.#client.request('view.navigate', { url });
  }

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

  serve(transport) {
    return this.#server.connect(transport);
  }

  async #start() {
    if (!config.engineUrl) throw new Error('Inception.configure({engineUrl, wispUrl}) first');
    this.#runtime = new EngineRuntime({ engineUrl: config.engineUrl, wispUrl: config.wispUrl, canvas: this.#canvas });
    this.#server = this.#createServer();
    const [serverSide, clientSide] = createInPagePair();
    this.#server.connect(serverSide);
    this.#client = new ProtocolClient(clientSide);
    for (const name of VIEW_EVENTS)
      this.#client.addEventListener(name, (e) => this.dispatchEvent(new CustomEvent(name, { detail: e.detail })));

    // Videos play in the host page, under the canvas (host/media.js).
    // `autoplay-sound`: the embedder knows playback with sound is allowed here.
    const soundAllowed = this.hasAttribute('autoplay-sound') || config.policy?.autoplaySound === true;
    this.#media = new MediaHost(this.#mediaLayer, (command, args) => this.#runtime.send(command, args), { soundAllowed });
    this.#runtime.onEngineEvent = (name, data) => {
      if (name.startsWith('media.')) this.#media.handleEvent(name, data);
    };
    this.#runtime.onMediaAppend = ({ id, sb, bytes }) => this.#media.append(id, sb, bytes);
    // Activation is sticky for the host page's lifetime: the first gesture
    // anywhere in it lets every later video play with sound.
    const gesture = () => this.#media.userGesture();
    for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, gesture, { capture: true });

    const engineReady = new Promise((resolve) => this.#runtime.addEventListener('ready', (e) => resolve(e.detail), { once: true }));
    await this.#runtime.start();
    await this.#client.hello();

    const { width, height } = this.#cssSize();
    const gpu = this.getAttribute('gpu') ?? 'auto';
    this.#runtime.send('init', { width, height, deviceScaleFactor: devicePixelRatio, gpu: gpu !== 'off', media: probeMediaCapabilities(), url: this.getAttribute('src') ?? '' });
    const ready = await engineReady;
    if (gpu === 'on' && ready.renderer !== 'gpu') throw new Error('gpu="on" but WebGL2 is unavailable in the engine worker');
    this.dataset.renderer = ready.renderer;
    attachInput(this, this.#canvas, (command, args) => this.#runtime.send(command, args));
    if (document.activeElement === this) this.#runtime.send('focus', { focused: true });

    new ResizeObserver(() => {
      const size = this.#cssSize();
      this.#runtime.send('resize', { ...size, deviceScaleFactor: devicePixelRatio });
    }).observe(this);
    return ready;
  }

  #createServer() {
    const server = new ProtocolServer(['view']);
    const runtime = this.#runtime;
    server.handle('view.navigate', ({ url }) => {
      if (typeof url !== 'string' || !url) throw new TypeError('url must be a non-empty string');
      runtime.send('load', { url });
    });
    server.handle('view.state', () => ({ ...this.#state }));
    for (const name of VIEW_EVENTS) {
      runtime.addEventListener(name, (e) => {
        if (name === 'navigate') this.#state.url = e.detail.url;
        if (name === 'title') this.#state.title = e.detail.title;
        if (name === 'loading') this.#state.loading = e.detail.loading;
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
