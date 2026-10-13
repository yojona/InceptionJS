// Sound of a window that another document shows. The engine renders each Web
// Audio context into a ring of planar float samples in its shared memory (see
// host/audio.js, which plays it in the engine's own document). For a window
// displayed elsewhere the samples travel instead: a worker next to the engine
// drains the ring and posts the samples over a port of their own to the
// display's document (PcmTap), which plays them (PcmPlayer). The worker keeps
// draining when the engine's document is in a background tab, whose timers
// are throttled; the display's document needs the person's gesture before it
// may play, as any page does.

const DRAIN_SOURCE = `
const rings = new Map();
let port = null;
let timer = null;
const MAX_FRAMES = 4096;
function drain() {
  for (const ring of rings.values()) {
    const written = Atomics.load(ring.indexes, 0);
    const read = Atomics.load(ring.indexes, 1);
    const frames = Math.min((written - read) | 0, MAX_FRAMES);
    if (frames <= 0) continue;
    const data = new Float32Array(frames * ring.channels);
    for (let c = 0; c < ring.channels; c++) {
      const channel = ring.views[c];
      for (let i = 0; i < frames; i++) data[c * frames + i] = channel[(read + i) & ring.mask];
    }
    Atomics.store(ring.indexes, 1, (read + frames) | 0);
    Atomics.notify(ring.indexes, 1);
    port.postMessage({ type: 'pcm', id: ring.id, sampleRate: ring.sampleRate, channels: ring.channels, frames, data }, [data.buffer]);
  }
}
onmessage = (event) => {
  const { port: given, open, close } = event.data;
  if (given) port = given;
  if (open) {
    const { id, memory, header, samples, capacity, channels, sampleRate } = open;
    const views = [];
    for (let c = 0; c < channels; c++) views.push(new Float32Array(memory, samples + c * capacity * 4, capacity));
    rings.set(id, { id, indexes: new Int32Array(memory, header, 4), views, channels, sampleRate, mask: capacity - 1 });
    timer ??= setInterval(drain, 8);
  }
  if (close !== undefined) {
    rings.delete(close);
    if (!rings.size) { clearInterval(timer); timer = null; }
  }
};
`;

// The engine's side: drains rings into `port`.
export class PcmTap {
  #worker;
  #url;

  constructor(port) {
    this.#url = URL.createObjectURL(new Blob([DRAIN_SOURCE], { type: 'text/javascript' }));
    this.#worker = new Worker(this.#url);
    this.#worker.postMessage({ port }, [port]);
  }

  // `ring`: the engine's "audio.open" event; `memory`: the engine's shared memory.
  open({ id, header, samples, capacity, channels, sampleRate }, memory) {
    this.#worker.postMessage({ open: { id, memory, header, samples, capacity, channels, sampleRate } });
  }

  close(id) {
    this.#worker.postMessage({ close: id });
  }

  stop() {
    this.#worker.terminate();
    URL.revokeObjectURL(this.#url);
  }
}

const PLAYER_SOURCE = `
class InceptionPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.queued = 0;
    this.offset = 0;
    this.playing = false;
    this.rate = sampleRate;
    this.port.onmessage = (event) => {
      this.queue.push(event.data);
      this.queued += event.data.frames;
      // Never more than half a second behind: the oldest goes.
      while (this.queued > this.rate / 2 && this.queue.length > 1) {
        this.queued -= this.queue.shift().frames - this.offset;
        this.offset = 0;
      }
    };
  }
  process(_, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    // Starts once 40 ms are in hand, so a trickle does not stutter.
    if (!this.playing) {
      if (this.queued < this.rate / 25) return true;
      this.playing = true;
    }
    let done = 0;
    while (done < frames && this.queue.length) {
      const chunk = this.queue[0];
      const take = Math.min(frames - done, chunk.frames - this.offset);
      for (let c = 0; c < out.length; c++) {
        const source = Math.min(c, chunk.channels - 1) * chunk.frames + this.offset;
        out[c].set(chunk.data.subarray(source, source + take), done);
      }
      done += take;
      this.offset += take;
      this.queued -= take;
      if (this.offset >= chunk.frames) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    if (done < frames) this.playing = false;
    return true;
  }
}
registerProcessor('inception-pcm', InceptionPcm);
`;

// The display's side: plays what a PcmTap sends. One AudioContext per sample
// rate the pages use; each ring gets a worklet node of its own.
export class PcmPlayer {
  #contexts = new Map();
  #nodes = new Map();
  #url = null;
  #level = 1;
  #closed = false;
  // What has arrived, for the embedder and the tests: chunks, frames, the
  // loudest sample seen, and the state of the output ("suspended" until the
  // person has used this document).
  stats = { chunks: 0, frames: 0, peak: 0, state: 'none' };

