// Performance baseline: measures a fixed set of things every change can be
// compared against, writes a JSON report, and fails when a budget is exceeded.
//
//   node tests/perf/run.mjs [--out report.json] [--budgets tests/perf/budgets.json]
//                           [--only startup,load,scroll,media,memory,windows]
//   ENGINE_DIR=<dir with inception-engine.*>   (default .work/out/engine)
//   PORT=<dev server port>                     (default 8090)
//
// Timings that cross the network vary run to run; budgets leave room for that.
// The report keeps every sample so a reviewer can see the spread.

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { brotliCompressSync, constants as zlib } from 'node:zlib';
import { startRelay } from '../../packages/inceptionjs/src/server/relay.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: '' },
    budgets: { type: 'string', default: resolve(root, 'tests/perf/budgets.json') },
    only: { type: 'string', default: 'startup,load,scroll,media,memory,windows' },
  },
});
const sections = new Set(args.only.split(','));
const engineDir = resolve(root, process.env.ENGINE_DIR ?? '.work/out/engine');
const port = Number(process.env.PORT ?? 8090);
const base = `http://127.0.0.1:${port}`;

// The fixed page set. Kept small: each one costs a full load through the relay.
const PAGES = {
  wikipedia: 'https://en.wikipedia.org/wiki/Web_browser',
  youtubeHome: 'https://www.youtube.com/',
  youtubeWatch: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  news: 'https://www.bbc.com/news',
};

const report = { date: new Date().toISOString(), engineDir, metrics: {}, samples: {} };
const metric = (name, value, unit) => (report.metrics[name] = { value: Math.round(value * 100) / 100, unit });

function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// --- sizes (no browser needed) ------------------------------------------------

for (const ext of ['js', 'wasm', 'data']) {
  const file = resolve(engineDir, `inception-engine.${ext}`);
  const bytes = readFileSync(file);
  // Quality 9 rather than 11: within a few percent and minutes faster on 70 MB.
  const brotli = brotliCompressSync(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9, [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.length } });
  metric(`size.${ext}.raw`, statSync(file).size / 1e6, 'MB');
  metric(`size.${ext}.brotli`, brotli.length / 1e6, 'MB');
}
metric('size.total.brotli', ['js', 'wasm', 'data'].reduce((sum, ext) => sum + report.metrics[`size.${ext}.brotli`].value, 0), 'MB');

// --- browser ------------------------------------------------------------------

const server = spawn(process.execPath, ['tests/serve.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), ENGINE_DIR: engineDir }, stdio: 'ignore' });
const relay = await startRelay({ log: () => {} });
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});

// Counts presented frames: every engine frame reaches the view's canvas through
// a bitmaprenderer context. Measurement only; nothing in the product changes.
const FRAME_PROBE = () => {
  window.__frames = [];
  const original = ImageBitmapRenderingContext.prototype.transferFromImageBitmap;
  ImageBitmapRenderingContext.prototype.transferFromImageBitmap = function (bitmap) {
    window.__frames.push(performance.now());
    return original.call(this, bitmap);
  };
};

async function openView(page, url) {
  await page.addInitScript(FRAME_PROBE);
  const query = new URLSearchParams({ url, wisp: relay.url, persist: 'clear', profile: `perf-${Date.now()}` });
  await page.goto(`${base}/examples/basic.html?${query}`);
}

// Loads `url` in the open view and resolves with the time until the engine
// reports the load finished and the first frame after it.
function loadIn(page, url, timeout = 90_000) {
  return page.evaluate(
    ([target, limit]) =>
      new Promise((resolveLoad, rejectLoad) => {
        const view = document.getElementById('view');
        const start = performance.now();
        const timer = setTimeout(() => rejectLoad(new Error(`load of ${target} timed out`)), limit);
        // Only the target's own load counts, not a late event from the page
        // before it (redirects stay on the same site).
        const site = (u) => new URL(u).hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
        const onTarget = () => { try { return site(view.url) === site(target); } catch { return false; } };
        let sawLoading = false;
        view.addEventListener('loading', function onLoading(e) {
          if (e.detail.loading) sawLoading = true;
          else if (sawLoading && onTarget()) {
            view.removeEventListener('loading', onLoading);
            clearTimeout(timer);
            const frames = window.__frames.length;
            const waitFrame = () => (window.__frames.length > frames ? resolveLoad(performance.now() - start) : requestAnimationFrame(waitFrame));
            waitFrame();
          }
        });
        view.navigate(target);
      }),
    [url, timeout],
  );
}

