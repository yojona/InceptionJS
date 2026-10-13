// Windows of one engine. The engine (one wasm instance, one profile) shows
// several windows, each with its own tabs; the view is window 1. Here:
//
// - WindowChannel: commands to one window (its id stamped on each) and the
//   engine's events for it, as an EventTarget.
// - HostWindow: the host's record of a window: tabs, page state, agent,
//   display, video.
// - InceptionWindow: the embedder's handle on a window other than 1, with
//   the navigation, tab and agent surface of the view, scoped to it.
// - <inception-window view="#id" window="2">: shows a window of a view in the
//   same document.

import { Tabs } from './tabs.js';
import { ProtocolClient, createInPagePair } from './protocol.js';
import { AgentClient } from './agent.js';
import { Display } from './display.js';
import { PROVENANCE_STYLE, Provenance } from './provenance.js';

export class WindowChannel extends EventTarget {
  #runtime;

  constructor(runtime, id) {
    super();
    this.#runtime = runtime;
    this.id = id;
    // The size its display last asked for, so an engine it moves to starts
    // there.
    this.lastSize = null;
  }

  send(command, args = {}) {
    if (command === 'resize' && Number.isFinite(args.width) && Number.isFinite(args.height)) this.lastSize = { width: args.width, height: args.height, deviceScaleFactor: args.deviceScaleFactor ?? 1 };
    this.#runtime.send(command, { ...args, window: this.id });
  }

  // The window moved to another engine (isolation 'site').
  rebind(runtime) {
    this.#runtime = runtime;
  }

  sendFile(name, bytes) {
    this.#runtime.sendFile(name, bytes);
  }

  get crash() {
    return this.#runtime.crash;
  }
}

export class HostWindow {
  // `target` receives the window's DOM events (the view for window 1, an
  // InceptionWindow otherwise).
  constructor({ id, runtime, target, policy, tab, size }) {
    this.id = id;
    this.channel = new WindowChannel(runtime, id);
    this.target = target;
    this.tabs = new Tabs(target, (command, args) => this.channel.send(command, args), policy);
    if (tab) this.tabs.started(tab);
    this.state = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, zoom: 1 };
    this.security = null;
    this.size = size ?? null;
    this.visible = id === 1;
    this.agent = null;
    // The display that shows it: a Display in this document, or the host's
    // end of a display channel.
    this.display = null;
    this.media = null;
    this.closed = false;
  }

  // A page event ("navigate", "title", ...) for this window; false when it
  // belongs to a hidden tab, so the window does not report it as its own.
  track(name, detail) {
    if (!this.tabs.track(name, detail)) return false;
    if (name === 'navigate') this.state.url = detail.url;
    if (name === 'title') this.state.title = detail.title;
    if (name === 'loading') this.state.loading = detail.loading;
    if (name === 'navigation.state') {
      const { window, ...state } = detail;
      Object.assign(this.state, state);
    }
    if (name === 'zoom') this.state.zoom = detail.factor;
    if (name === 'security.state') this.security = Object.freeze({ ...detail });
    return true;
  }

  info() {
    return { window: this.id, visible: this.visible, url: this.state.url, title: this.state.title, activeTab: this.tabs.active, ...(this.size ? { width: this.size.width, height: this.size.height } : {}) };
  }
}

// What the embedder holds for a window other than 1 (view.openWindow(),
// view.windows, the "windowopen" event). It speaks the protocol to the view's
// server like the view does, bound to its own window, and re-dispatches the
// window's events: navigate, title, loading, tabcreated, tabactivated, ...,
// and "close" when the window is gone.
export class InceptionWindow extends EventTarget {
  #id;
  #record;
  #client;
  #ready;
  #agent;
  #serve;

  // `connect(transport)` connects a protocol client to the view's server,
  // bound to this window; `serve(transport, options)` serves another one.
  // `capabilities`: what its own client negotiates.
  constructor({ id, record, connect, serve, events, capabilities, agentEnabled }) {
    super();
    this.#id = id;
    this.#record = record;
    this.#serve = serve;
    const [server, client] = createInPagePair();
    connect(server);
    this.#client = new ProtocolClient(client);
    this.#ready = this.#client.hello(capabilities, { window: id });
    for (const [name, domName] of events) this.#client.addEventListener(name, (e) => this.dispatchEvent(new CustomEvent(domName, { detail: e.detail })));
    this.#agent = agentEnabled ? new AgentClient(async (method, params) => this.#request(method, params)) : null;
  }

