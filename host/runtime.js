// Starts one engine instance and connects it to a canvas. The engine runs
// WebKit on a pthread worker; this side forwards commands to it, receives its
// events, and shows its frames.

export const BRIDGE_VERSION = 1;

export class EngineRuntime extends EventTarget {
  #module = null;
  #worker = null;
  #canvas = null;
  #bitmapContext = null;
  #pixelContext = null;
  #pending = [];

  constructor({ engineUrl, wispUrl, canvas }) {
    super();
    this.engineUrl = engineUrl;
    this.wispUrl = wispUrl;
    this.#canvas = canvas;
  }

  async start() {
    if (!crossOriginIsolated)
      throw new Error('InceptionJS needs a cross-origin isolated page (COOP: same-origin, COEP: require-corp)');
    const { default: createEngine } = await import(this.engineUrl);
    const started = new Promise((resolve) => this.addEventListener('started', resolve, { once: true }));
    // The engine's thread announces itself as soon as it runs, possibly before
    // the module promise settles, so listeners go on each worker as it is
    // created rather than afterwards.
    const NativeWorker = globalThis.Worker;
    const runtime = this;
    globalThis.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (e) => runtime.#onWorkerMessage(this, e.data));
      }
    };
    try {
      this.#module = await createEngine({
        locateFile: (path) => new URL(path, this.engineUrl).href,
        print: (text) => console.log('[engine]', text),
        printErr: (text) => console.warn('[engine]', text),
      });
    } finally {
      globalThis.Worker = NativeWorker;
    }
    await started;
  }

  send(command, args = {}) {
    const message = { inception: JSON.stringify({ command, args }) };
    if (this.#worker) this.#worker.postMessage(message);
    else this.#pending.push(message);
  }

  #onWorkerMessage(worker, data) {
    if (!data || typeof data !== 'object') return;
    if (data.inceptionWantsFrame) return requestAnimationFrame(() => worker.postMessage({ inceptionFrameTick: 1 }));
    if (data.inceptionFrame) return this.#presentBitmap(data.inceptionFrame);
    if (data.inceptionMediaAppend) return this.onMediaAppend?.(data.inceptionMediaAppend);
    if (data.inceptionWasm) return this.#translateWasm(data.inceptionWasm);
    if (data.inceptionPixels) return this.#presentPixels(data.inceptionPixels);
    if (typeof data.inception !== 'string') return;
    const { event, data: payload } = JSON.parse(data.inception);
    if (event === 'started') {
      if (this.#worker) return;
      if (payload.version !== BRIDGE_VERSION)
        throw new Error(`engine speaks bridge v${payload.version}, host speaks v${BRIDGE_VERSION}`);
      this.#worker = worker;
      for (const message of this.#pending.splice(0)) worker.postMessage(message);
    }
    this.onEngineEvent?.(event, payload);
    this.dispatchEvent(new CustomEvent(event, { detail: payload }));
  }

  // The engine thread is blocked on `slot` until the reply is written.
  async #translateWasm({ bytes, length, slot }) {
    const memory = () => this.#module.wasmMemory.buffer;
    const input = new Uint8Array(memory(), bytes, length).slice();
    let reply;
    try {
      reply = this.wasmTranslator ? await this.wasmTranslator.translate(input) : 'error:WebAssembly is not available in this view';
    } catch (error) {
      reply = `error:${error?.message ?? error}`;
    }
    const encoded = new TextEncoder().encode(reply);
    const pointer = this.#module._malloc(encoded.length + 1);
    const heap = new Uint8Array(memory());
    heap.set(encoded, pointer);
    heap[pointer + encoded.length] = 0;
    const words = new Int32Array(memory());
    Atomics.store(words, (slot >> 2) + 1, pointer);
    Atomics.store(words, slot >> 2, 1);
    Atomics.notify(words, slot >> 2);
  }

  #presentBitmap(bitmap) {
    const canvas = this.#canvas;
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
    this.#bitmapContext ??= canvas.getContext('bitmaprenderer');
    this.#bitmapContext.transferFromImageBitmap(bitmap);
  }

  // CPU fallback frames arrive as RGBA bytes. They go through an ImageBitmap so
  // both paths share the canvas's bitmaprenderer context.
  async #presentPixels({ width, height, buffer }) {
    const image = new ImageData(new Uint8ClampedArray(buffer), width, height);
    this.#presentBitmap(await createImageBitmap(image, { premultiplyAlpha: 'premultiply' }));
  }
}
