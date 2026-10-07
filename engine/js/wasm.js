// Guest WebAssembly translation, engine side: the request goes to the page's
// main thread (where the translator lives) and this thread waits for the
// answer, since WebAssembly.Module() is synchronous.
addToLibrary({
  inception_wasm_translate__deps: ['malloc', 'free'],
  inception_wasm_translate: (bytes, length) => {
    const slot = _malloc(8);
    HEAP32[slot >> 2] = 0;
    HEAP32[(slot >> 2) + 1] = 0;
    postMessage({ inceptionWasm: { bytes, length, slot } });
    Atomics.wait(HEAP32, slot >> 2, 0);
    const reply = HEAP32[(slot >> 2) + 1];
    _free(slot);
    return reply;
  },
});
