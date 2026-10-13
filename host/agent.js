// The agent namespace: what a language-model agent uses to read and drive a
// view, offered only when the embedder enables it. Reads come from the
// engine's accessibility tree and actions go through the engine's own input
// path (engine/agent/Agent.cpp); no script ever runs in the page for either.
//
// Around every action: shared control (the agent acts only while it holds
// control, and any input from the person takes it back), a risk class and the
// embedder's policy, a rate limit, and an entry in the action log.
//
//   Inception.configure({ agent: {
//     policy: async ({ action, risk, url, pageUrl, target }) => true,
//     maxActionsPerMinute: 120,
//     onAction: (entry) => {},
//   } })

import { ProtocolError } from './protocol.js';
import { diffSnapshots, dropLabelEchoes, findNodes, formatMarkdown, formatText, inViewport, neutralize, sanitize, wrapUntrusted } from './agent-snapshot.js';

// From least to most consequential. 'interact' is input that stays in the
// page (typing into an ordinary field, choosing an option, scrolling).
export const RISKS = Object.freeze(['read', 'interact', 'navigate', 'submit', 'download', 'login', 'payment']);
const rank = (risk) => RISKS.indexOf(risk);
const higher = (a, b) => (rank(b) > rank(a) ? b : a);

// Allowed without a policy callback. The rest need one that says yes.
const ALLOWED_BY_DEFAULT = new Set(['read', 'interact', 'navigate', 'control']);

// An approval also covers the plain submission the same form makes.
const COVERED = { login: ['login', 'submit'], payment: ['payment', 'submit'] };

// Input from the person: any of these takes control back from the agent.
const HUMAN_COMMANDS = new Set(['key', 'wheel', 'ime.set', 'ime.commit', 'edit', 'clipboard.set', 'select.choose']);

// How recent the person's last input must be for it to keep the agent out.
const HUMAN_GRACE_MS = 1500;
const LOG_LIMIT = 1000;
const ENGINE_TIMEOUT_MS = 20000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (reason, message, data) => ProtocolError.fromReason(reason, message, data);

export const AGENT_STYLE = `
  :host([data-control="agent"])::after { content: ""; position: absolute; inset: 0; z-index: 5; pointer-events: none;
    box-shadow: inset 0 0 0 3px #7c3aed; }
  .agent-indicator { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 6; display: none;
    padding: 4px 12px; border-radius: 999px; background: #7c3aed; color: #fff; font: 500 12px/1.6 system-ui, sans-serif;
    cursor: pointer; white-space: nowrap; box-shadow: 0 2px 8px #0003; }
  :host([data-control="agent"]) .agent-indicator { display: block; }
`;

export class AgentHost {
  #element;
  #runtime;
  #server;
  #options;
  #state;
  #requests = 0;
  #pending = new Map();
  #control = 'human';
  #lastHumanInput = -Infinity;
  #log = [];
  #sequence = 0;
  #recent = [];
  #snapshot = null;
  // What snapshot({diff}) and an action's `changes` compare against: the last
  // snapshot the agent asked for, or the state after its last action.
  #baseline = null;
  #navigations = 0;
  #indicator;

