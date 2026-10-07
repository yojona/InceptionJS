// WebAssembly for pages inside the engine. Evaluated by the engine in each new
// window before page scripts. Modules are translated to JavaScript by the host
// (wasm2js) through the engine's __inceptionWasmTranslate function, then run
// as ordinary script in this realm.
(() => {
  const translate = globalThis.__inceptionWasmTranslate;
  delete globalThis.__inceptionWasmTranslate;
  if (typeof translate !== 'function' || typeof globalThis.WebAssembly !== 'undefined') return;

  const PAGE = 65536;
  class CompileError extends Error { constructor(message) { super(message); this.name = 'CompileError'; } }
  class LinkError extends Error { constructor(message) { super(message); this.name = 'LinkError'; } }
  class RuntimeError extends Error { constructor(message) { super(message); this.name = 'RuntimeError'; } }

  const toBytes = (source) => {
    if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
    if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
    throw new TypeError('WebAssembly: expected an ArrayBuffer or a typed array');
  };

  const factories = new WeakMap();

  class Module {
    constructor(source) {
      try {
        factories.set(this, translate(toBytes(source)));
      } catch (error) {
        if (error instanceof TypeError) throw error;
        throw new CompileError(String(error?.message ?? error));
      }
    }
    static imports(module) { return factories.get(module).__meta.imports.map((entry) => ({ ...entry })); }
    static exports(module) { return factories.get(module).__meta.exports.map((entry) => ({ ...entry })); }
    static customSections() { return []; }
  }

  class Memory {
    #buffer;
    #maximum;
    constructor({ initial = 0, maximum } = {}) {
      this.#buffer = new ArrayBuffer(initial * PAGE);
      this.#maximum = maximum;
    }
    get buffer() { return this.#buffer; }
    // Translated code replaces the buffer itself when it grows an imported memory.
    set buffer(buffer) { this.#buffer = buffer; }
    grow(delta) {
      const pages = this.#buffer.byteLength / PAGE;
      if (this.#maximum !== undefined && pages + delta > this.#maximum) throw new RangeError('WebAssembly.Memory.grow: beyond the maximum');
      const grown = new ArrayBuffer((pages + delta) * PAGE);
      new Uint8Array(grown).set(new Uint8Array(this.#buffer));
      this.#buffer = grown;
      return pages;
    }
  }

  class Table {
    #entries;
    constructor({ initial = 0 } = {}, value = null) { this.#entries = new Array(initial).fill(value); }
    get length() { return this.#entries.length; }
    get(index) { return this.#entries[index] ?? null; }
    set(index, value) { this.#entries[index] = value; }
    grow(delta, value = null) { const length = this.#entries.length; for (let i = 0; i < delta; i++) this.#entries.push(value); return length; }
  }

  class Global {
    constructor({ mutable = false } = {}, value = 0) { this.value = value; Object.defineProperty(this, 'mutable', { value: mutable }); }
    valueOf() { return this.value; }
  }

  // Exported memories come back as plain objects; give them the API shape.
  const adoptExport = (value, kind) => {
    if (kind === 'memory' && value && !(value instanceof Memory)) Object.setPrototypeOf(value, Memory.prototype);
    return value;
  };

  class Instance {
    constructor(module, importObject = {}) {
      const factory = factories.get(module);
      if (!factory) throw new TypeError('WebAssembly.Instance: expected a WebAssembly.Module');
      for (const entry of factory.__meta.imports) {
        const namespace = importObject?.[entry.module];
        if (namespace === undefined || !(entry.name in Object(namespace)))
          throw new LinkError(`import ${entry.module}.${entry.name} is missing`);
      }
      let raw;
      try {
        raw = factory(importObject);
      } catch (error) {
        throw new RuntimeError(String(error?.message ?? error));
      }
      const exports = Object.create(null);
      for (const entry of factory.__meta.exports) exports[entry.name] = adoptExport(raw[entry.name], entry.kind);
      Object.defineProperty(this, 'exports', { value: Object.freeze(exports), enumerable: true });
    }
  }

  const responseBytes = async (source) => {
    const response = await source;
    if (!response || typeof response.arrayBuffer !== 'function') throw new TypeError('WebAssembly: expected a Response');
    if (!response.ok) throw new TypeError(`WebAssembly: HTTP status ${response.status}`);
    return response.arrayBuffer();
  };

  const WebAssembly = {
    Module, Instance, Memory, Table, Global, CompileError, LinkError, RuntimeError,
    validate(source) {
      try { translate(toBytes(source)); return true; } catch { return false; }
    },
    async compile(source) { return new Module(source); },
    async instantiate(source, importObject) {
      if (source instanceof Module) return new Instance(source, importObject);
      const module = new Module(source);
      return { module, instance: new Instance(module, importObject) };
    },
    async compileStreaming(source) { return new Module(await responseBytes(source)); },
    async instantiateStreaming(source, importObject) { return WebAssembly.instantiate(await responseBytes(source), importObject); },
  };
  Object.defineProperty(WebAssembly, Symbol.toStringTag, { value: 'WebAssembly' });
  Object.defineProperty(globalThis, 'WebAssembly', { value: WebAssembly, writable: true, configurable: true });
})();
