import type { RelayOptions } from './server';

export interface InceptionPluginOptions {
  /** Directory with inception-engine.{js,wasm,data} (default $INCEPTION_ENGINE_DIR or ./inception-engine). */
  engineDir?: string;
  /** Engine files hosted elsewhere, instead of engineDir. */
  engineUrl?: string;
  /** true starts a development relay; a string is the URL of a running one. */
  relay?: boolean | string;
  relayOptions?: RelayOptions;
  coep?: 'require-corp' | 'credentialless';
  /** Copy the engine into the build output (default true when engineDir is used). */
  copyEngine?: boolean;
}

export declare function isolationHeaders(coep?: 'require-corp' | 'credentialless'): Record<string, string>;

/** Vite plugin: isolation headers, engine and translator under /__inception/, an optional dev relay. */
export default function inception(options?: InceptionPluginOptions): {
  name: string;
  [hook: string]: unknown;
};
