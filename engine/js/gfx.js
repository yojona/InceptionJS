// Engine-side graphics: the engine owns an OffscreenCanvas and its WebGL2
// context; each finished frame moves to the host as an ImageBitmap (no copy).
addToLibrary({
  $inceptionGfx: { canvas: null, frameRequested: false, contextState: 0 },

  // How many WebGL contexts pages may hold at once. Browsers lose their oldest
  // context past a per-page cap, and the engine's own is created first, so the
  // pages get the cap minus the engine's context and one spare for the embedding
  // page's own WebGL. The cap is not exposed; it follows the renderer: sixteen
  // on a GPU in Chromium and WebKit, four on a software rasterizer, far more in
  // Firefox. `requested` (the embedder's webglContexts option) wins when set.
  $inceptionPageContextCap: (gl, requested) => {
    if (requested > 0) return requested;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String((info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) || '');
    if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)) return 3;
    if (/firefox/i.test(navigator.userAgent)) return 30;
    return 14;
  },

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

  inception_gfx_present__deps: ['$inceptionGfx', '$inceptionReport'],
  inception_gfx_present: () => {
    try {
      const bitmap = inceptionGfx.canvas.transferToImageBitmap();
      postMessage({ inceptionFrame: bitmap }, [bitmap]);
    } catch (e) {
      inceptionReport('error', `present failed: ${e}`);
    }
  },

  // CPU fallback: the pixels live in shared memory, which cannot be transferred,
  // so they are copied once into a buffer the host receives without another copy.
  inception_gfx_present_pixels: (pixels, width, height) => {
    const bytes = HEAPU8.slice(pixels, pixels + width * height * 4);
    postMessage({ inceptionPixels: { width, height, buffer: bytes.buffer } }, [bytes.buffer]);
  },

  // Frames are paced by the host page's requestAnimationFrame: the engine asks
  // once, the host answers on its next frame. Worker-side rAF is not reliable
  // for a canvas that is not tied to the page.
  inception_gfx_request_frame__deps: ['$inceptionGfx'],
  inception_gfx_request_frame: () => {
    if (inceptionGfx.frameRequested) return;
    inceptionGfx.frameRequested = true;
    postMessage({ inceptionWantsFrame: 1 });
  },

  $inceptionGfxInstall__deps: ['$inceptionGfx', 'inception_loop_schedule'],
  $inceptionGfxInstall__postset: 'inceptionGfxInstall();',
  $inceptionGfxInstall: () => {
    if (!ENVIRONMENT_IS_PTHREAD) return;
    self.addEventListener('message', (e) => {
      if (!e.data?.inceptionFrameTick) return;
      inceptionGfx.frameRequested = false;
      Module._inception_gfx_frame();
      _inception_loop_schedule(0);
    });
  },
});
