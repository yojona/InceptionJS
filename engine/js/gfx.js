// Engine-side graphics: the engine owns an OffscreenCanvas and its WebGL2
// context; each finished frame moves to the host as an ImageBitmap (no copy).
addToLibrary({
  $inceptionGfx: { canvas: null, frameRequested: false },

  // Engine diagnostics reach the host as console events, since worker consoles
  // are easy to miss.
  $inceptionReport: (level, message) => {
    postMessage({ inception: JSON.stringify({ event: 'console', data: { level, message: `[engine] ${message}`, source: 'engine', line: 0, column: 0 } }) });
  },

  inception_gfx_create_context__deps: ['$GL', '$inceptionGfx', '$inceptionReport'],
  inception_gfx_create_context: (width, height) => {
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
    return handle;
  },

  inception_gfx_resize__deps: ['$inceptionGfx'],
  inception_gfx_resize: (width, height) => {
    const canvas = inceptionGfx.canvas;
    if (!canvas) return;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  },

  inception_gfx_present__deps: ['$inceptionGfx'],
  inception_gfx_present: () => {
    const bitmap = inceptionGfx.canvas.transferToImageBitmap();
    postMessage({ inceptionFrame: bitmap }, [bitmap]);
  },

  // CPU fallback: the pixels live in shared memory, which cannot be transferred,
  // so they are copied once into a buffer the host receives without another copy.
  inception_gfx_present_pixels: (pixels, width, height) => {
    const bytes = HEAPU8.slice(pixels, pixels + width * height * 4);
    postMessage({ inceptionPixels: { width, height, buffer: bytes.buffer } }, [bytes.buffer]);
  },

  inception_gfx_request_frame__deps: ['$inceptionGfx'],
  inception_gfx_request_frame: () => {
    if (inceptionGfx.frameRequested) return;
    inceptionGfx.frameRequested = true;
    const run = () => {
      inceptionGfx.frameRequested = false;
      Module._inception_gfx_frame();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  },
});
