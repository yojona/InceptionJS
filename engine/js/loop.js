// Drives the engine's RunLoop from the worker's event loop. Immediate turns use
// a MessageChannel (a macrotask, so input and network events interleave);
// timer turns use setTimeout, keeping only the earliest pending one.
addToLibrary({
  $inceptionLoop: { channel: null, posted: false, timer: 0, due: Infinity },

  inception_loop_schedule__deps: ['$inceptionLoop'],
  inception_loop_schedule: (delayMs) => {
    const loop = inceptionLoop;
    const run = () => {
      loop.posted = false;
      Module._inception_loop_iterate();
    };
    if (delayMs <= 0) {
      if (loop.posted) return;
      if (!loop.channel) {
        loop.channel = new MessageChannel();
        loop.channel.port1.onmessage = run;
      }
      loop.posted = true;
      loop.channel.port2.postMessage(0);
      return;
    }
    const due = performance.now() + delayMs;
    if (due >= loop.due) return;
    clearTimeout(loop.timer);
    loop.due = due;
    loop.timer = setTimeout(() => {
      loop.due = Infinity;
      Module._inception_loop_iterate();
    }, delayMs);
  },
});
