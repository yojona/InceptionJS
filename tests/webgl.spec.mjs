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
