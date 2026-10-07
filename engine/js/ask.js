// Questions the engine cannot go on without (alert, confirm, prompt): the
// host's main thread answers and this thread waits, as the page itself does.
addToLibrary({
  inception_host_ask__deps: ['malloc', 'free', '$UTF8ToString'],
  inception_host_ask: (json) => {
    const slot = _malloc(8);
    HEAP32[slot >> 2] = 0;
    HEAP32[(slot >> 2) + 1] = 0;
    postMessage({ inceptionAsk: { question: UTF8ToString(json), slot } });
    Atomics.wait(HEAP32, slot >> 2, 0);
    const reply = HEAP32[(slot >> 2) + 1];
    _free(slot);
    return reply;
  },
});
