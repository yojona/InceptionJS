import { expect, test } from '@playwright/test';

const PAGE = process.env.PAGE_PATH ?? '/';

const view = (page) => page.locator('inception-view');
const evaluate = (page, source) => view(page).evaluate((el, s) => el.debugEvaluate(s), source);

test.beforeEach(async ({ page }) => {
  await page.goto(`${PAGE}?url=about:blank`);
  await view(page).evaluate((el) => el.ready);
});

for (const kind of ['webgl', 'webgl2']) {
  test(`${kind}: a page draws and reads back its own pixels`, async ({ page }) => {
    const result = JSON.parse(await evaluate(page, `(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 64;
      document.body.append(canvas);
      const gl = canvas.getContext('${kind}');
      if (!gl) return JSON.stringify({ context: false });
      gl.clearColor(1, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const pixel = new Uint8Array(4);
      gl.readPixels(8, 8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return JSON.stringify({ context: true, pixel: [...pixel], error: gl.getError() });
    })()`));
    expect(result).toEqual({ context: true, pixel: [255, 0, 0, 255], error: 0 });
  });
}

test('a WebGL triangle reaches the screen', async ({ page }) => {
  await evaluate(page, `(() => {
    document.body.style.margin = '0';
    const canvas = document.createElement('canvas');
    canvas.width = 200; canvas.height = 200;
    document.body.append(canvas);
    const gl = canvas.getContext('webgl');
    const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); return s; };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, 'precision mediump float; void main() { gl_FragColor = vec4(0.0, 0.0, 1.0, 1.0); }'));
    gl.linkProgram(program);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 0, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return 'ok';
  })()`);
  // The view's own canvas shows blue near the triangle's center.
  await expect.poll(() => page.evaluate(async () => {
    const canvas = document.querySelector('inception-view').shadowRoot.querySelector('canvas');
    const bitmap = await createImageBitmap(canvas);
    const copy = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    copy.drawImage(bitmap, 0, 0);
    const scale = bitmap.width / canvas.getBoundingClientRect().width;
    const [r, g, b] = copy.getImageData(Math.round(100 * scale), Math.round(120 * scale), 1, 1).data;
    return [r, g, b];
  }), { timeout: 20_000 }).toEqual([0, 0, 255]);
});

test('the real GPU is reported through WEBGL_debug_renderer_info', async ({ page }) => {
  const renderer = await evaluate(page, `(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'no extension';
  })()`);
  const hostRenderer = await page.evaluate(() => {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  });
  expect(renderer).toBe(hostRenderer);
});

test('many short-lived page contexts leave the engine painting', async ({ page }) => {
  const warnings = [];
  page.on('console', (m) => { if (/Too many active WebGL contexts|invalid capability/.test(m.text())) warnings.push(m.text()); });
  const lost = await evaluate(page, `(() => {
    let lost = 0;
    for (let i = 0; i < 50; i++) {
      const canvas = document.createElement('canvas');
      canvas.addEventListener('webglcontextlost', () => lost++);
      const gl = canvas.getContext(i % 2 ? 'webgl' : 'webgl2');
      gl.enable(gl.BLEND);
      gl.clearColor(0, 1, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    return String(lost);
  })()`);
  expect(Number(lost)).toBeGreaterThanOrEqual(0);
  expect(warnings).toEqual([]);
  // The engine still paints: a new page renders.
  await evaluate(page, `document.body.innerHTML = '<div id="x" style="width:100px;height:100px;background:rgb(255,0,0)"></div>'; document.body.style.margin = '0'; 'ok'`);
  await expect.poll(() => page.evaluate(async () => {
    const canvas = document.querySelector('inception-view').shadowRoot.querySelector('canvas');
    const bitmap = await createImageBitmap(canvas);
    const copy = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    copy.drawImage(bitmap, 0, 0);
    return [...copy.getImageData(10, 10, 1, 1).data.slice(0, 3)];
  }), { timeout: 20_000 }).toEqual([255, 0, 0]);
});

const screenPixel = (page, x, y) => page.evaluate(async ([x, y]) => {
  const canvas = document.querySelector('inception-view').shadowRoot.querySelector('canvas');
  const bitmap = await createImageBitmap(canvas);
  const copy = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
  copy.drawImage(bitmap, 0, 0);
  return [...copy.getImageData(x, y, 1, 1).data.slice(0, 3)];
}, [x, y]);

test('the page context budget follows the renderer, or the embedder', async ({ page }) => {
  // Chromium caps WebGL contexts in workers at four, whatever the GPU.
  expect(await view(page).evaluate((el) => el.ready.then((r) => r.webglContexts))).toBe(3);
  await page.goto(`${PAGE}?url=about:blank&webgl-contexts=2`);
  expect(await view(page).evaluate((el) => el.ready.then((r) => r.webglContexts))).toBe(2);
});