  // `options()` returns the embedder's agent options; `state()` the view's
  // {url, title, ...}; `captureFrame()` the last frame as a canvas.
  constructor({ element, runtime, server, shadow, options, state, captureFrame }) {
    this.#element = element;
    this.#runtime = runtime;
    this.#server = server;
    this.#options = options;
    this.#state = state;
    this.captureFrame = captureFrame;
    runtime.addEventListener('agent.result', (e) => {
      const pending = this.#pending.get(e.detail.id);
      if (!pending) return;
      this.#pending.delete(e.detail.id);
      pending.resolve(e.detail);
    });
    runtime.addEventListener('agent.blocked', (e) => {
      const entry = this.#record({ action: e.detail.action, params: { url: e.detail.url }, risk: e.detail.risk, decision: 'denied', outcome: 'blocked', error: 'blocked_by_engine', url: e.detail.url });
      this.#emit('agent.blocked', { ...e.detail, entry }, 'agent');
    });
    runtime.addEventListener('navigate', () => this.#navigations++);
    runtime.addEventListener('crash', () => {
      for (const pending of this.#pending.values()) pending.reject(fail('engine_crashed', 'the engine crashed'));
      this.#pending.clear();
    });
    const style = document.createElement('style');
    style.textContent = AGENT_STYLE;
    this.#indicator = Object.assign(document.createElement('div'), { className: 'agent-indicator', textContent: 'An agent is in control. Click or type to take over.' });
    this.#indicator.setAttribute('part', 'agent-indicator');
    this.#indicator.setAttribute('role', 'status');
    this.#indicator.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.takeBack('indicator');
    });
    shadow.append(style, this.#indicator);
    this.#register(server);
  }

  get control() {
    return this.#control;
  }

  // Wraps the host's input sender: input from the person takes control back
  // before it reaches the page.
  watchInput(send) {
    return (command, args) => {
      if (HUMAN_COMMANDS.has(command) || (command === 'mouse' && args?.type === 'down')) this.takeBack('input');
      send(command, args);
    };
  }

  takeBack(reason) {
    this.#lastHumanInput = performance.now();
    if (this.#control === 'human') return;
    this.#setControl('human', reason);
  }

  #setControl(control, reason) {
    this.#control = control;
    this.#runtime.send('agent.control', { agent: control === 'agent' });
    if (control === 'agent') this.#element.dataset.control = 'agent';
    else delete this.#element.dataset.control;
    this.#record({ action: 'control', params: { control, reason }, risk: 'read', decision: 'allowed', outcome: 'ok' });
    this.#emit('control', { control, reason }, 'view');
  }

  #emit(name, data, capability) {
    this.#server.emit(name, data, capability);
  }

  log() {
    return this.#log.map((entry) => ({ ...entry }));
  }

