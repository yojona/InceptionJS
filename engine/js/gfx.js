// Engine-side graphics: the engine owns an OffscreenCanvas and its WebGL2
// context; each finished frame moves to the host as an ImageBitmap (no copy).
// Every window of the engine shares that canvas and context; frames are
// requested, ticked and presented per window, and a message without a window
// (from an older peer) means window 1.
addToLibrary({
  // `requested`: window id -> true while that window waits for a tick. Plain
  // JSON, as library state must be.
  $inceptionGfx: { canvas: null, requested: {}, contextState: 0 },

  // How many WebGL contexts pages may hold at once, shared by every window
  // of this engine. Browsers keep at most four contexts per worker (Chromium,
  // WebKit and Safari, GPU or not) and lose the OLDEST past that, which is
  // the engine's own, created first; so pages get three. `requested` (the
  // embedder's webglContexts option) wins when set. No probe raises it:
  // finding the cap by creating contexts would evict the engine's.
  $inceptionPageContextCap: (gl, requested) => (requested > 0 ? requested : 3),

  // Engine diagnostics reach the host as console events, since worker consoles
  // are easy to miss.
  $inceptionReport: (level, message) => {
    postMessage({ inception: JSON.stringify({ event: 'console', data: { level, message: `[engine] ${message}`, source: 'engine', line: 0, column: 0 } }) });
  },

  inception_gfx_create_context__deps: ['$GL', '$inceptionGfx', '$inceptionReport', '$inceptionPageContextCap', 'inception_gfx_request_frame'],
  inception_gfx_create_context: (width, height, requestedPageContexts) => {
    if (typeof OffscreenCanvas === 'undefined') {
      inceptionReport('warn', 'no OffscreenCanvas in the engine worker; painting on the CPU');
      return 0;
    }
    const canvas = new OffscreenCanvas(width, height);
    let handle = 0;
    try {
      handle = GL.createContext(canvas, {
      majorVersion: 2,
      minorVersion: 0,
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      });
    } catch (e) {
      inceptionReport('warn', `WebGL2 context creation threw: ${e}`);
    }
    if (!handle) {
      inceptionReport('warn', 'WebGL2 is unavailable in the engine worker; painting on the CPU');
      return 0;
    }
    inceptionGfx.canvas = canvas;
    const gl = GL.getContext(handle).GLctx;
    // Skia asks for the GPU's name; without the extension that is an error.
    gl.getExtension('WEBGL_debug_renderer_info');
    globalThis.inceptionPageContextCap = inceptionPageContextCap(gl, requestedPageContexts);
    // Pages' WebGL contexts are capped so the browser never reclaims this one.
    // If it is lost anyway (a GPU reset, another WebGL user in the host page),
    // painting pauses and resumes on a rebuilt Skia context once it is back.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      inceptionGfx.contextState = 1;
      inceptionReport('warn', 'the engine lost its WebGL context; painting resumes when it is restored');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      inceptionGfx.contextState = 2;
      inceptionReport('info', 'the engine\'s WebGL context is back; rebuilding');
      Module._inception_gfx_context_restored();
    });
    return handle;
  },

  // Development aid: loses the engine's own WebGL context and restores it
  // after `restoreAfterMs`, to exercise the recovery path.
  inception_gfx_debug_lose_context__deps: ['$GL', '$inceptionGfx'],
  inception_gfx_debug_lose_context: (restoreAfterMs) => {
    const context = Object.values(GL.contexts).find((c) => c && c.GLctx && c.GLctx.canvas === inceptionGfx.canvas);
    const lose = context?.GLctx.getExtension('WEBGL_lose_context');
    if (!lose) return;
    lose.loseContext();
    setTimeout(() => lose.restoreContext(), restoreAfterMs);
  },

  inception_gfx_page_context_cap: () => globalThis.inceptionPageContextCap | 0,

  // 0: usable, 1: lost, 2: restored and not yet rebuilt (read once).
  inception_gfx_take_context_state__deps: ['$inceptionGfx'],
  inception_gfx_take_context_state: () => {
    const state = inceptionGfx.contextState;
    if (state === 2) inceptionGfx.contextState = 0;
    return state;
  },

  inception_gfx_resize__deps: ['$inceptionGfx'],
  inception_gfx_resize: (width, height) => {
    const canvas = inceptionGfx.canvas;
    if (!canvas) return;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  },

  // WebKit returns a blank bitmap from transferToImageBitmap() on a WebGL
  // canvas that no page compositing step has displayed, which is every frame
  // in a worker. Drawing the canvas into a 2D one and transferring that gives
  // the frame reliably; other engines keep the copy-free path.
  $inceptionGfxBitmap__deps: ['$inceptionGfx'],
  $inceptionGfxBitmap: () => {
    const source = inceptionGfx.canvas;
    if (inceptionGfx.copyFrames === undefined)
      inceptionGfx.copyFrames = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg.test(navigator.userAgent);
    if (!inceptionGfx.copyFrames) return source.transferToImageBitmap();
    const copy = inceptionGfx.copy ??= new OffscreenCanvas(source.width, source.height);
    if (copy.width !== source.width) copy.width = source.width;
    if (copy.height !== source.height) copy.height = source.height;
    const context = inceptionGfx.copyContext ??= copy.getContext('2d');
    context.clearRect(0, 0, copy.width, copy.height);
    context.drawImage(source, 0, 0);
    return copy.transferToImageBitmap();
  },

  inception_gfx_present__deps: ['$inceptionGfx', '$inceptionGfxBitmap', '$inceptionReport'],
  inception_gfx_present: (window) => {
    try {
      const bitmap = inceptionGfxBitmap();
      postMessage({ inceptionFrame: bitmap, window }, [bitmap]);
    } catch (e) {
      inceptionReport('error', `present failed: ${e}`);
    }
  },

  // CPU fallback: the pixels live in shared memory, which cannot be transferred,
  // so they are copied once into a buffer the host receives without another copy.
  inception_gfx_present_pixels: (window, pixels, width, height) => {
    const bytes = HEAPU8.slice(pixels, pixels + width * height * 4);
    postMessage({ inceptionPixels: { width, height, buffer: bytes.buffer }, window }, [bytes.buffer]);
  },

  // Frames are paced by the host page's requestAnimationFrame: the engine asks
  // once, the host answers on its next frame. Worker-side rAF is not reliable
  // for a canvas that is not tied to the page.
  inception_gfx_request_frame__deps: ['$inceptionGfx'],
  inception_gfx_request_frame: (window) => {
    if (inceptionGfx.requested[window]) return;
    inceptionGfx.requested[window] = true;
    postMessage({ inceptionWantsFrame: window });
  },

  $inceptionGfxInstall__deps: ['$inceptionGfx', 'inception_loop_schedule'],
  $inceptionGfxInstall__postset: 'inceptionGfxInstall();',
  $inceptionGfxInstall: () => {
    if (!ENVIRONMENT_IS_PTHREAD) return;
    self.addEventListener('message', (e) => {
      const tick = e.data?.inceptionFrameTick;
      if (!tick) return;
      const window = Number.isInteger(tick) && tick > 0 ? tick : 1;
      delete inceptionGfx.requested[window];
      Module._inception_gfx_frame(window);
      _inception_loop_schedule(0);
    });
  },
});