test('pages hold many WebGL contexts at once, each with its own state', async ({ page }) => {
  // Sixteen contexts (WebKit's per-page limit, as in browsers), far past the
  // host's per-worker cap: none is lost, and each keeps its own clear color,
  // scissor and bindings while the others draw.
  const result = JSON.parse(await evaluate(page, `(() => {
    const contexts = [];
    for (let i = 0; i < 16; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 16;
      document.body.append(canvas);
      const gl = canvas.getContext(i % 2 ? 'webgl' : 'webgl2');
      gl.clearColor(i / 15, 1 - i / 15, (i % 3) / 2, 1);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, 8 + (i % 8), 8);
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      contexts.push(gl);
    }
    const results = contexts.map((gl, i) => {
      gl.clear(gl.COLOR_BUFFER_BIT);
      const inside = new Uint8Array(4), outside = new Uint8Array(4);
      gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, inside);
      gl.readPixels(15, 15, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, outside);
      return {
        lost: gl.isContextLost(),
        inside: [...inside],
        outside: [...outside],
        scissor: [...gl.getParameter(gl.SCISSOR_BOX)],
        textureBound: gl.getParameter(gl.TEXTURE_BINDING_2D) !== null,
        error: gl.getError(),
      };
    });
    return JSON.stringify(results);
  })()`));
  expect(result).toHaveLength(16);
  result.forEach((r, i) => {
    const expected = [Math.round(255 * i / 15), Math.round(255 * (1 - i / 15)), Math.round(255 * (i % 3) / 2), 255];
    expect(r.lost).toBe(false);
    r.inside.forEach((v, c) => expect(Math.abs(v - expected[c])).toBeLessThanOrEqual(1));
    expect(r.outside).toEqual([0, 0, 0, 0]);
    expect(r.scissor).toEqual([0, 0, 8 + (i % 8), 8]);
    expect(r.textureBound).toBe(true);
    expect(r.error).toBe(0);
  });
});

test('interleaved draws in two contexts keep their vertex state apart', async ({ page }) => {
  const pixels = JSON.parse(await evaluate(page, `(() => {
    const make = (kind, color) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 8;
      const gl = canvas.getContext(kind);
      const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); return s; };
      const program = gl.createProgram();
      gl.attachShader(program, shader(gl.VERTEX_SHADER, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, 'precision mediump float; uniform vec4 c; void main() { gl_FragColor = c; }'));
      gl.linkProgram(program);
      gl.useProgram(program);
      gl.uniform4fv(gl.getUniformLocation(program, 'c'), color);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      return gl;
    };
    const a = make('webgl', [1, 0, 0, 1]);
    const b = make('webgl', [0, 0, 1, 1]);
    const c = make('webgl2', [0, 1, 0, 1]);
    const draw = (gl) => { gl.drawArrays(gl.TRIANGLES, 0, 3); const p = new Uint8Array(4); gl.readPixels(4, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); return [...p]; };
    return JSON.stringify([draw(a), draw(b), draw(c), draw(a), draw(c), draw(b)]);
  })()`));
  expect(pixels).toEqual([[255, 0, 0, 255], [0, 0, 255, 255], [0, 255, 0, 255], [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]]);
});

test('losing a page context leaves the others working', async ({ page }) => {
  const result = JSON.parse(await evaluate(page, `(() => {
    const a = document.createElement('canvas').getContext('webgl2');
    const b = document.createElement('canvas').getContext('webgl2');
    a.getExtension('WEBGL_lose_context').loseContext();
    b.clearColor(0, 1, 0, 1);
    b.clear(b.COLOR_BUFFER_BIT);
    const p = new Uint8Array(4);
    b.readPixels(0, 0, 1, 1, b.RGBA, b.UNSIGNED_BYTE, p);
    return JSON.stringify({ aLost: a.isContextLost(), bLost: b.isContextLost(), pixel: [...p] });
  })()`));
  expect(result).toEqual({ aLost: true, bLost: false, pixel: [0, 255, 0, 255] });
});

test('the engine recovers when its own WebGL context is lost', async ({ page }) => {
  await evaluate(page, `document.body.style.margin = '0'; document.body.innerHTML = '<div style="width:100px;height:100px;background:rgb(0,0,255)"></div>'; 'ok'`);
  await expect.poll(() => screenPixel(page, 10, 10), { timeout: 20_000 }).toEqual([0, 0, 255]);
  await view(page).evaluate((el) => el.debugCommand('debug.loseGPU', { restoreAfterMs: 300 }));
  await page.waitForTimeout(1000);
  await evaluate(page, `document.body.firstChild.style.background = 'rgb(255,0,0)'; 'ok'`);
  await expect.poll(() => screenPixel(page, 10, 10), { timeout: 20_000 }).toEqual([255, 0, 0]);
});
