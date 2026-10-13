// Starts one engine instance. The engine runs WebKit on a pthread worker; this
// side forwards commands to it, receives its events, and hands each window's
// frames to the display attached for that window (attachDisplay).

export const BRIDGE_VERSION = 1;

// Everything the engine sends is untrusted, a crashed or compromised engine
// included: an event is a bounded JSON text naming a short event and carrying
// an object, or it is dropped.
const MAX_EVENT_CHARS = 64 * 1024 * 1024;
const MAX_EVENT_NAME = 64;

export function parseEngineMessage(text) {
  if (typeof text !== 'string' || text.length > MAX_EVENT_CHARS) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || typeof value.event !== 'string' || !value.event || value.event.length > MAX_EVENT_NAME) return null;
  const payload = value.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data : {};
  return { event: value.event, payload };
}

// The engine's memory, in 64 KiB pages: it starts at 256 MiB and may grow to
// `maxMemoryMB` (default 2 GiB, at most the 4 GiB the engine is built for), so
// one page cannot take all of the person's memory.
const PAGE_BYTES = 64 * 1024;
const INITIAL_MEMORY_MB = 256;
export const DEFAULT_MAX_MEMORY_MB = 2048;

export function memoryLimitPages(maxMemoryMB) {
  const megabytes = Math.min(4096, Math.max(512, Math.floor(Number(maxMemoryMB) || DEFAULT_MAX_MEMORY_MB)));
  return (megabytes * 1024 * 1024) / PAGE_BYTES;
}

// A crash caused by the memory limit, told apart from the rest.
export const isOutOfMemory = (message) => /out of memory|\bOOM\b|Cannot enlarge memory|memory access out of bounds.*grow/i.test(String(message));