  #record(entry) {
    const full = { seq: ++this.#sequence, time: new Date().toISOString(), url: this.#state().url, ...entry };
    this.#log.push(full);
    if (this.#log.length > LOG_LIMIT) this.#log.shift();
    try {
      this.#options().onAction?.({ ...full });
    } catch (error) {
      console.error('[inception] agent onAction failed', error);
    }
    this.#emit('agent.action', full, 'agent');
    return full;
  }

  // --- engine requests ------------------------------------------------------

  #engine(command, args = {}) {
    if (this.#runtime.crash) return Promise.reject(fail('engine_crashed', 'the engine crashed'));
    const id = ++this.#requests;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(fail('timeout', `the engine did not answer ${command}`));
      }, ENGINE_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          if (result.error) reject(fail(result.error.code, result.error.message, Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'error' && key !== 'id'))));
          else resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#runtime.send(command, { ...args, id });
    });
  }

  // --- policy ---------------------------------------------------------------

  async #decide(request) {
    const policy = this.#options().policy;
    if (typeof policy !== 'function') return ALLOWED_BY_DEFAULT.has(request.risk) || ALLOWED_BY_DEFAULT.has(request.action);
    try {
      const verdict = await policy(Object.freeze({ ...request }));
      return verdict === true || verdict === 'allow';
    } catch (error) {
      console.error('[inception] agent policy failed; denying', error);
      return false;
    }
  }

  #requireControl() {
    if (this.#control !== 'agent') throw fail('control_held', 'the person has control of the view; call requestControl() first');
  }

  #rateLimit() {
    const limit = this.#options().maxActionsPerMinute ?? 120;
    const now = performance.now();
    this.#recent = this.#recent.filter((time) => now - time < 60000);
    if (this.#recent.length >= limit) throw fail('rate_limited', `more than ${limit} actions in a minute`);
    this.#recent.push(now);
  }

  // Runs one acting method: control, rate limit, risk, policy, the action
  // itself, and its log entry.
  async #perform(action, params, risk, target, run) {
    const started = performance.now();
    const pageUrl = this.#state().url;
    const request = { action, risk, url: target?.link ?? params.url ?? pageUrl, pageUrl };
    if (target) request.target = { ref: target.ref, tag: target.tag, field: target.field, link: target.link };
    const logged = { action, params: redact(action, params, target), risk };
    let allowed = false;
    try {
      this.#requireControl();
      this.#rateLimit();
      allowed = await this.#decide(request);
      if (!allowed) throw fail('denied_by_policy', `the embedder's policy did not allow this ${risk} action`, { risk, action });
      // The person may have taken control back while the policy was asking.
      this.#requireControl();
      const result = await run(COVERED[risk] ?? [risk]);
      this.#record({ ...logged, decision: 'allowed', outcome: 'ok', ms: Math.round(performance.now() - started) });
      return result;
    } catch (error) {
      this.#record({ ...logged, decision: allowed ? 'allowed' : 'denied', outcome: 'error', error: error.reason ?? String(error.message ?? error), ms: Math.round(performance.now() - started) });
      throw error;
    }
  }

  // Waits for what an action set off: navigations to commit, loads to finish.
  async #settle(timeoutMs = 3000) {
    const started = performance.now();
    await sleep(60);
    let quiet = 0;
    while (performance.now() - started < timeoutMs) {
      const probe = await this.#engine('agent.probe');
      quiet = !probe.loading && probe.loads === 0 ? quiet + 1 : 0;
      if (quiet >= 2) return true;
      await sleep(100);
    }
    return false;
  }

  async #afterAction(result, { diff = true, settleMs } = {}) {
    const navigationsBefore = result.navigationsBefore;
    const settled = await this.#settle(settleMs);
    const state = this.#state();
    const outcome = { ok: true, ...result.engine, url: state.url, title: state.title, navigated: this.#navigations > navigationsBefore, settled };
    if (diff && this.#baseline && !outcome.navigated) {
      const next = await this.#takeSnapshot({});
      outcome.changes = diffSnapshots(this.#baseline.nodes, next.nodes).text;
      this.#baseline = next;
    }
    return outcome;
  }

  // --- reading --------------------------------------------------------------

  async #takeSnapshot({ maxNodes }) {
    const result = await this.#engine('agent.snapshot', maxNodes ? { maxNodes } : {});
    result.nodes = dropLabelEchoes(result.nodes);
    const suspicious = sanitize(result.nodes);
    const snapshot = { ...result, suspicious, title: neutralize(result.title) };
    this.#snapshot = snapshot;
    return snapshot;
  }

  async snapshot({ mode = 'accessibility', format = 'text', diff = false, maxTokens, maxNodes, scope = 'page' } = {}) {
    if (mode !== 'accessibility') throw fail('unsupported_mode', `unknown snapshot mode "${mode}"; the shipped mode is "accessibility"`);
    if (!['text', 'tree'].includes(format)) throw fail('invalid_params', 'format is "text" or "tree"');
    const previous = this.#baseline;
    const snapshot = await this.#takeSnapshot({ maxNodes });
    this.#baseline = snapshot;
    const nodes = scope === 'viewport' ? inViewport(snapshot.nodes, snapshot.viewport) : snapshot.nodes;
    this.#record({ action: 'snapshot', params: { format, diff, scope }, risk: 'read', decision: 'allowed', outcome: 'ok' });
    const base = { mode, format, untrusted: true, url: snapshot.url, title: snapshot.title, viewport: snapshot.viewport, count: snapshot.count, truncated: snapshot.truncated, suspicious: snapshot.suspicious };
    if (diff && previous) {
      const changes = diffSnapshots(previous.nodes, snapshot.nodes);
      return format === 'tree' ? { ...base, diff: changes } : { ...base, text: wrapUntrusted(changes.text, snapshot) };
    }
    if (format === 'tree') return { ...base, nodes };
    const { text, omitted } = formatText(nodes, { maxTokens });
    return { ...base, omitted, text: wrapUntrusted(text, snapshot) };
  }

  async find({ role, name, text, interactive, limit } = {}) {
    const snapshot = await this.#takeSnapshot({});
    this.#record({ action: 'find', params: { role, name, text }, risk: 'read', decision: 'allowed', outcome: 'ok' });
    return { untrusted: true, url: snapshot.url, matches: findNodes(snapshot.nodes, { role, name, text, interactive, limit }) };
  }

  async extract({ kind = 'text', maxLength } = {}) {
    let result;
    if (kind === 'markdown') {
      const snapshot = await this.#takeSnapshot({});
      result = { url: snapshot.url, title: snapshot.title, markdown: wrapUntrusted(formatMarkdown(snapshot.nodes), snapshot) };
    } else {
      if (!['text', 'links', 'forms', 'tables'].includes(kind)) throw fail('invalid_params', `unknown kind "${kind}"`);
      result = await this.#engine('agent.extract', { kind, ...(maxLength ? { maxLength } : {}) });
      delete result.id;
      result = clean(result);
      if (kind === 'text') result.text = wrapUntrusted(result.text, result);
    }
    this.#record({ action: 'extract', params: { kind }, risk: 'read', decision: 'allowed', outcome: 'ok' });
    return { kind, untrusted: true, ...result };
  }

  async waitFor({ text, ref, selector, url, navigation = false, networkIdle = false, state = 'visible', timeoutMs = 10000 } = {}) {
    const started = performance.now();
    const navigationsBefore = this.#navigations;
    const probeArgs = { ...(text ? { text: String(text) } : {}), ...(ref ? { ref: String(ref) } : {}), ...(selector ? { selector: String(selector) } : {}) };
    let quiet = 0;
    for (;;) {
      const probe = await this.#engine('agent.probe', probeArgs);
      if (probe.ref === 'unknown') throw fail('no_such_ref', `unknown ref ${ref}`);
      const idle = !probe.loading && probe.loads === 0;
      quiet = idle ? quiet + 1 : 0;
      const met = (!text || probe.text)
        && (!ref || matchesState(probe.ref, state))
        && (!selector || matchesState(probe.selector, state))
        && (!url || String(probe.url).includes(String(url)))
        && (!navigation || this.#navigations > navigationsBefore)
        && (!networkIdle || quiet >= 3);
      if (met) {
        this.#record({ action: 'waitFor', params: { text, ref, selector, url, navigation, networkIdle, state }, risk: 'read', decision: 'allowed', outcome: 'ok' });
        return { ok: true, url: probe.url, elapsedMs: Math.round(performance.now() - started), ...(probe.selectorRef ? { ref: probe.selectorRef } : {}) };
      }
      if (performance.now() - started > timeoutMs) throw fail('timeout', `waitFor did not succeed within ${timeoutMs} ms`);
      await sleep(150);
    }
  }

  async screenshot({ annotate = false, type = 'image/png', quality } = {}) {
    const frame = this.captureFrame();
    if (!frame?.width) throw fail('not_ready', 'no frame has been drawn yet');
    const canvas = new OffscreenCanvas(frame.width, frame.height);
    const context = canvas.getContext('2d');
    context.drawImage(frame, 0, 0);
    if (annotate) {
      const snapshot = await this.#takeSnapshot({});
      const scale = frame.width / (snapshot.viewport.width || frame.width);
      drawRefs(context, snapshot.nodes, scale);
    }
    const blob = await canvas.convertToBlob({ type, quality });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    this.#record({ action: 'screenshot', params: { annotate }, risk: 'read', decision: 'allowed', outcome: 'ok' });
    return { mimeType: blob.type, width: frame.width, height: frame.height, data: btoa(binary) };
  }

  // --- acting ---------------------------------------------------------------

  async requestControl() {
    if (this.#control === 'agent') return { control: 'agent' };
    if (performance.now() - this.#lastHumanInput < HUMAN_GRACE_MS) throw fail('control_held', 'the person is using the view');
    const allowed = await this.#decide({ action: 'control', risk: 'read', url: this.#state().url, pageUrl: this.#state().url });
    if (!allowed) throw fail('denied_by_policy', "the embedder's policy did not hand control to the agent", { action: 'control' });
    this.#setControl('agent', 'request');
    return { control: 'agent' };
  }

  releaseControl() {
    if (this.#control === 'agent') this.#setControl('human', 'release');
    return { control: 'human' };
  }

  async #describe(ref, point) {
    if (point) return this.#engine('agent.describe', { x: Math.round(point.x), y: Math.round(point.y) });
    return this.#engine('agent.describe', ref ? { ref: String(ref) } : {});
  }

  async act(params = {}) {
    const { action, ref } = params;
    switch (action) {
      case 'click':
      case 'hover':
      case 'scroll':
      case 'select':
      case 'type':
      case 'fill':
      case 'press':
        break;
      default:
        throw fail('invalid_params', `unknown action "${action}"`);
    }
    if (ref !== undefined && typeof ref !== 'string') throw fail('invalid_params', 'ref must be a string');
    if ((action === 'select' || action === 'hover') && !ref) throw fail('invalid_params', `${action} needs a ref`);
    if (action === 'click' && !ref && !(Number.isFinite(params.x) && Number.isFinite(params.y))) throw fail('invalid_params', 'click needs a ref, or x and y');
    // Reading the target decides the risk; it needs nothing but a ref.
    const target = action === 'scroll' && !ref ? null : await this.#describe(ref, action === 'click' && !ref ? params : null);
    const risk = declared(classify(action, params, target), params.risk);
    return this.#perform(action, params, risk, target, async (allow) => {
      const navigationsBefore = this.#navigations;
      // Without a snapshot to compare with, take one, so the result can say
      // what the action changed.
      if (params.diff !== false && !this.#baseline) this.#baseline = await this.#takeSnapshot({});
      const args = { action, allow };
      for (const key of ['ref', 'text', 'value', 'key', 'deltaX', 'deltaY']) if (params[key] !== undefined) args[key] = params[key];
      for (const key of ['x', 'y']) if (Number.isFinite(params[key])) args[key] = Math.round(params[key]);
      const engine = await this.#engine('agent.act', args);
      delete engine.id;
      return this.#afterAction({ engine: { action, risk, ...engine }, navigationsBefore }, params);
    });
  }

  async navigate({ url } = {}) {
    if (typeof url !== 'string' || !url) throw fail('invalid_params', 'url must be a non-empty string');
    // A page (or text it put in front of the agent) must not get script, data
    // or file addresses opened for it.
    if (!/^(https?:\/\/|about:blank$)/i.test(url.trim())) throw fail('invalid_params', 'agents navigate to http(s) addresses only');
    return this.#perform('navigate', { url }, 'navigate', null, async () => {
      const navigationsBefore = this.#navigations;
      this.#runtime.send('load', { url });
      return this.#afterAction({ engine: { action: 'navigate' }, navigationsBefore }, { diff: false, settleMs: 15000 });
    });
  }

  async history({ direction } = {}) {
    if (!['back', 'forward', 'reload'].includes(direction)) throw fail('invalid_params', 'direction is "back", "forward" or "reload"');
    return this.#perform(direction, {}, 'navigate', null, async () => {
      const navigationsBefore = this.#navigations;
      this.#runtime.send(direction);
      return this.#afterAction({ engine: { action: direction }, navigationsBefore }, { diff: false, settleMs: 15000 });
    });
  }

  #register(server) {
    const methods = {
      'agent.snapshot': (p) => this.snapshot(p),
      'agent.find': (p) => this.find(p),
      'agent.extract': (p) => this.extract(p),
      'agent.waitFor': (p) => this.waitFor(p),
      'agent.screenshot': (p) => this.screenshot(p),
      'agent.act': (p) => this.act(p),
      'agent.navigate': (p) => this.navigate(p),
      'agent.history': (p) => this.history(p),
      'agent.requestControl': () => this.requestControl(),
      'agent.releaseControl': () => this.releaseControl(),
      'agent.control': () => ({ control: this.#control }),
      'agent.log': () => this.log(),
    };
    for (const [name, fn] of Object.entries(methods)) server.handle(name, (params) => fn(params ?? {}));
  }
}

