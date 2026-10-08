import { expect, test } from '@playwright/test';

// WebGL 1 as pages expect it: its own extensions, shading language and
// errors, and the drawing buffer the page asked for.

const PAGE = process.env.PAGE_PATH ?? '/';

const view = (page) => page.locator('inception-view');
const evaluate = async (page, source) => JSON.parse(await view(page).evaluate((el, s) => el.debugEvaluate(s), source));

test.beforeEach(async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  await view(page).evaluate((el) => el.ready);
});

const compile = `(gl, type, source) => {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return !!gl.getShaderParameter(shader, gl.COMPILE_STATUS);
}`;

test('WebGL 1 offers its own extensions', async ({ page }) => {
  const result = await evaluate(page, `(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const names = gl.getSupportedExtensions();
    return JSON.stringify({ webgl2: gl instanceof WebGL2RenderingContext, names });
  })()`);
  expect(result.webgl2).toBe(false);
  for (const name of ['ANGLE_instanced_arrays', 'OES_vertex_array_object', 'OES_standard_derivatives', 'OES_element_index_uint', 'OES_texture_float', 'WEBGL_depth_texture'])
    expect(result.names).toContain(name);
});

test('WebGL 1 compiles GLSL ES 1.00 with its extensions and refuses 3.00', async ({ page }) => {
  const result = await evaluate(page, `(() => {
    const compile = ${compile};
    const gl = document.createElement('canvas').getContext('webgl');
    const derivatives = '#extension GL_OES_standard_derivatives : enable\\nprecision mediump float; varying vec2 v; void main() { gl_FragColor = vec4(dFdx(v.x)); }';
    const before = compile(gl, gl.FRAGMENT_SHADER, derivatives);
    gl.getExtension('OES_standard_derivatives');
    const after = compile(gl, gl.FRAGMENT_SHADER, derivatives);
    const es3 = '#version 300 es\\nprecision mediump float; out vec4 c; void main() { c = vec4(1.0); }';
    const gl2 = document.createElement('canvas').getContext('webgl2');
    return JSON.stringify({ before, after, es3InWebGL1: compile(gl, gl.FRAGMENT_SHADER, es3), es3InWebGL2: compile(gl2, gl2.FRAGMENT_SHADER, es3) });
  })()`);
  expect(result).toEqual({ before: false, after: true, es3InWebGL1: false, es3InWebGL2: true });
});

test('WebGL 2 enums and formats are errors in WebGL 1', async ({ page }) => {
  const result = await evaluate(page, `(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const max3D = gl.getParameter(0x8073); // MAX_3D_TEXTURE_SIZE
    const parameterError = gl.getError();
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
    const floatWithout = gl.getError();
    gl.getExtension('OES_texture_float');
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
    const floatWith = gl.getError();
    gl.texImage2D(gl.TEXTURE_2D, 0, 0x8058 /* RGBA8 */, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const sizedFormat = gl.getError();
    return JSON.stringify({ max3D, parameterError, floatWithout, floatWith, sizedFormat });
  })()`);
  expect(result).toEqual({ max3D: null, parameterError: 0x0500, floatWithout: 0x0500, floatWith: 0, sizedFormat: 0x0501 });
});

test('WebGL 1 vertex arrays and instancing come from their extensions', async ({ page }) => {
  const pixel = await evaluate(page, `(() => {
    const compile = ${compile};
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 4;
    const gl = canvas.getContext('webgl');
    const vao = gl.getExtension('OES_vertex_array_object');
    const instancing = gl.getExtension('ANGLE_instanced_arrays');
    const program = gl.createProgram();
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, 'attribute vec2 p; attribute float o; void main() { gl_Position = vec4(p + vec2(o, 0.0), 0.0, 1.0); }');
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, 'precision mediump float; void main() { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); }');
    gl.compileShader(fs);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'p');
    gl.bindAttribLocation(program, 1, 'o');
    gl.linkProgram(program);
    gl.useProgram(program);
    const array = vao.createVertexArrayOES();
    vao.bindVertexArrayOES(array);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
    instancing.vertexAttribDivisorANGLE(1, 1);
    vao.bindVertexArrayOES(null);
    // The default vertex array is untouched by the one above.
    const defaultEnabled = gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_ENABLED);
    vao.bindVertexArrayOES(array);
    instancing.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 3, 1);
    const p = new Uint8Array(4);
    gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
    return JSON.stringify({ defaultEnabled, pixel: [...p], error: gl.getError() });
  })()`);
  expect(pixel).toEqual({ defaultEnabled: false, pixel: [255, 0, 255, 255], error: 0 });
});

test('the drawing buffer has the attributes the page asked for', async ({ page }) => {
  const result = await evaluate(page, `(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
    const attributes = gl.getContextAttributes();
    gl.clearColor(0.5, 0.5, 0.5, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const p = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
    return JSON.stringify({
      alpha: attributes.alpha, antialias: attributes.antialias,
      preserveDrawingBuffer: attributes.preserveDrawingBuffer, premultipliedAlpha: attributes.premultipliedAlpha,
      opaqueAlpha: p[3],
    });
  })()`);
  expect(result).toEqual({ alpha: false, antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false, opaqueAlpha: 255 });
});
