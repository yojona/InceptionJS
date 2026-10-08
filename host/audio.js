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

// The reverse: a media element's sound, written into a ring the engine's
// audio graph reads ([0] frames written, [1] frames read).
class InceptionCapture extends AudioWorkletProcessor {
  constructor({ processorOptions: o }) {
    super();
    this.indexes = new Int32Array(o.memory, o.header, 2);
    this.capacity = o.capacity;
    this.mask = o.capacity - 1;
    this.channels = [];
    for (let c = 0; c < o.channels; c++) this.channels.push(new Float32Array(o.memory, o.samples + c * o.capacity * 4, o.capacity));
    this.open = true;
    this.port.onmessage = () => { this.open = false; };
  }
  process(inputs) {
    if (!this.open) return false;
    const input = inputs[0];
    if (!input || !input.length) return true;
    const frames = input[0].length;
    const written = Atomics.load(this.indexes, 0);
    const read = Atomics.load(this.indexes, 1);
    // The engine stopped reading: drop the oldest instead of overrunning it.
    if (((written - read) | 0) + frames > this.capacity) Atomics.store(this.indexes, 1, (written + frames - this.capacity) | 0);
    const at = written & this.mask;
    for (let c = 0; c < this.channels.length; c++) {
      const source = input[Math.min(c, input.length - 1)];
      const target = this.channels[c];
      for (let i = 0; i < frames; i++) target[(at + i) & this.mask] = source[i];
    }
    Atomics.store(this.indexes, 0, (written + frames) | 0);
    return true;
  }
}
registerProcessor('inception-capture', InceptionCapture);
`;

export class AudioHost {
  #memory;
  #contexts = new Map();
  #nodes = new Map();
  #masters = new Map();
  #level = 1;
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
    node.connect(this.#masters.get(context) ?? context.destination);
    this.#nodes.set(id, node);
    this.#tryResume(context);
  }

  // The embedder's master output level, 0..1 (0 when muted).
  setLevel(level) {
    this.#level = level;
    for (const master of this.#masters.values()) master.gain.value = level;
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

  // Routes a host media element's sound into the engine (see the engine's
  // HostAudioSource) instead of the speakers; returns the capture's format.
  async capture(video, { header, samples, capacity, channels }) {
    const context = await this.#context(48000);
    const source = context.createMediaElementSource(video);
    const node = new AudioWorkletNode(context, 'inception-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { memory: this.#memory(), header, samples, capacity, channels },
    });
    source.connect(node);
    // Silent, but connected, so the worklet keeps processing.
    const silent = new GainNode(context, { gain: 0 });
    node.connect(silent).connect(context.destination);
    this.#tryResume(context);
    return { channels, sampleRate: context.sampleRate };
  }

  async #context(sampleRate) {
    let entry = this.#contexts.get(sampleRate);
    if (!entry) {
      const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
      entry = context.audioWorklet.addModule(this.#moduleUrl).then(() => {
        const master = new GainNode(context, { gain: this.#level });
        master.connect(context.destination);
        this.#masters.set(context, master);
        return context;
      });
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
