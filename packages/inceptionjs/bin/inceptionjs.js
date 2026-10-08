#!/usr/bin/env node
// npx inceptionjs <command>
//   init [--engine <dir>]           wire InceptionJS into a Vite or Next.js project
//   check <url> [--relay <ws-url>]  explain what a deployment is missing
//   relay [--port N] [--dev] ...    run a relay (development or behind your proxy)

import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const [command, ...rest] = process.argv.slice(2);

const HELP = `Usage: inceptionjs <command>

  init [--engine <dir>]               Set up a Vite or Next.js project
  check <url> [--relay <ws-url>]      Check a deployment's headers, engine and relay
  relay [--port 5001] [--host 127.0.0.1] [--dev] [--dev-ports 5173,3000]
        [--origin https://app.example.com] [--secret-env INCEPTION_RELAY_SECRET]
                                      Run a relay
`;

const commands = { init, check, relay };
if (!commands[command]) {
  process.stdout.write(HELP);
  process.exit(command && command !== 'help' && command !== '--help' ? 1 : 0);
}
await commands[command](rest);

// --- init -------------------------------------------------------------------

async function init(argv) {
  const { values } = parseArgs({ args: argv, options: { engine: { type: 'string' } } });
  const cwd = process.cwd();
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) fail('No package.json here: run init from your project root.');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const engine = values.engine ? resolve(values.engine) : null;

  if (deps.next) return initNext(cwd, engine);
  if (deps.vite) return initVite(cwd, engine);
  fail('Neither Vite nor Next.js found in package.json. See the docs for other setups: serve the page with\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\nand host the engine files.');
}