// What an action risks, from what the engine says about its target.
export function classify(action, params, target) {
  if (!target) return 'interact';
  let risk = 'interact';
  const pressesTarget = action === 'press' && /^(Enter|Space| )$/i.test(String(params.key ?? ''));
  if (action === 'click' || pressesTarget) {
    if (target.link) risk = target.download ? 'download' : 'navigate';
    // A submit button outside any form submits nothing.
    if (target.submits && target.formRisk) risk = higher(risk, target.formRisk);
  }
  if (action === 'press' && /^Enter$/i.test(String(params.key ?? '')) && target.editable && target.formRisk) risk = higher(risk, target.formRisk);
  if (action === 'type' || action === 'fill') {
    if (target.field === 'password') risk = 'login';
    if (target.field === 'payment') risk = 'payment';
    if (String(params.text ?? '').includes('\n') && target.formRisk) risk = higher(risk, target.formRisk);
  }
  // A filled password or card field in the page: any click or Enter may send it.
  if ((action === 'click' || action === 'press') && target.secrets) risk = higher(risk, target.secrets === 'payment' ? 'payment' : 'login');
  return risk;
}

// An agent may declare a higher risk for an action it expects to submit (a
// button whose script sends a form), so the approval covers it.
function declared(risk, expected) {
  return RISKS.includes(expected) ? higher(risk, expected) : risk;
}