async function wait(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

try {
  await waitForServer();

  if (sections.has('startup')) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
    await openView(page, 'https://example.com/');
    const ready = await page.evaluate(() => document.getElementById('view').ready.then(() => performance.now()));
    metric('startup.ready', ready, 'ms');
    // First frame with content: the canvas stops being one flat colour.
    const painted = await page.evaluate(
      () =>
        new Promise((resolvePaint) => {
          const canvas = document.getElementById('view').shadowRoot.querySelector('canvas');
          const tick = async () => {
            if (canvas.width && window.__frames.length) {
              const bitmap = await createImageBitmap(canvas);
              const copy = new OffscreenCanvas(bitmap.width, bitmap.height);
              const context = copy.getContext('2d');
              context.drawImage(bitmap, 0, 0);
              const { data } = context.getImageData(0, 0, copy.width, copy.height);
              for (let i = 4; i < data.length; i += 4 * 97)
                if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) return resolvePaint(performance.now());
            }
            setTimeout(tick, 50);
          };
          tick();
        }),
    );
    metric('startup.firstContentfulFrame.exampleCom', painted, 'ms');
    await page.close();
  }

  if (sections.has('load') || sections.has('scroll') || sections.has('memory')) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
    await openView(page, 'about:blank');
    await page.evaluate(() => document.getElementById('view').ready);
    const heaps = [];
    const heap = async () => heaps.push(await page.evaluate(() => document.getElementById('view').debugHeap()));

    if (sections.has('load')) {
      for (const [name, url] of Object.entries(PAGES)) {
        try {
          metric(`load.${name}`, await loadIn(page, url), 'ms');
        } catch (error) {
          metric(`load.${name}`, NaN, 'ms');
          report.samples[`load.${name}.error`] = String(error.message);
        }
        await heap();
      }
    }

    if (sections.has('scroll')) {
      await loadIn(page, PAGES.wikipedia).catch(() => {});
      await wait(1500);
      const box = await page.locator('#view').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const before = await page.evaluate(() => window.__frames.length);
      const started = await page.evaluate(() => performance.now());
      // About five seconds of wheel input at display rate, down then up, so
      // the frame rate measures the engine and not the input cadence.
      for (let i = 0; i < 300; i++) {
        await page.mouse.wheel(0, i < 150 ? 40 : -40);
        await wait(16);
      }
      const frames = await page.evaluate(([from, since]) => window.__frames.slice(from).filter((t) => t >= since), [before, started]);
      const intervals = frames.slice(1).map((t, i) => t - frames[i]);
      const seconds = (frames.at(-1) - frames[0]) / 1000;
      metric('scroll.fps.mean', intervals.length / (seconds || 1), 'fps');
      metric('scroll.frameTime.p50', percentile(intervals, 50), 'ms');
      metric('scroll.frameTime.p95', percentile(intervals, 95), 'ms');
      metric('scroll.frameTime.p99', percentile(intervals, 99), 'ms');
      report.samples['scroll.frameTimes'] = intervals.map((v) => Math.round(v * 10) / 10);
      await heap();
    }

    if (sections.has('memory') && heaps.length) {
      metric('memory.wasm.peak', Math.max(...heaps.map((h) => h.memory)) / 1e6, 'MB');
      metric('memory.jsHeap.peak', Math.max(...heaps.map((h) => h.heapSize)) / 1e6, 'MB');
      report.samples['memory.heaps'] = heaps;
    }
    await page.close();
  }

  if (sections.has('media')) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
    await openView(page, 'about:blank');
    await page.evaluate(() => document.getElementById('view').ready);
    // Time from navigating to the watch page until the host video has advanced.
    const ttff = await page.evaluate(
      (url) =>
        new Promise((resolveMedia) => {
          const view = document.getElementById('view');
          const start = performance.now();
          const tick = () => {
            const playing = [...view.shadowRoot.querySelectorAll('video, audio')].some((v) => v.currentTime > 0 && !v.paused);
            if (playing) return resolveMedia(performance.now() - start);
            if (performance.now() - start > 90_000) return resolveMedia(NaN);
            setTimeout(tick, 100);
          };
          view.navigate(url);
          tick();
        }),
      PAGES.youtubeWatch,
    );
    metric('media.timeToFirstFrame.youtubeWatch', ttff, 'ms');
    await page.close();
  }
  // Two visible windows of one engine at different sizes, both animating:
  // every presented frame resizes the shared canvas. Frame times per window
  // against one window alone, and what the second window costs in memory.
  if (sections.has('windows')) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
    await page.addInitScript(() => {
      window.__byCanvas = new Map();
      const original = ImageBitmapRenderingContext.prototype.transferFromImageBitmap;
      ImageBitmapRenderingContext.prototype.transferFromImageBitmap = function (bitmap) {
        const list = window.__byCanvas.get(this.canvas) ?? [];
        list.push(performance.now());
        window.__byCanvas.set(this.canvas, list);
        return original.call(this, bitmap);
      };
    });
    await openView(page, 'about:blank');
    await page.evaluate(() => document.getElementById('view').ready);
    const animate = (window) => page.evaluate((w) => document.getElementById('view').debugEvaluate(`document.body.style.margin = '0'; document.body.style.height = '100vh';
      let hue = 0; (function step() { document.body.style.background = 'hsl(' + (hue = (hue + 7) % 360) + ' 70% 50%)'; requestAnimationFrame(step); })(); 'ok'`, { window: w }), window);
    const measure = async (ms) => {
      await page.evaluate(() => window.__byCanvas.clear());
      await wait(ms);
      return page.evaluate(() => [...window.__byCanvas.values()].map((times) => times.slice(1).map((t, i) => t - times[i])));
    };
    await animate(1);
    await wait(1000);
    const [alone] = await measure(5000);
    metric('windows.one.frameTime.p50', percentile(alone ?? [], 50), 'ms');
    metric('windows.one.frameTime.p95', percentile(alone ?? [], 95), 'ms');
    const before = await page.evaluate(() => document.getElementById('view').debugHeap());
    const id = await page.evaluate(async () => {
      const view = document.getElementById('view');
      const handle = await view.openWindow({ width: 480, height: 320, url: 'about:blank' });
      const element = document.createElement('inception-window');
      element.style.cssText = 'width: 480px; height: 320px; display: block';
      element.view = view;
      element.setAttribute('window', String(handle.id));
      document.body.append(element);
      return handle.id;
    });
    await wait(1500);
    await animate(id);
    await wait(1000);
    const both = await measure(5000);
    const intervals = both.flat();
    metric('windows.two.frameTime.p50', percentile(intervals, 50), 'ms');
    metric('windows.two.frameTime.p95', percentile(intervals, 95), 'ms');
    metric('windows.two.framesPerWindow', Math.min(...both.map((list) => list.length)) / 5, 'fps');
    const after = await page.evaluate(() => document.getElementById('view').debugHeap());
    metric('windows.secondWindow.wasmMemory', (after.memory - before.memory) / 1e6, 'MB');
    metric('windows.secondWindow.jsHeap', (after.heapSize - before.heapSize) / 1e6, 'MB');
    report.samples['windows.two.frameTimes'] = both.map((list) => list.map((v) => Math.round(v * 10) / 10));
    await page.close();
  }
} finally {
  await browser.close();
  await relay.close();
  server.kill();
}

// --- budgets --------------------------------------------------------------------

const budgets = JSON.parse(readFileSync(args.budgets, 'utf8'));
const over = [];
for (const [name, { max, min }] of Object.entries(budgets)) {
  const m = report.metrics[name];
  if (!m) continue;
  if (Number.isNaN(m.value)) over.push(`${name}: no measurement`);
  else if (max !== undefined && m.value > max) over.push(`${name}: ${m.value} ${m.unit} > ${max}`);
  else if (min !== undefined && m.value < min) over.push(`${name}: ${m.value} ${m.unit} < ${min}`);
}
report.budgetFailures = over;

const json = JSON.stringify(report, null, 2) + '\n';
if (args.out) writeFileSync(args.out, json);
for (const [name, { value, unit }] of Object.entries(report.metrics)) console.log(`${name.padEnd(44)} ${String(value).padStart(10)} ${unit}`);
if (over.length) {
  console.error(`\nOver budget:\n  ${over.join('\n  ')}`);
  process.exit(1);
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base)).ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error(`dev server did not start on ${base}`);
}