function initVite(cwd, engine) {
  const file = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'].map((f) => join(cwd, f)).find(existsSync);
  const engineDir = engine ?? './inception-engine';
  const pluginCall = `inception({ engineDir: ${JSON.stringify(engineDir)}, relay: true })`;
  if (!file) {
    writeFileSync(join(cwd, 'vite.config.js'), `import { defineConfig } from 'vite';\nimport inception from 'inceptionjs/vite';\n\nexport default defineConfig({\n  plugins: [${pluginCall}],\n});\n`);
    done('Created vite.config.js with the InceptionJS plugin.');
  } else {
    let source = readFileSync(file, 'utf8');
    if (source.includes('inceptionjs/vite')) {
      done(`${file} already uses the InceptionJS plugin.`);
    } else if (/plugins:\s*\[/.test(source)) {
      source = `import inception from 'inceptionjs/vite';\n` + source.replace(/plugins:\s*\[/, `plugins: [${pluginCall}, `);
      writeFileSync(file, source);
      done(`Added the InceptionJS plugin to ${file}.`);
    } else {
      done(`Could not find a plugins array in ${file}. Add this yourself:\n  import inception from 'inceptionjs/vite';\n  plugins: [${pluginCall}]`);
    }
  }
  console.log(`
Next steps:
  1. Put the engine files (inception-engine.js, .wasm, .data) in ${engineDir}
  2. In your page:
       import config from 'virtual:inceptionjs/config';
       import { Inception } from 'inceptionjs';
       Inception.configure({ engineUrl: config.engineUrl, wispUrl: config.relayUrl, binaryenUrl: config.binaryenUrl });
     or with React: <InceptionView src="https://example.com" {...config} />
  3. In production, run a relay (npx inceptionjs relay) or use a hosted one.`);
}

function initNext(cwd, engine) {
  const file = ['next.config.mjs', 'next.config.js', 'next.config.ts'].map((f) => join(cwd, f)).find(existsSync);
  if (!file) {
    writeFileSync(join(cwd, 'next.config.mjs'), `import { withInception } from 'inceptionjs/next';\n\nexport default withInception({}, { relayUrl: process.env.INCEPTION_RELAY_URL ?? '' });\n`);
    done('Created next.config.mjs with withInception().');
  } else if (readFileSync(file, 'utf8').includes('inceptionjs/next')) {
    done(`${file} already uses withInception().`);
  } else {
    done(`Wrap your config in ${file}:\n  import { withInception } from 'inceptionjs/next';\n  export default withInception(yourConfig, { relayUrl: process.env.INCEPTION_RELAY_URL });`);
  }
  const target = join(cwd, 'public', '__inception', 'engine');
  if (engine) {
    mkdirSync(target, { recursive: true });
    cpSync(engine, target, { recursive: true });
    done(`Copied the engine files to ${target}.`);
  } else {
    console.log(`Put the engine files in ${target} (or rerun with --engine <dir>).`);
  }
  console.log(`Also copy node_modules/binaryen into public/__inception/binaryen/ so pages can use WebAssembly.
The view element only works in the browser: render it from a client component ('use client').`);
}

// --- check ------------------------------------------------------------------

async function check(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { relay: { type: 'string' }, engine: { type: 'string' } } });
  const url = positionals[0];
  if (!url) fail('Usage: inceptionjs check <url> [--relay <ws-url>] [--engine <engine.js url>]');
  let failures = 0;
  const report = (ok, message, fix) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}${!ok && fix ? `\n     ${fix}` : ''}`);
    if (!ok) failures++;
  };

  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (error) {
    fail(`Could not fetch ${url}: ${error.message}`);
  }
  const coop = response.headers.get('cross-origin-opener-policy');
  const coep = response.headers.get('cross-origin-embedder-policy');
  report(response.ok, `page answers (${response.status})`);
  report(coop?.split(';')[0].trim() === 'same-origin', `Cross-Origin-Opener-Policy: ${coop ?? '(missing)'}`, 'Send "Cross-Origin-Opener-Policy: same-origin" on the page.');
  report(['require-corp', 'credentialless'].includes(coep?.split(';')[0].trim()), `Cross-Origin-Embedder-Policy: ${coep ?? '(missing)'}`,
    'Send "Cross-Origin-Embedder-Policy: require-corp" (or credentialless). Cross-origin scripts, images and iframes on the page then need CORP/CORS headers; credentialless relaxes that for no-cookie requests.');

  const engineUrl = new URL(values.engine ?? '/__inception/engine/inception-engine.js', response.url);
  for (const [path, type] of [[engineUrl.href, 'javascript'], [engineUrl.href.replace(/\.js$/, '.wasm'), 'application/wasm']]) {
    try {
      const r = await fetch(path, { method: 'HEAD' });
      const corp = r.headers.get('cross-origin-resource-policy');
      const sameOrigin = new URL(path).origin === new URL(response.url).origin;
      report(r.ok, `${path} (${r.status})`, 'Host the engine files there, or pass --engine with their URL.');
      if (r.ok) {
        report((r.headers.get('content-type') ?? '').includes(type), `  content-type ${r.headers.get('content-type') ?? '(missing)'}`, `Serve it as ${type}.`);
        report(sameOrigin || corp === 'cross-origin', `  Cross-Origin-Resource-Policy ${corp ?? '(missing)'}`, 'A cross-origin engine needs "Cross-Origin-Resource-Policy: cross-origin".');
      }
    } catch (error) {
      report(false, `${path}: ${error.message}`);
    }
  }

  if (values.relay) {
    const reachable = await probeRelay(values.relay);
    report(reachable === true, `relay ${values.relay}${reachable === true ? '' : `: ${reachable}`}`, 'Start one with `npx inceptionjs relay` or check the URL and token.');
  } else {
    console.log('skip relay (pass --relay <ws-url> to test it)');
  }
  process.exit(failures ? 1 : 0);
}

async function probeRelay(url) {
  if (typeof WebSocket !== 'function') return 'this Node has no WebSocket (needs Node 22+)';
  return new Promise((resolveProbe) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const timer = setTimeout(() => finish('timed out'), 5000);
    function finish(result) {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolveProbe(result);
    }
    socket.onmessage = (e) => finish(new Uint8Array(e.data)[0] === 0x03 ? true : 'unexpected greeting');
    socket.onerror = () => finish('connection failed');
  });
}

// --- relay ------------------------------------------------------------------

async function relay(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: '5001' },
      host: { type: 'string', default: '127.0.0.1' },
      dev: { type: 'boolean', default: false },
      'dev-ports': { type: 'string', default: '' },
      origin: { type: 'string', multiple: true, default: [] },
      'secret-env': { type: 'string', default: 'INCEPTION_RELAY_SECRET' },
    },
  });
  const { startRelay } = await import('../dist/server/relay.js');
  const secret = process.env[values['secret-env']] || undefined;
  if (!secret && !values.dev) console.warn('[relay] no secret: anyone who can reach this port can use it. Set INCEPTION_RELAY_SECRET in production.');
  const server = await startRelay({
    port: Number(values.port),
    host: values.host,
    dev: values.dev,
    devPorts: values['dev-ports'].split(',').filter(Boolean).map(Number),
    origins: values.origin,
    secret,
  });
  const stop = () => server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function done(message) {
  console.log(message);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
