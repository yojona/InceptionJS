// Vite plugin. In development and preview it sends the cross-origin isolation
// headers InceptionJS needs, serves the engine binaries and the WebAssembly
// translator under /__inception/, and can start a development relay. Pages
// read the resulting URLs from the `virtual:inceptionjs/config` module.
//
//   import inception from 'inceptionjs/vite';
//   export default { plugins: [inception({ engineDir: './inception-engine', relay: true })] };

import { createReadStream, cpSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { startRelay } from '../server/relay.js';

const BASE = '/__inception';
const VIRTUAL_ID = 'virtual:inceptionjs/config';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.json': 'application/json',
};

export function isolationHeaders(coep = 'require-corp') {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': coep,
  };
}

function serveFrom(root, prefix) {
  return (req, res, next) => {
    const { pathname } = new URL(req.url, 'http://local');
    if (!pathname.startsWith(prefix + '/')) return next();
    const file = resolve(root, decodeURIComponent(pathname.slice(prefix.length + 1)));
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-cache');
    createReadStream(file).pipe(res);
  };
}

/**
 * Options:
 *   engineDir    directory with inception-engine.{js,wasm,data}
 *                (default: $INCEPTION_ENGINE_DIR or ./inception-engine)
 *   engineUrl    use engine files hosted elsewhere instead of engineDir
 *   relay        true to start a development relay, or the URL of a running one
 *   relayOptions options for the development relay (see inceptionjs/server)
 *   coep         'require-corp' (default) or 'credentialless'
 *   copyEngine   copy the engine into the build output (default: true when
 *                engineDir is used)
 */
export default function inception(options = {}) {
  const coep = options.coep ?? 'require-corp';
  let root = process.cwd();
  let engineDir;
  let relayUrl = typeof options.relay === 'string' ? options.relay : null;
  let relay = null;
  let outDir;
  let command = 'serve';
  const binaryenDir = dirname(createRequire(import.meta.url).resolve('binaryen'));

  const engineUrl = () => options.engineUrl ?? `${BASE}/engine/inception-engine.js`;

  async function ensureRelay() {
    if (options.relay !== true || relay) return;
    relay = await startRelay({ dev: true, ...options.relayOptions });
    relayUrl = relay.url;
  }

  function middlewares(server) {
    server.middlewares.use((req, res, next) => {
      for (const [name, value] of Object.entries(isolationHeaders(coep))) res.setHeader(name, value);
      next();
    });
    if (!options.engineUrl) server.middlewares.use(serveFrom(engineDir, `${BASE}/engine`));
    server.middlewares.use(serveFrom(binaryenDir, `${BASE}/binaryen`));
  }

  return {
    name: 'inceptionjs',
    config() {
      return {
        // The host loads sibling files relative to its own URL; pre-bundling
        // would move it and break those paths.
        optimizeDeps: { exclude: ['inceptionjs', '@inceptionjs/react'] },
      };
    },
    configResolved(config) {
      root = config.root;
      command = config.command;
      outDir = resolve(root, config.build.outDir);
      engineDir = resolve(root, options.engineDir ?? process.env.INCEPTION_ENGINE_DIR ?? 'inception-engine');
      if (!options.engineUrl && !existsSync(join(engineDir, 'inception-engine.js')))
        config.logger.warn(`[inceptionjs] no engine at ${engineDir}: set engineDir, INCEPTION_ENGINE_DIR or engineUrl`);
    },
    async configureServer(server) {
      await ensureRelay();
      middlewares(server);
      server.httpServer?.once('close', () => relay?.close());
    },
    async configurePreviewServer(server) {
      await ensureRelay();
      middlewares(server);
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      // Absolute URLs: the engine resolves its own files against engineUrl.
      const absolute = (url) => `new URL(${JSON.stringify(url)}, location.href).href`;
      return `export default { engineUrl: ${absolute(engineUrl())}, binaryenUrl: ${absolute(`${BASE}/binaryen/index.js`)}, relayUrl: ${JSON.stringify(relayUrl)} };`;
    },
    writeBundle() {
      if (command !== 'build' || options.engineUrl || options.copyEngine === false) return;
      if (!existsSync(engineDir)) return;
      cpSync(engineDir, join(outDir, BASE.slice(1), 'engine'), { recursive: true });
      cpSync(binaryenDir, join(outDir, BASE.slice(1), 'binaryen'), { recursive: true });
    },
  };
}