// The window a frame or frame request is for: a positive integer, or window
// 1 for the bare forms an engine without windows sends.
export function frameWindow(value) {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

// A sink that draws frames into a canvas with a bitmaprenderer context.
export function canvasSink(canvas) {
  let context = null;
  return {
    canvas,
    present(bitmap) {
      if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
      if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
      context ??= canvas.getContext('bitmaprenderer');
      context.transferFromImageBitmap(bitmap);
    },
  };
}

// Each window's frames go to the sink attached for it (`sink.present(bitmap)`),
// one sink per window; a later one replaces the earlier. Frames of a window
// without a sink, and anything that is not a bitmap, are dropped.
export class FrameRouter {
  #sinks = new Map();

  attach(window, sink) {
    this.#sinks.set(window, sink);
    return () => {
      if (this.#sinks.get(window) === sink) this.#sinks.delete(window);
    };
  }

  sinkOf(window) {
    return this.#sinks.get(window) ?? null;
  }

  present(window, bitmap) {
    if (!bitmap || typeof bitmap !== 'object' || typeof bitmap.close !== 'function') return false;
    const sink = this.#sinks.get(frameWindow(window));
    if (!sink) {
      bitmap.close();
      return false;
    }
    sink.present(bitmap);
    return true;
  }
}

// A document nobody looks at (a background tab) gets no animation frames, and
// its timers are slowed down. A window that another document shows must keep
// painting for that document, so its frame ticks come from a worker's timer,
// which the browser leaves alone. The native Worker, before the runtime
// replaces it while an engine starts.
const NativeWorker = globalThis.Worker;
let ticker = null;
const ticks = new Map();
let lastTick = 0;

function afterFrameInBackground(callback) {
  if (!ticker) {
    const url = URL.createObjectURL(new Blob(['onmessage = (e) => setTimeout(() => postMessage(e.data), 16);'], { type: 'text/javascript' }));
    ticker = new NativeWorker(url);
    URL.revokeObjectURL(url);
    ticker.onmessage = (e) => {
      const next = ticks.get(e.data);
      ticks.delete(e.data);
      next?.();
    };
  }
  ticks.set(++lastTick, callback);
  ticker.postMessage(lastTick);
}

// The engine's code and file system image, fetched and compiled once per
// document and shared by every engine started from the same URL: a second
// engine costs its own memory, not another compile (about 165 MB of code in
// Chromium) or another download.
const shared = new Map();

export function loadEngine(engineUrl) {
  let entry = shared.get(engineUrl);
  if (!entry) {
    const file = (name) => new URL(name, engineUrl).href;
    const fetched = (name) => fetch(file(name)).then((response) => {
      if (!response.ok) throw new Error(`could not load ${name}: HTTP ${response.status}`);
      return response;
    });
    // Streaming needs the application/wasm type, which not every server sends.
    const compile = () => fetched('inception-engine.wasm').then((response) =>
      WebAssembly.compileStreaming(response.clone()).catch(() => response.arrayBuffer().then((bytes) => WebAssembly.compile(bytes))));
    entry = {
      module: compile(),
      data: fetched('inception-engine.data').then((response) => response.arrayBuffer()),
    };
    // A failed load is retried by the next engine, not remembered.
    Promise.all([entry.module, entry.data]).catch(() => shared.delete(engineUrl));
    shared.set(engineUrl, entry);
  }
  return Promise.all([entry.module, entry.data]).then(([module, data]) => ({ module, data }));
}

// The imports a content engine must never reach: the origin-private file
// system and the relay's sockets (see engine/js/guard.js, which does the same
// in the engine's own threads).
const CONTENT_FORBIDDEN = /^(__wasmfs_opfs_|_inception_tcp_|inception_has_opfs$)/;

export function lockImports(imports) {
  for (const table of Object.values(imports)) {
    for (const [key, value] of Object.entries(table)) {
      if (typeof value === 'function' && CONTENT_FORBIDDEN.test(value.name))
        table[key] = () => { throw new Error('a content engine has no files or network of its own'); };
    }
  }
  return imports;
}

export class EngineRuntime extends EventTarget {
  #module = null;
  #worker = null;
  #frames = new FrameRouter();
  #pending = [];

  #maxMemoryMB;
  #shareCode;
  #role;

  // `canvas`, when given, shows window 1. `shareCode` (default true): start
  // from the document's one compiled module (loadEngine) instead of letting
  // the engine fetch and compile its own.
  // `role`: 'content' locks the engine out of files and the network in
  // every thread, whatever its own code tries; 'profile' or 'standalone'
  // (default) leave them.
  constructor({ engineUrl, relayUrl, canvas, maxMemoryMB, shareCode = true, role = 'standalone' }) {
    super();
    this.engineUrl = engineUrl;
    this.#maxMemoryMB = maxMemoryMB;
    this.#shareCode = shareCode;
    this.#role = role;
    this.relayUrl = relayUrl;
    if (canvas) this.attachDisplay(1, canvasSink(canvas));
  }

  // What the engine reported it speaks beyond the bridge version ("started").
  features = [];

  // Frames of `window` go to `sink.present(bitmap)` from now on; returns a
  // function that detaches the sink.
  attachDisplay(window, sink) {
    return this.#frames.attach(window, sink);
  }

  displayOf(window) {
    return this.#frames.sinkOf(window);
  }

  async start() {
    if (!crossOriginIsolated)
      throw new Error('InceptionJS needs a cross-origin isolated page (COOP: same-origin, COEP: require-corp)');
    const [{ default: createEngine }, code] = await Promise.all([import(this.engineUrl), this.#shareCode ? loadEngine(this.engineUrl) : null]);
    const started = new Promise((resolve) => this.addEventListener('started', resolve, { once: true }));
    // The engine's thread announces itself as soon as it runs, possibly before
    // the module promise settles, so listeners go on each worker as it is
    // created rather than afterwards.
    const NativeWorker = globalThis.Worker;
    const runtime = this;
    globalThis.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        // Before the engine's own first message, so the thread knows its
        // role when it instantiates the engine.
        this.postMessage({ inceptionRole: runtime.#role });
        runtime.#workers.add(this);
        this.addEventListener('message', (e) => runtime.#onWorkerMessage(this, e.data));
      }
    };
    try {
      this.#module = await createEngine({
        wasmMemory: new WebAssembly.Memory({ initial: (INITIAL_MEMORY_MB * 1024 * 1024) / PAGE_BYTES, maximum: memoryLimitPages(this.#maxMemoryMB), shared: true }),
        locateFile: (path) => new URL(path, this.engineUrl).href,
        print: (text) => console.log('[engine]', text),
        printErr: (text) => console.warn('[engine]', text),
        ...(code ? {
          instantiateWasm: (imports, receive) => {
            if (this.#role === 'content') lockImports(imports);
            WebAssembly.instantiate(code.module, imports).then((instance) => receive(instance, code.module));
            return {};
          },
          getPreloadedPackage: () => code.data,
        } : {}),
      });
    } finally {
      globalThis.Worker = NativeWorker;
    }
    // Threads the engine starts later are told their role too.
    const threads = this.#module.PThread;
    const allocate = threads?.allocateUnusedWorker;
    if (allocate) {
      threads.allocateUnusedWorker = (...args) => {
        const before = new Set(threads.unusedWorkers);
        const result = allocate.apply(threads, args);
        for (const worker of threads.unusedWorkers) {
          if (before.has(worker)) continue;
          worker.postMessage({ inceptionRole: this.#role });
          this.#workers.add(worker);
          worker.addEventListener('message', (e) => this.#onWorkerMessage(worker, e.data));
        }
        return result;
      };
    }
    await started;
  }

  send(command, args = {}) {
    this.postToEngine({ inception: JSON.stringify({ command, args }) });
  }

  // A message for the engine's thread itself (link ports, files), queued
  // until it has started.
  postToEngine(message, transfer = []) {
    if (this.#worker) this.#worker.postMessage(message, transfer);
    else this.#pending.push([message, transfer]);
  }

  // Stops every thread of the engine: what a crashed engine still holds (its
  // files' access handles, its sockets) is released.
  terminate() {
    this.#terminated = true;
    try {
      this.#module?.PThread?.terminateAllThreads?.();
    } catch {}
    for (const worker of this.#workers) worker.terminate();
    this.#workers.clear();
    this.#worker = null;
  }

  #workers = new Set();
  #terminated = false;

  #onWorkerMessage(worker, data) {
    if (!data || typeof data !== 'object' || this.#terminated) return;
    if (data.inceptionWantsFrame) {
      const window = frameWindow(data.inceptionWantsFrame);
      const tick = () => worker.postMessage({ inceptionFrameTick: window });
      // The document's own canvas paints when its page can be seen; a display
      // elsewhere paints when it asks.
      if (document.visibilityState === 'hidden' && !this.#frames.sinkOf(window)?.canvas) return afterFrameInBackground(tick);
      return requestAnimationFrame(tick);
    }
    if (data.inceptionFrame) return this.#presentBitmap(frameWindow(data.window), data.inceptionFrame);
    if (data.inceptionMediaAppend) return this.onMediaAppend?.(data.inceptionMediaAppend);
    if (data.inceptionWasm) return this.#translateWasm(data.inceptionWasm);
    if (data.inceptionPixels) return this.#presentPixels(frameWindow(data.window), data.inceptionPixels);
    if (data.inceptionCrash) return this.#crashed(data.inceptionCrash);
    if (data.inceptionAsk) return this.#answer(data.inceptionAsk);
    if (data.inceptionAudioDecode) return this.onAudioDecode?.(data.inceptionAudioDecode);
    if (data.inceptionDownload) return this.onDownloadChunk?.(data.inceptionDownload);
    const message = parseEngineMessage(data.inception);
    if (!message) return;
    const { event, payload } = message;
    if (event === 'started') {
      if (this.#worker) return;
      if (payload.version !== BRIDGE_VERSION)
        throw new Error(`engine speaks bridge v${payload.version}, host speaks v${BRIDGE_VERSION}`);
      this.#worker = worker;
      this.features = Array.isArray(payload.features) ? payload.features.filter((f) => typeof f === 'string') : [];
      for (const [message, transfer] of this.#pending.splice(0)) worker.postMessage(message, transfer);
    }
    // One handler failing on a malformed payload must not keep the rest from the event.
    try {
      this.onEngineEvent?.(event, payload);
    } catch (error) {
      console.error(`[host] could not handle the engine event "${event}"`, error);
    }
    this.dispatchEvent(new CustomEvent(event, { detail: payload }));
  }

  #crashed({ message, stack }) {
    if (this.crash) return;
    this.crash = { message, stack, ...(isOutOfMemory(message) ? { kind: 'out_of_memory' } : {}) };
    console.error(`[engine] crashed: ${message}\n${stack}`);
    this.dispatchEvent(new CustomEvent('crash', { detail: this.crash }));
  }

  // The engine thread is blocked on `slot` until the reply is written.
  async #translateWasm({ bytes, length, slot }) {
    const input = new Uint8Array(this.#module.wasmMemory.buffer, bytes, length).slice();
    let reply;
    try {
      reply = this.wasmTranslator ? await this.wasmTranslator.translate(input) : 'error:WebAssembly is not available in this view';
    } catch (error) {
      reply = `error:${error?.message ?? error}`;
    }
    this.#reply(slot, reply);
  }

  // A question the engine waits on (a dialog); `onAsk` answers with any JSON
  // value, or undefined for none.
  async #answer({ question, slot }) {
    let reply;
    try {
      reply = await this.onAsk?.(JSON.parse(question));
    } catch (error) {
      console.error('[engine] unanswered question', error);
    }
    this.#reply(slot, reply === undefined ? 'null' : JSON.stringify(reply));
  }

  #reply(slot, text) {
    const memory = () => this.#module.wasmMemory.buffer;
    const encoded = new TextEncoder().encode(text);
    const pointer = this.#module._malloc(encoded.length + 1);
    const heap = new Uint8Array(memory());
    heap.set(encoded, pointer);
    heap[pointer + encoded.length] = 0;
    const words = new Int32Array(memory());
    Atomics.store(words, (slot >> 2) + 1, pointer);
    Atomics.store(words, slot >> 2, 1);
    Atomics.notify(words, slot >> 2);
  }

  // The engine's shared memory, as it is now (it grows).
  memory() {
    return this.#module.wasmMemory.buffer;
  }

  // Allocates engine memory the engine frees; 0 when it cannot.
  malloc(size) {
    return this.#module._malloc(size) >>> 0;
  }

  // Copies a file into the engine's file system; the bytes are transferred.
  sendFile(name, bytes) {
    this.#worker?.postMessage({ inceptionFile: { name, bytes } }, [bytes]);
  }

  #presentBitmap(window, bitmap) {
    this.#frames.present(window, bitmap);
  }

  // CPU fallback frames arrive as RGBA bytes. They go through an ImageBitmap so
  // both paths share the display's bitmaprenderer context.
  async #presentPixels(window, { width, height, buffer }) {
    if (!this.#frames.sinkOf(window)) return;
    const image = new ImageData(new Uint8ClampedArray(buffer), width, height);
    this.#presentBitmap(window, await createImageBitmap(image, { premultiplyAlpha: 'premultiply' }));
  }
}