  async #request(method, params) {
    await this.#ready;
    return this.#client.request(method, params);
  }

  get id() { return this.#id; }
  get closed() { return this.#record.closed; }
  get url() { return this.#record.state.url; }
  get title() { return this.#record.state.title; }
  get loading() { return this.#record.state.loading; }
  get canGoBack() { return this.#record.state.canGoBack; }
  get canGoForward() { return this.#record.state.canGoForward; }
  get securityState() { return this.#record.security; }
  get visible() { return this.#record.visible; }
  get tabs() { return this.#record.tabs.list(); }
  get activeTab() { return this.#record.tabs.active; }
  get agent() { return this.#agent; }
  get control() { return this.#record.agent?.control ?? 'human'; }

  navigate(url) { return this.#request('view.navigate', { url }); }
  back() { return this.#request('view.back'); }
  forward() { return this.#request('view.forward'); }
  reload({ bypassCache = false } = {}) { return this.#request('view.reload', { bypassCache }); }
  stop() { return this.#request('view.stop'); }
  find(text, { backwards = false, caseSensitive = false } = {}) { return this.#request('view.find', { text, backwards, caseSensitive }); }
  findClear() { return this.#request('view.findClear'); }
  zoom(factor) { return this.#request('view.zoom', { factor }); }
  createTab(url = '', { activate = true } = {}) { return this.#request('view.createTab', { url: String(url), activate }); }
  activateTab(id) { return this.#request('view.activateTab', { tab: id }); }
  closeTab(id) { return this.#request('view.closeTab', { tab: id }); }
  requestControl() { return this.#request('agent.requestControl'); }
  releaseControl() { return this.#request('agent.releaseControl'); }
  // The size its pages lay out at, in CSS pixels, for a window no display
  // shows (a display sets it from its own box).
  resize(width, height, { deviceScaleFactor = 1 } = {}) { return this.#request('windows.resize', { window: this.#id, width, height, deviceScaleFactor }); }
  close() { return this.#request('windows.close', { window: this.#id }); }

  // Connects another protocol client bound to this window (see the view's
  // serve()).
  serve(transport, options) {
    return this.#serve(transport, options);
  }
}

// <inception-window view="#id" window="2">: shows window 2 of the view
// selected by `view`, in this document. It draws and takes input like the
// view; video plays under it, and the provenance badge shows as on the view.
// Window 1 is the view itself and cannot be shown here.
export const ATTACH_DISPLAY = Symbol('attachDisplay');

export class InceptionWindowElement extends HTMLElement {
  static observedAttributes = ['view', 'window'];

  #shadow;
  #display = null;
  #detach = null;
  #provenance;
  #attaching = null;
  #view = null;
  #attachedTo = null;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host { display: block; position: relative; overflow: hidden; contain: strict; width: 800px; height: 600px; outline: none; }
      canvas, .media { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
      .media { overflow: hidden; pointer-events: none; }
      textarea { position: absolute; left: 0; top: 0; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; resize: none; pointer-events: none; }
      :host([data-control="agent"])::after { content: ""; position: absolute; inset: 0; z-index: 5; pointer-events: none; box-shadow: inset 0 0 0 3px #7c3aed; }
      ${PROVENANCE_STYLE}
    </style><div class="media" part="media"></div><canvas part="screen"></canvas><textarea aria-label="Web content" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>`;
    this.#shadow = shadow;
    this.#provenance = new Provenance(shadow, this);
  }

  // The view whose window this shows, as an element (instead of the `view`
  // attribute's selector).
  get view() { return this.#view; }
  set view(element) {
    this.#view = element ?? null;
    if (this.isConnected) queueMicrotask(() => this.#attach());
  }

  get mediaLayer() { return this.#shadow.querySelector('.media'); }
  get provenance() { return this.#provenance; }

  // The Display this element is, for the view that attaches it.
  createDisplay(send) {
    this.#display = new Display({ element: this, shadow: this.#shadow, canvas: this.#shadow.querySelector('canvas'), textInput: this.#shadow.querySelector('textarea'), send });
    return this.#display;
  }

  connectedCallback() {
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
    this.#provenance.start();
    queueMicrotask(() => this.#attach());
  }

  disconnectedCallback() {
    this.#provenance.stop();
    this.#release();
  }

  attributeChangedCallback() {
    if (this.isConnected) queueMicrotask(() => this.#attach());
  }

  #release() {
    this.#detach?.();
    this.#detach = null;
    this.#display = null;
  }

  async #attach() {
    const selector = this.getAttribute('view');
    const id = Number(this.getAttribute('window'));
    const view = this.#view ?? (selector ? document.querySelector(selector) : null);
    const key = view && `${id}`;
    if (this.#attaching === key && this.#attachedTo === view && this.#detach) return;
    this.#release();
    this.#attaching = key;
    this.#attachedTo = view;
    if (!view?.[ATTACH_DISPLAY] || !Number.isInteger(id) || id < 2) return;
    try {
      await view.ready;
      if (!this.isConnected || this.#attaching !== key) return;
      this.#detach = view[ATTACH_DISPLAY](id, this);
    } catch (error) {
      this.dispatchEvent(new CustomEvent('error', { detail: { reason: String(error?.message ?? error) } }));
    }
  }
}

if (!customElements.get('inception-window')) customElements.define('inception-window', InceptionWindowElement);
