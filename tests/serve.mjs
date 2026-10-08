// Development server: the repository with the headers InceptionJS needs
// (cross-origin isolation for SharedArrayBuffer). /engine/ maps to the build
// output. No caching, so a rebuilt engine is picked up on reload.
//   node tests/serve.mjs            PORT (8085), HOST (127.0.0.1), ENGINE_DIR
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const engineDir = resolve(root, process.env.ENGINE_DIR ?? '.work/out/engine');
const port = Number(process.env.PORT ?? 8085);
const host = process.env.HOST ?? '127.0.0.1';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function resolvePath(pathname) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const base = clean.startsWith('engine/') ? engineDir : root;
  const relative = clean.startsWith('engine/') ? clean.slice('engine/'.length) : clean;
  const full = resolve(base, relative);
  return full.startsWith(base) ? full : null;
}

createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  let file = resolvePath(pathname === '/' ? '/examples/basic.html' : pathname);
  try {
    if (file && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!file || !statSync(file).isFile()) throw new Error('not found');
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': types[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  createReadStream(file).pipe(res);
}).listen(port, host, () => console.log(`InceptionJS dev server on http://${host}:${port}/`));