  constructor({ volume = 1, muted = false } = {}) {
    this.setLevel({ volume, muted });
  }

  setLevel({ volume, muted }) {
    this.#level = muted ? 0 : Math.min(1, Math.max(0, volume));
    for (const entry of this.#contexts.values()) entry.then(({ master }) => (master.gain.value = this.#level));
  }

  attach(port) {
    port.onmessage = (event) => this.#push(event.data);
    port.start?.();
  }

  #push(message) {
    if (this.#closed || !message || message.type !== 'pcm') return;
    const { id, sampleRate, channels, frames, data } = message;
    if (!Number.isInteger(id) || !(sampleRate >= 8000 && sampleRate <= 192000) || !(channels >= 1 && channels <= 8) || !(frames > 0 && frames <= 16384) || !(data instanceof Float32Array) || data.length !== frames * channels) return;
    this.stats.chunks++;
    this.stats.frames += frames;
    for (let i = 0; i < data.length; i++) this.stats.peak = Math.max(this.stats.peak, Math.abs(data[i]));
    this.#node(id, sampleRate).then((node) => node?.port.postMessage({ channels, frames, data }, [data.buffer]), () => {});
  }

  async #node(id, sampleRate) {
    if (this.#nodes.has(id)) return this.#nodes.get(id);
    const created = this.#context(sampleRate).then(({ context, master }) => {
      const node = new AudioWorkletNode(context, 'inception-pcm', { numberOfInputs: 0, outputChannelCount: [2] });
      node.connect(master);
      return node;
    });
    this.#nodes.set(id, created);
    return created;
  }

  #context(sampleRate) {
    let entry = this.#contexts.get(sampleRate);
    if (!entry) {
      const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
      this.#url ??= URL.createObjectURL(new Blob([PLAYER_SOURCE], { type: 'text/javascript' }));
      entry = context.audioWorklet.addModule(this.#url).then(() => {
        const master = new GainNode(context, { gain: this.#level });
        master.connect(context.destination);
        this.#resume(context);
        return { context, master };
      });
      this.#contexts.set(sampleRate, entry);
    }
    return entry;
  }

  // A context may not play before the person has used the document: try now
  // (it may already have) and again at the first gesture.
  #resume(context) {
    const update = () => (this.stats.state = context.state);
    context.addEventListener('statechange', update);
    update();
    if (context.state === 'running') return;
    context.resume().then(update, () => {});
    const gesture = () => {
      for (const type of ['pointerdown', 'keydown', 'touchend']) document.removeEventListener(type, gesture, true);
      context.resume().then(update, () => {});
    };
    for (const type of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(type, gesture, true);
  }

  closeRing(id) {
    const node = this.#nodes.get(id);
    this.#nodes.delete(id);
    node?.then((n) => n.disconnect(), () => {});
  }

  close() {
    this.#closed = true;
    for (const id of [...this.#nodes.keys()]) this.closeRing(id);
    for (const entry of this.#contexts.values()) entry.then(({ context }) => context.close(), () => {});
    this.#contexts.clear();
    if (this.#url) URL.revokeObjectURL(this.#url);
  }
}
