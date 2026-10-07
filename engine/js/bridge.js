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
    self.addEventListener('message', (e) => {
      if (e.data?.inceptionPump) {
        Module._inception_net_pump();
        // Code run outside a RunLoop iteration may have armed timers the loop
        // has not reported yet; one immediate iteration reports them.
        _inception_loop_schedule(0);
        return;
      }
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
