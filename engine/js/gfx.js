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

  // Whether a frame the engine presents arrives whole. It writes the canvas
  // with a blit, and WebKit has handed out blank bitmaps after the first for
  // a canvas that only a blit wrote since; the engine clears a pixel first
  // (Renderer::paintGPU), which this tries on a small canvas of its own,
  // before the engine's context exists so it counts against no cap.
  $inceptionGfxFramesArrive: () => {
    try {
      const canvas = new OffscreenCanvas(4, 4);
      const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
      if (!gl) return true;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 4, 4);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      let whole = true;
      for (let frame = 0; frame < 2; frame++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.clearColor(0, 1, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, 1, 1);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.SCISSOR_TEST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
        gl.blitFramebuffer(0, 0, 4, 4, 0, 0, 4, 4, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        const bitmap = canvas.transferToImageBitmap();
        if (frame === 1) {
          const check = new OffscreenCanvas(4, 4).getContext('2d');
          check.drawImage(bitmap, 0, 0);
          whole = check.getImageData(2, 2, 1, 1).data[1] > 0;
        }
        bitmap.close();
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return whole;
    } catch (e) {
      return true;
    }
  },

  inception_gfx_create_context__deps: ['$GL', '$inceptionGfx', '$inceptionReport', '$inceptionPageContextCap', '$inceptionGfxFramesArrive', 'inception_gfx_request_frame'],
  inception_gfx_create_context: (width, height, requestedPageContexts) => {
    if (typeof OffscreenCanvas === 'undefined') {
      inceptionReport('warn', 'no OffscreenCanvas in the engine worker; painting on the CPU');
      return 0;
    }
    inceptionGfx.copyFrames = !inceptionGfxFramesArrive();
    if (inceptionGfx.copyFrames)
      inceptionReport('warn', 'presented frames arrive blank in this browser; copying each one');
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

  // A browser whose presented frames arrive blank ($inceptionGfxFramesArrive)
  // gets each frame drawn into a 2D canvas and that one transferred instead:
  // a full copy per frame.
  $inceptionGfxBitmap__deps: ['$inceptionGfx'],
  $inceptionGfxBitmap: () => {
    const source = inceptionGfx.canvas;
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
