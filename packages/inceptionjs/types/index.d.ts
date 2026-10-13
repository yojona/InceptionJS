// Public browser API of InceptionJS.

export interface InceptionConfig {
  /** URL of inception-engine.js (the .wasm and .data sit next to it). */
  engineUrl: string;
  /** The relay (ws:// or wss://), with ?token= when the relay requires one. */
  relayUrl: string;
  /** @deprecated The earlier name of relayUrl. */
  wispUrl?: string;
  /** URL of binaryen's index.js, loaded the first time a page uses WebAssembly (default: next to the host modules). */
  binaryenUrl?: string;
  /** User-Agent override for every view. */
  userAgent?: string;
  /** CSS for every page (a user stylesheet: scrollbars, say), in a cascade layer so the page's own styles win. */
  userStyles?: string;
  /** How many WebGL contexts pages may hold (0 = derived from the browser). */
  webglContexts?: number;
  storage?: { profile?: string; fresh?: boolean };
  /** What pages may do to the person's browser. Every default is the safe one. */
  policy?: InceptionPolicy;
  /** Enable the view's debugEvaluate, debugHeap and debugCommand (development only). */
  debug?: boolean;
  modules?: Partial<Record<'geolocation' | 'notifications', ModuleSetting>>;
}

export interface InceptionPolicy {
  /** 'events' (default): report downloads and hand over the Blob, save nothing. 'save': also save to disk. 'block': cancel them. */
  downloads?: 'events' | 'save' | 'block';
  /** Largest download kept in memory before it is cancelled (default 256 MiB). */
  maxDownloadBytes?: number;
  /** 'block' (default): windows pages open are closed and reported as "popupblocked". Otherwise those after a user gesture are shown. */
  newTabs?: 'block' | 'foreground' | 'background';
  /** 'dismiss' (default): alert, confirm, prompt and beforeunload are answered without UI. 'native': the browser's own dialogs. */
  dialogs?: 'dismiss' | 'native';
  /** 'user' (default): paste brings the clipboard in, and it is written only soon after the person's own input. true: always. false: never. */
  clipboard?: 'user' | boolean;
  autoplaySound?: boolean;
}

export type Permission = 'grant' | 'deny' | 'ask' | ((origin: string) => boolean | Promise<boolean>);

export type ModuleSetting =
  | undefined
  | boolean
  | 'host'
  | { provider: 'host' | GeolocationProvider | NotificationProvider; permission?: Permission };

export interface GeolocationPosition {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude?: number;
  altitudeAccuracy?: number;
  heading?: number;
  speed?: number;
  timestamp: number;
}

export interface GeolocationProvider {
  watch(
    onPosition: (position: GeolocationPosition) => void,
    onError: (error: { denied: boolean; message: string }) => void,
    options: { highAccuracy: boolean },
  ): () => void;
}

export interface PageNotification {
  title: string;
  body?: string;
  icon?: string;
  tag?: string;
  origin: string;
}

export interface NotificationProvider {
  show(notification: PageNotification, callbacks: { click(): void; close(): void }): { close(): void };
}

export declare const Inception: {
  configure(options: Partial<InceptionConfig>): void;
};

export interface Preferences {
  colorScheme: 'light' | 'dark' | 'auto';
  reducedMotion: boolean | 'auto';
  contrast: 'more' | 'no-preference' | 'auto';
  languages: string[] | 'auto';
  timeZone: string | 'auto';
}

export interface HistoryEntry {
  url: string;
  title: string;
  /** Milliseconds since the epoch. */
  visited: number;
}

export interface FindResult {
  found: boolean;
  matches: number;
}

export interface ContextMenuDetail {
  x: number;
  y: number;
  link?: string;
  image?: string;
  selection?: string;
  editable?: boolean;
}

export interface InceptionViewEventMap {
  navigate: CustomEvent<{ url: string }>;
  title: CustomEvent<{ title: string }>;
  loading: CustomEvent<{ loading: boolean; error?: string; failedURL?: string }>;
  navigationstate: CustomEvent<{ canGoBack: boolean; canGoForward: boolean }>;
  popup: CustomEvent<{ url: string }>;
  console: CustomEvent<{ level: string; message: string }>;
  crash: CustomEvent<{ reason: string; stack?: string }>;
  cursor: CustomEvent<{ cursor: string }>;
  fullscreen: CustomEvent<{ active: boolean }>;
  zoom: CustomEvent<{ factor: number }>;
  findresult: CustomEvent<FindResult>;
  contextmenurequest: CustomEvent<ContextMenuDetail>;
  /** preventDefault() and call respond() to answer with your own UI. */
  dialog: CustomEvent<{ type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultValue?: string; respond(value: boolean | string | null): void }>;
  /** preventDefault() and call choose() to pick files with your own UI. */
  filechooser: CustomEvent<{ multiple: boolean; accept: string[]; directory: boolean; choose(files: File[] | null): void }>;
  /** preventDefault() to draw the list yourself; choose(index) answers. */
  selectmenu: CustomEvent<{ id: number; items: unknown[]; choose(index: number): void; [key: string]: unknown }>;
  permissionrequest: CustomEvent<{ kind: string; origin: string; grant(): void; deny(): void }>;
  downloadstart: CustomEvent<{ id: number; url: string; filename: string; mime: string; size: number }>;
  downloadprogress: CustomEvent<{ id: number; received: number; size: number }>;
  /** A download cancelled because policy.downloads is 'block'. */
  downloadblocked: CustomEvent<{ url: string; filename: string; mime: string; size: number }>;
  /** A page dialog answered without UI (the default policy). */
  dialogblocked: CustomEvent<{ type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string }>;
  /** A window or tab a page opened was closed instead of shown. */
  popupblocked: CustomEvent<{ tab: number; opener: number; url: string; userGesture: boolean }>;
  /** A page opened a tab: preventDefault() closes it, allow() shows it. */
  newtab: CustomEvent<{ tab: number; opener: number; url: string; userGesture: boolean; allow(mode?: 'foreground' | 'background'): void }>;
  downloadfinish: CustomEvent<{ id: number; filename: string; mime: string; error?: string; blob?: Blob }>;
}