function matchesState(presence, state) {
  if (state === 'detached') return presence === 'missing';
  if (state === 'attached') return presence === 'attached' || presence === 'visible';
  return presence === 'visible';
}

// The log never holds what was typed into a secret field.
function redact(action, params, target) {
  const copy = { ...params };
  if ((action === 'type' || action === 'fill') && target?.field && copy.text !== undefined) copy.text = `(${String(copy.text).length} characters, ${target.field} field)`;
  return copy;
}

// Neutralizes the page's strings in an extract result.
function clean(value) {
  if (typeof value === 'string') return neutralize(value);
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
  return value;
}

function drawRefs(context, nodes, scale) {
  const boxes = [];
  const visit = (list) => {
    for (const node of list ?? []) {
      if (node.interactive && node.ref && node.box?.[2] > 0 && node.box?.[3] > 0) boxes.push(node);
      visit(node.children);
    }
  };
  visit(nodes);
  context.lineWidth = Math.max(1, scale);
  context.font = `${Math.round(11 * scale)}px system-ui, sans-serif`;
  context.textBaseline = 'top';
  for (const node of boxes) {
    const [x, y, w, h] = node.box.map((v) => v * scale);
    context.strokeStyle = '#7c3aed';
    context.strokeRect(x, y, w, h);
    const label = node.ref;
    const width = context.measureText(label).width + 6 * scale;
    context.fillStyle = '#7c3aed';
    context.fillRect(x, Math.max(0, y - 14 * scale), width, 14 * scale);
    context.fillStyle = '#fff';
    context.fillText(label, x + 3 * scale, Math.max(0, y - 14 * scale) + scale);
  }
}

