// Web Audio output for the engine. The engine renders each AudioContext into a
// ring of planar float samples in its shared memory (see the engine's
// AudioDestinationEmscripten); here an AudioWorklet reads the ring and plays
// it. One host AudioContext per sample rate the pages ask for; the browser
// resamples to the device. Also decodes compressed audio for the engine.

const PROCESSOR = `
class InceptionOutput extends AudioWorkletProcessor {
  constructor({ processorOptions: o }) {
    super();
    // [0] frames written, [1] frames read, [2] quanta found missing.
    this.indexes = new Int32Array(o.memory, o.header, 4);
    this.mask = o.capacity - 1;
    this.channels = [];
    for (let c = 0; c < o.channels; c++) this.channels.push(new Float32Array(o.memory, o.samples + c * o.capacity * 4, o.capacity));
    this.open = true;
    this.port.onmessage = () => { this.open = false; };
  }
  process(_, outputs) {
    if (!this.open) return false;
    const out = outputs[0];
    const frames = out[0].length;
    const written = Atomics.load(this.indexes, 0);
    const read = Atomics.load(this.indexes, 1);
    if (((written - read) | 0) < frames) {
      Atomics.add(this.indexes, 2, 1);
      return true;
    }
    const at = read & this.mask;
    for (let c = 0; c < out.length; c++) out[c].set(this.channels[Math.min(c, this.channels.length - 1)].subarray(at, at + frames));
    Atomics.store(this.indexes, 1, (read + frames) | 0);
    Atomics.notify(this.indexes, 1);
    return true;
  }
}
registerProcessor('inception-output', InceptionOutput);
`;

export class AudioHost {
  #memory;
  #contexts = new Map();
  #nodes = new Map();
  #moduleUrl = URL.createObjectURL(new Blob([PROCESSOR], { type: 'text/javascript' }));
  #soundAllowed;

  // `memory()`: the engine's (shared) memory buffer. `soundAllowed`: the
  // embedder says audio may start without a gesture.
  constructor(memory, { soundAllowed = false } = {}) {
    this.#memory = memory;
    this.#soundAllowed = soundAllowed;
  }

  get contexts() { return [...this.#contexts.values()]; }

  async open({ id, header, samples, capacity, channels, sampleRate }) {
    const context = await this.#context(sampleRate);
    if (this.#nodes.has(id)) return;
    const node = new AudioWorkletNode(context, 'inception-output', {
      numberOfInputs: 0,
      outputChannelCount: [channels],
      processorOptions: { memory: this.#memory(), header, samples, capacity, channels },
    });
    node.connect(context.destination);
    this.#nodes.set(id, node);
    this.#tryResume(context);
  }

  close({ id }) {
    const node = this.#nodes.get(id);
    if (!node) return;
    this.#nodes.delete(id);
    node.port.postMessage('close');
    node.disconnect();
  }

  // Activation is sticky: after the first gesture in the host page, every
  // context may play.
  userGesture() {
    for (const context of this.#contexts.values()) context.resume().catch(() => {});
  }

  async #context(sampleRate) {
    let entry = this.#contexts.get(sampleRate);
    if (!entry) {
      const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
      entry = context.audioWorklet.addModule(this.#moduleUrl).then(() => context);
      this.#contexts.set(sampleRate, entry);
    }
    return entry;
  }

  #tryResume(context) {
    if (this.#soundAllowed || navigator.userActivation?.hasBeenActive) context.resume().catch(() => {});
  }

  // The engine waits on `reply`: {done: i32, channels: i32, frames: i32,
  // sampleRate: f32, samples: pointer}; done 1 with planar samples allocated
  // with `alloc`, -1 on failure.
  async decode({ bytes, length, sampleRate, reply }, alloc) {
    const words = () => new Int32Array(this.#memory());
    const finish = (status) => {
      Atomics.store(words(), reply >> 2, status);
      Atomics.notify(words(), reply >> 2);
    };
    try {
      const encoded = new Uint8Array(this.#memory(), bytes, length).slice();
      const decoder = new OfflineAudioContext(1, 1, sampleRate || 48000);
      const buffer = await decoder.decodeAudioData(encoded.buffer);
      const { numberOfChannels, length: frames } = buffer;
      const pointer = alloc(numberOfChannels * frames * 4);
      if (!pointer) return finish(-1);
      for (let c = 0; c < numberOfChannels; c++)
        new Float32Array(this.#memory(), pointer + c * frames * 4, frames).set(buffer.getChannelData(c));
      const view = new DataView(this.#memory());
      view.setInt32(reply + 4, numberOfChannels, true);
      view.setInt32(reply + 8, frames, true);
      view.setFloat32(reply + 12, buffer.sampleRate, true);
      view.setUint32(reply + 16, pointer, true);
      finish(1);
    } catch {
      finish(-1);
    }
  }
}