export declare class InceptionView extends HTMLElement {
  /** CSS for every page this view shows (overrides InceptionConfig.userStyles); set before it starts. */
  userStyles: string | null;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** Resolves when the engine is running: {renderer: 'gpu' | 'cpu', ...}. */
  readonly ready: Promise<{ renderer: 'gpu' | 'cpu'; persistent?: boolean }>;
  /** Setting merges; a field set to 'auto' follows the host again. */
  preferences: Partial<Preferences>;

  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(options?: { bypassCache?: boolean }): Promise<void>;
  stop(): Promise<void>;
  find(text: string, options?: { backwards?: boolean; caseSensitive?: boolean }): Promise<FindResult>;
  findClear(): Promise<void>;
  /** 1 = 100%. */
  zoom(factor: number): Promise<void>;
  history(options?: { text?: string; limit?: number; before?: number }): Promise<HistoryEntry[]>;
  deleteHistory(range: { url: string } | { from?: number; to?: number }): Promise<void>;
  download(url: string): Promise<void>;
  cancelDownload(id: number): Promise<void>;
  /**
   * Connects another protocol client (an iframe, a worker, a remote agent). It may negotiate only
   * `capabilities`, by default just 'view'; 'find' (a text oracle), 'history' and 'observe' (console) must be named.
   */
  serve(transport: Transport, options?: { capabilities?: Array<'view' | 'find' | 'history' | 'observe'> }): unknown;
  /** Moves keyboard focus into the page. */
  focusInput(): void;

  /** Development aids; they throw unless the `debug` attribute or `Inception.configure({ debug: true })` is set. */
  debugEvaluate(source: string): Promise<unknown>;
  /** JS heap size and capacity, and wasm memory, in bytes. */
  debugHeap(): Promise<{ heapSize: number; heapCapacity: number; memory: number }>;
  debugCommand(command: string, args?: Record<string, unknown>): Promise<void>;

  addEventListener<K extends keyof InceptionViewEventMap>(type: K, listener: (this: InceptionView, ev: InceptionViewEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends keyof InceptionViewEventMap>(type: K, listener: (this: InceptionView, ev: InceptionViewEventMap[K]) => unknown, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

declare global {
  interface HTMLElementTagNameMap {
    'inception-view': InceptionView;
  }
}

// --- protocol -------------------------------------------------------------------

export declare const PROTOCOL_VERSION: number;

export declare const ErrorCode: Readonly<{
  ParseError: -32700;
  InvalidRequest: -32600;
  MethodNotFound: -32601;
  InvalidParams: -32602;
  Internal: -32603;
  VersionMismatch: -32000;
  NotNegotiated: -32001;
  CapabilityMissing: -32002;
}>;

export declare class ProtocolError extends Error {
  constructor(code: number, message: string, data?: unknown);
  code: number;
  data?: unknown;
}

/** A transport carries plain message objects; serialization is its business. */
export interface Transport {
  send(message: unknown): void;
  onmessage: ((message: unknown) => void) | null;
}

/** With a Window peer, `origin` is required: other origins and windows are ignored. */
export declare function createPostMessageTransport(target: Window, origin: string, source?: EventTarget): Transport;
export declare function createPostMessageTransport(target: MessagePort | Worker): Transport;
/** Messages over `maxMessageBytes` (default 1 MiB) are refused before parsing. */
export declare function createWebSocketTransport(socket: WebSocket, options?: { maxMessageBytes?: number }): Transport;

export declare class ProtocolClient extends EventTarget {
  constructor(transport: Transport);
  capabilities: string[];
  hello(capabilities?: string[]): Promise<{ version: number; capabilities: string[] }>;
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

// --- environment check ----------------------------------------------------------

export interface CheckResult {
  ok: boolean;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  webgl2: boolean;
  relay?: { reachable: boolean; reason?: string };
  problems: string[];
}

/** Whether InceptionJS can start on this page, and why not. */
export declare function check(options?: { relayUrl?: string; timeout?: number }): Promise<CheckResult>;
