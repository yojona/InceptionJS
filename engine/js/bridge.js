// Engine side of the bridge, running in the engine's worker. Messages from the
// host carry {inception: <json string>}; emscripten's own worker protocol uses
// `cmd`, so the two never collide.
addToLibrary({
  inception_bridge_post__deps: ['$UTF8ToString'],
  inception_bridge_post: (json) => {
    postMessage({ inception: UTF8ToString(json) });
  },

  $inceptionBridgeInstall__deps: ['$stringToNewUTF8', 'malloc', 'free', 'inception_loop_schedule'],
  $inceptionBridgeInstall__postset: 'inceptionBridgeInstall();',
  $inceptionBridgeInstall: () => {
    if (!ENVIRONMENT_IS_PTHREAD) return;
    // The ErrorEvent the host sees on the Worker object has lost the error
    // itself, so the stack is sent from here while it still exists.
    const crashed = (error, fallback) => {
      postMessage({ inceptionCrash: {
        message: String(error?.message ?? error ?? fallback),
        stack: String(error?.stack ?? ''),
      } });
    };
    self.addEventListener('error', (e) => crashed(e.error, e.message));
    self.addEventListener('unhandledrejection', (e) => crashed(e.reason, 'unhandled rejection'));
    // A file from the host's picker; "file.chosen" follows on the same port.
    self.addEventListener('message', (e) => {
      const file = e.data?.inceptionFile;
      if (!file) return;
      const bytes = new Uint8Array(file.bytes);
      const name = stringToNewUTF8(file.name);
      const data = _malloc(Math.max(bytes.length, 1));
      HEAPU8.set(bytes, data);
      Module._inception_file_store(name, data, bytes.length);
      _free(data);
      _free(name);
    });
    self.addEventListener('message', (e) => {
      const json = e.data?.inception;
      if (typeof json !== 'string') return;
      const ptr = stringToNewUTF8(json);
      try {
        Module._inception_bridge_receive(ptr);
      } finally {
        _free(ptr);
      }
      _inception_loop_schedule(0);
    });
  },
});