// The agent namespace as the view exposes it: thin calls over the protocol,
// the same ones a remote agent makes.
export class AgentClient {
  #request;
  constructor(request) {
    this.#request = request;
  }

  snapshot(options = {}) { return this.#request('agent.snapshot', options); }
  find(query = {}) { return this.#request('agent.find', query); }
  extract(options = {}) { return this.#request('agent.extract', typeof options === 'string' ? { kind: options } : options); }
  waitFor(condition = {}) { return this.#request('agent.waitFor', condition); }
  screenshot(options = {}) { return this.#request('agent.screenshot', options); }
  act(action) { return this.#request('agent.act', action); }
  click(target) { return this.act({ action: 'click', ...target }); }
  hover(ref) { return this.act({ action: 'hover', ref }); }
  type(ref, text, options = {}) { return this.act({ action: 'type', ref, text, ...options }); }
  fill(ref, text, options = {}) { return this.act({ action: 'fill', ref, text, ...options }); }
  press(key, options = {}) { return this.act({ action: 'press', key, ...options }); }
  select(ref, value, options = {}) { return this.act({ action: 'select', ref, value, ...options }); }
  scroll(options = {}) { return this.act({ action: 'scroll', ...options }); }
  navigate(url) { return this.#request('agent.navigate', { url }); }
  back() { return this.#request('agent.history', { direction: 'back' }); }
  forward() { return this.#request('agent.history', { direction: 'forward' }); }
  reload() { return this.#request('agent.history', { direction: 'reload' }); }
  requestControl() { return this.#request('agent.requestControl'); }
  releaseControl() { return this.#request('agent.releaseControl'); }
  log() { return this.#request('agent.log'); }
}
