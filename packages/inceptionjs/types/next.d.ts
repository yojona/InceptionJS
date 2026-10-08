export declare function inceptionHeaders(coep?: 'require-corp' | 'credentialless'): { key: string; value: string }[];

export interface WithInceptionOptions {
  coep?: 'require-corp' | 'credentialless';
  /** Default /__inception/engine/inception-engine.js (public/__inception/engine/). */
  engineUrl?: string;
  binaryenUrl?: string;
  relayUrl?: string;
}

/**
 * Adds the isolation headers to every route and exposes the engine, translator
 * and relay URLs as NEXT_PUBLIC_INCEPTION_* environment variables.
 */
export declare function withInception<T extends Record<string, any>>(nextConfig?: T, options?: WithInceptionOptions): T;
