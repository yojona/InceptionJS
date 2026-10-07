// Engine side of the bridge, running in the engine's worker. Messages from the
// host carry {inception: <json string>}; emscripten's own worker protocol uses
// `cmd`, so the two never collide.
addToLibrary({
  inception_bridge_post__deps: ['$UTF8ToString'],
  inception_bridge_post: (json) => {
    postMessage({ inception: UTF8ToString(json) });
  },

  $inceptionBridgeInstall__deps: ['$stringToNewUTF8', 'free', 'inception_loop_schedule'],
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
