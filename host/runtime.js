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
    this.#module = await createEngine({
      locateFile: (path) => new URL(path, this.engineUrl).href,
      print: (text) => console.log('[engine]', text),
      printErr: (text) => console.warn('[engine]', text),
    });
    // With the engine's main() proxied to a pthread, that pthread's worker is
    // the only running one once the module is up.
    const { PThread } = this.#module;
    const deadline = performance.now() + 10000;
    while (!PThread.runningWorkers.length) {
      if (performance.now() > deadline) throw new Error('engine thread did not start');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const worker = PThread.runningWorkers[0];
    worker.addEventListener('message', (e) => this.#onWorkerMessage(worker, e.data));
    worker.postMessage({ inception: JSON.stringify({ command: 'hello', args: {} }) });
    await started;
  }

  send(command, args = {}) {
    const message = { inception: JSON.stringify({ command, args }) };
    if (this.#worker) this.#worker.postMessage(message);
    else this.#pending.push(message);
  }

  #onWorkerMessage(worker, data) {
    if (!data || typeof data !== 'object') return;
    if (data.inceptionFrame) return this.#presentBitmap(data.inceptionFrame);
    if (data.inceptionPixels) return this.#presentPixels(data.inceptionPixels);
    if (typeof data.inception !== 'string') return;
    const { event, data: payload } = JSON.parse(data.inception);
    if (event === 'started') {
      if (payload.version !== BRIDGE_VERSION)
        throw new Error(`engine speaks bridge v${payload.version}, host speaks v${BRIDGE_VERSION}`);
      this.#worker = worker;
      worker.postMessage({ inceptionConfig: { wispUrl: this.wispUrl } });
      for (const message of this.#pending.splice(0)) worker.postMessage(message);
    }
    this.dispatchEvent(new CustomEvent(event, { detail: payload }));
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
