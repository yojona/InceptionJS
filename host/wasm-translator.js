// Guest WebAssembly, host side: translates module bytes to JavaScript with
// binaryen's wasm2js. The result is never evaluated here; it is handed back to
// the engine, which runs it inside the guest page.

// Features wasm2js can lower to JavaScript. Modules needing anything else
// (threads, SIMD, exceptions, GC, ...) fail to validate and are reported to
// the guest as a CompileError.
const SUPPORTED = ['MVP', 'MutableGlobals', 'SignExt', 'NontrappingFPToInt', 'BulkMemory', 'Multivalue'];

const EXTERNAL_KIND = ['function', 'table', 'memory', 'global', 'tag'];

// Translations are shared by every page in the view, so a module must be
// recognised by a collision-resistant digest (a page could otherwise craft a
// module that collides with another site's and be handed its translation, or
// hand its own to that site), and the cache is bounded.
const CACHE_ENTRIES = 32;
const CACHE_CHARS = 128 * 1024 * 1024;

export class WasmTranslator {
  #binaryenUrl;
  #binaryen = null;
  #cache = new Map();
  #cacheChars = 0;

  // `binaryenUrl`: one URL, or candidates tried in order (the first that loads).
  constructor(binaryenUrl) {
    this.#binaryenUrl = [binaryenUrl].flat();
  }

  #remember(key, reply) {
    this.#cache.set(key, reply);
    this.#cacheChars += reply.length;
    // Oldest first; a hit moves an entry to the end.
    for (const [oldest, text] of this.#cache) {
      if (this.#cache.size <= CACHE_ENTRIES && this.#cacheChars <= CACHE_CHARS) break;
      if (oldest === key) continue;
      this.#cache.delete(oldest);
      this.#cacheChars -= text.length;
    }
  }

  // Loaded the first time a page uses WebAssembly.
  async #load() {
    this.#binaryen ??= (async () => {
      let failure;
      for (const url of this.#binaryenUrl) {
        try {
          return (await import(url)).default;
        } catch (error) {
          failure = error;
        }
      }
      throw failure ?? new Error('no binaryen URL');
    })();
    return this.#binaryen;
  }

  // Returns "ok:" + a script evaluating to the module factory, or "error:" +
  // a message.
  async translate(bytes) {
    const key = await digest(bytes);
    const cached = this.#cache.get(key);
    if (cached) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached;
    }
    let reply;
    const started = performance.now();
    try {
      reply = 'ok:' + this.#translate(await this.#load(), bytes);
    } catch (error) {
      reply = 'error:' + String(error?.message ?? error);
    }
    console.debug(`[wasm] ${bytes.length} bytes translated in ${Math.round(performance.now() - started)} ms${reply.startsWith('error:') ? `: ${reply.slice(6)}` : ''}`);
    this.#remember(key, reply);
    return reply;
  }

  #translate(binaryen, bytes) {
    let module;
    try {
      module = binaryen.readBinary(bytes);
    } catch (error) {
      throw new Error(`invalid module: ${error?.message ?? error}`);
    }
    try {
      module.setFeatures(SUPPORTED.reduce((all, name) => all | binaryen.Features[name], 0));
      if (!module.validate()) throw new Error('the module uses WebAssembly features this engine cannot run (threads, SIMD, exceptions or GC)');
      const meta = describe(bytes);
      const text = module.emitAsmjs();
      const start = text.indexOf('function asmFunc(');
      const end = text.indexOf('\nvar retasmFunc');
      if (start < 0 || end < 0) throw new Error('unexpected translator output');
      return `(function () {\n${text.slice(start, end)}\nasmFunc.__meta = ${JSON.stringify(meta)};\nreturn asmFunc;\n})()`;
    } finally {
      module.dispose();
    }
  }
}

// Import and export lists, read from the binary's import (2) and export (7)
// sections.
function describe(bytes) {
  const imports = [];
  const exports = [];
  let offset = 8;
  const u32 = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[offset++];
      result |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result >>> 0;
      shift += 7;
    }
  };
  const name = () => {
    const length = u32();
    const text = new TextDecoder().decode(bytes.subarray(offset, offset + length));
    offset += length;
    return text;
  };
  const limits = () => {
    const flags = u32();
    u32();
    if (flags & 1) u32();
  };
  while (offset < bytes.length) {
    const id = bytes[offset++];
    const size = u32();
    const end = offset + size;
    if (id === 2) {
      for (let count = u32(); count > 0; count--) {
        const module = name();
        const field = name();
        const kind = bytes[offset++];
        if (kind === 0) u32();
        else if (kind === 1) { offset++; limits(); }
        else if (kind === 2) limits();
        else if (kind === 3) offset += 2;
        else if (kind === 4) { offset++; u32(); }
        imports.push({ module, name: field, kind: EXTERNAL_KIND[kind] ?? 'function' });
      }
    } else if (id === 7) {
      for (let count = u32(); count > 0; count--) {
        const field = name();
        const kind = bytes[offset++];
        u32();
        exports.push({ name: field, kind: EXTERNAL_KIND[kind] ?? 'function' });
      }
    }
    offset = end;
  }
  return { imports, exports };
}

// SHA-256 of the bytes, as hex.
async function digest(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
