// Next.js adapter: the cross-origin isolation headers on every route, and the
// engine and relay URLs exposed to the browser as public environment variables.
//
//   // next.config.mjs
//   import { withInception } from 'inceptionjs/next';
//   export default withInception({ /* your config */ }, { relayUrl: 'wss://relay.example.com/' });
//
// Put the engine files in public/__inception/engine/ (`npx inceptionjs init`
// does it) or pass engineUrl.

export function inceptionHeaders(coep = 'require-corp') {
  return [
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Embedder-Policy', value: coep },
  ];
}

export function withInception(nextConfig = {}, options = {}) {
  const { coep = 'require-corp', engineUrl = '/__inception/engine/inception-engine.js', binaryenUrl = '/__inception/binaryen/index.js', relayUrl = '' } = options;
  return {
    ...nextConfig,
    env: {
      ...nextConfig.env,
      NEXT_PUBLIC_INCEPTION_ENGINE_URL: engineUrl,
      NEXT_PUBLIC_INCEPTION_BINARYEN_URL: binaryenUrl,
      NEXT_PUBLIC_INCEPTION_RELAY_URL: relayUrl,
    },
    async headers() {
      const own = typeof nextConfig.headers === 'function' ? await nextConfig.headers() : [];
      return [...own, { source: '/:path*', headers: inceptionHeaders(coep) }];
    },
  };
}
