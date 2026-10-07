// Engine-side graphics: the engine owns an OffscreenCanvas and its WebGL2
// context; each finished frame moves to the host as an ImageBitmap (no copy).
addToLibrary({
  $inceptionGfx: { canvas: null, frameRequested: false },

  inception_gfx_create_context__deps: ['$GL', '$inceptionGfx'],
  inception_gfx_create_context: (width, height) => {
    if (typeof OffscreenCanvas === 'undefined') return 0;
    const canvas = new OffscreenCanvas(width, height);
    const handle = GL.createContext(canvas, {
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
    if (!handle) return 0;
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
