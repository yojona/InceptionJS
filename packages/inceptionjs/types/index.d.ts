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
  /** profile: the profile's name; fresh: start it empty; ephemeral (isolation 'window'): a profile kept in memory only, gone when the page closes. */
  storage?: { profile?: string; fresh?: boolean; ephemeral?: boolean };
  /**
   * 'shared' (default): one engine runs every window of a view, the profile in it.
   * 'window': a profile service holds the profile, its files and the only relay connection; window 1 and
   * every window openWindow() opens run in engines of their own (with the popups their pages open),
   * which share cookies, storage, IndexedDB and history through it. A crash in one window's engine
   * closes only its windows; the service restarts by itself after a crash of its own.
   * 'site': as 'window', and an engine shows one site: a window that navigates to another site moves to an
   * engine of that site, the service keeps other sites' data and responses from it, and a window has one tab.
   */
  isolation?: 'shared' | 'window' | 'site';
  /** isolation 'window' and 'site': how many engines the view runs before new windows share one (default follows the device's memory). */
  engines?: { max?: number };
  /** What pages may do to the person's browser. Every default is the safe one. */
  policy?: InceptionPolicy;
  /** Enable the view's debugEvaluate, debugHeap and debugCommand (development only). */
  debug?: boolean;
  /** How far a view's engine memory may grow, in MiB (default 2048, 512 to 4096); past it the view crashes with kind 'out_of_memory'. */
  maxMemoryMB?: number;
  /** Offer the agent namespace (view.agent) on every view: true, or its options. Off by default. */
  agent?: boolean | AgentOptions;
  modules?: Partial<Record<'geolocation' | 'notifications', ModuleSetting>>;
  /**
   * A view whose profile another document of the site holds attaches to that document and shows a window
   * of it, instead of failing (default true); the document that holds the profile accepts such views. Set
   * false to get the "profile is open in another tab" error. See `InceptionView.role` and `connectProfile()`.
   */
  attach?: boolean;
  /** Where the site serves host/broker.js, the shared worker that connects documents, when it is not next to the host modules. All documents of the site must agree. */
  brokerUrl?: string;
}

export interface InceptionPolicy {
  /** 'events' (default): report downloads and hand over the Blob, save nothing. 'save': also save to disk. 'block': cancel them. */
  downloads?: 'events' | 'save' | 'block';
  /** 'block' (default): a download the page starts without the person's input is cancelled (downloadblocked, reason 'no-gesture'). */
  gesturelessDownloads?: 'block' | 'allow';
  /** Largest download kept in memory before it is cancelled (default 256 MiB). */
  maxDownloadBytes?: number;
  /** 'block' (default): windows pages open are closed and reported as "popupblocked". Otherwise those after a user gesture are shown. */
  newTabs?: 'block' | 'foreground' | 'background';
  /** 'tab' (default): what a page opens is a tab of its window. 'window': a new window ("windowopen"), kept or closed by the newTabs rule. */
  popups?: 'tab' | 'window';
  /**
   * Hosts pages may reach (a host matches itself and its subdomains); `block` wins over `allow`, and
   * without `allow` every host not blocked is. Enforced by the profile service, so only with isolation
   * 'window' or 'site'; openWindow({ hosts }) sets it for one window.
   */
  hosts?: { allow?: string[]; block?: string[] };
  /** isolation 'site' only. 'block' (default): requests to a site other than the window's page carry and set none of the profile's cookies, and other sites' frames get none of its cookies or storage. 'allow': ordinary third-party behavior. */
  thirdPartyCookies?: 'block' | 'allow';
  /** 'dismiss' (default): alert, confirm, prompt and beforeunload are answered without UI. 'native': the browser's own dialogs. */
  dialogs?: 'dismiss' | 'native';
  /** 'user' (default): paste brings the clipboard in, and it is written only soon after the person's own input. true: always. false: never. */
  clipboard?: 'user' | boolean;
  autoplaySound?: boolean;
}

// --- agent namespace ------------------------------------------------------------

/** From least to most consequential. 'interact' is input that stays in the page. */
export type AgentRisk = 'read' | 'interact' | 'navigate' | 'submit' | 'download' | 'login' | 'payment';

export interface AgentPolicyRequest {
  /** 'click', 'type', 'fill', 'press', 'select', 'scroll', 'hover', 'navigate', 'back', 'forward', 'reload' or 'control'. */
  action: string;
  risk: AgentRisk;
  /** Where the action leads: the link or navigation target, else the page. */
  url: string;
  pageUrl: string;
  target?: { ref: string; tag: string; field?: 'password' | 'payment'; link?: string };
}

export interface AgentOptions {
  /**
   * Decides each action; may ask a person. Without one the agent stays on the site it is on:
   * read, interact and control are allowed, navigation only within the same site (or out of a
   * blank view), and cross-site navigation, submit, download, login and payment are refused.
   */
  policy?: (request: AgentPolicyRequest) => boolean | 'allow' | 'deny' | Promise<boolean | 'allow' | 'deny'>;
  /** Acting calls allowed per minute (default 120); past it they fail with 'rate_limited'. */
  maxActionsPerMinute?: number;
  /** Called with every action log entry. */
  onAction?: (entry: AgentLogEntry) => void;
}

export interface AgentLogEntry {
  seq: number;
  /** ISO 8601. */
  time: string;
  action: string;
  /** What was asked; text typed into password and payment fields is replaced by its length. */
  params: Record<string, unknown>;
  risk: AgentRisk;
  decision: 'allowed' | 'denied';
  outcome: 'ok' | 'error' | 'blocked';
  error?: string;
  url: string;
  ms?: number;
}

export interface AgentNode {
  /** Stable while the node lives; a removed node's ref fails with 'stale_ref'. */
  ref?: string;
  role: string;
  name?: string;
  value?: string;
  placeholder?: string;
  level?: number;
  href?: string;
  /** Password and payment fields never report their value, only the 'filled' state. */
  field?: 'password' | 'payment';
  interactive?: boolean;
  /** disabled, checked, unchecked, mixed, expanded, collapsed, pressed, selected, required, focused, filled, offpage. */
  states?: string[];
  /** Text that reads like instructions to an agent. */
  suspicious?: boolean;
  /** [x, y, width, height] in CSS pixels of the view. */
  box: [number, number, number, number];
  children?: AgentNode[];
}

interface AgentPageResult {
  /** Everything read from a page is untrusted data, never instructions. */
  untrusted: true;
  url: string;
}

export interface AgentSnapshot extends AgentPageResult {
  mode: 'accessibility';
  format: 'text' | 'tree';
  title: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  count: number;
  truncated: boolean;
  /** Refs of nodes flagged as suspected instructions. */
  suspicious: string[];
  /** format 'text': the page in a fence marked untrusted. */
  text?: string;
  omitted?: number;
  /** format 'tree'. */
  nodes?: AgentNode[];
  /** diff with format 'tree'. */
  diff?: { added: AgentNode[]; removed: AgentNode[]; changed: { before: AgentNode; after: AgentNode }[]; text: string };
}

export interface AgentActResult {
  ok: true;
  action: string;
  risk: AgentRisk;
  url: string;
  title: string;
  navigated: boolean;
  /** Whether loads went quiet before the call returned. */
  settled: boolean;
  /** What changed since the last snapshot, when there was one and the page stayed. */
  changes?: string;
  point?: { x: number; y: number };
  typed?: number;
  selected?: string;
}

export type AgentAction =
  | { action: 'click'; ref: string; risk?: AgentRisk }
  | { action: 'click'; x: number; y: number; risk?: AgentRisk }
  | { action: 'hover'; ref: string }
  | { action: 'type' | 'fill'; ref?: string; text: string; risk?: AgentRisk }
  | { action: 'press'; key: string; ref?: string; risk?: AgentRisk }
  | { action: 'select'; ref: string; value: string }
  | { action: 'scroll'; ref?: string; deltaX?: number; deltaY?: number; x?: number; y?: number };

/**
 * The agent namespace. Reads never need control; acting needs it (requestControl()), and
 * any input from the person takes it back. Errors are ProtocolErrors whose `reason` is one
 * of: not_ready, no_such_ref, stale_ref, timeout, denied_by_policy, control_held,
 * rate_limited, not_actionable, not_visible, not_editable, focus_changed, no_such_option,
 * unsupported_mode, engine_crashed, invalid_params.
 */
export interface Agent {
  snapshot(options?: { mode?: 'accessibility'; format?: 'text' | 'tree'; diff?: boolean; maxTokens?: number; maxNodes?: number; scope?: 'page' | 'viewport' }): Promise<AgentSnapshot>;
  find(query: { role?: string; name?: string; text?: string; interactive?: boolean; limit?: number }): Promise<AgentPageResult & { matches: AgentNode[] }>;
  extract(options: 'text' | 'markdown' | 'links' | 'forms' | 'tables' | { kind: 'text' | 'markdown' | 'links' | 'forms' | 'tables'; maxLength?: number }): Promise<AgentPageResult & Record<string, unknown>>;
  waitFor(condition: { text?: string; ref?: string; selector?: string; url?: string; navigation?: boolean; networkIdle?: boolean; state?: 'visible' | 'attached' | 'detached'; timeoutMs?: number }): Promise<{ ok: true; url: string; elapsedMs: number; ref?: string }>;
  /** From the engine's last frame; `data` is base64. Video drawn by the host page is not in it. */
  screenshot(options?: { annotate?: boolean; type?: string; quality?: number }): Promise<{ mimeType: string; width: number; height: number; data: string }>;
  act(action: AgentAction & { diff?: boolean; settleMs?: number }): Promise<AgentActResult>;
  click(target: { ref: string } | { x: number; y: number }): Promise<AgentActResult>;
  hover(ref: string): Promise<AgentActResult>;
  type(ref: string | undefined, text: string, options?: { risk?: AgentRisk }): Promise<AgentActResult>;
  fill(ref: string | undefined, text: string, options?: { risk?: AgentRisk }): Promise<AgentActResult>;
  press(key: string, options?: { ref?: string; risk?: AgentRisk }): Promise<AgentActResult>;
  select(ref: string, value: string): Promise<AgentActResult>;
  scroll(options?: { ref?: string; deltaX?: number; deltaY?: number }): Promise<AgentActResult>;
  navigate(url: string): Promise<AgentActResult>;
  back(): Promise<AgentActResult>;
  forward(): Promise<AgentActResult>;
  reload(): Promise<AgentActResult>;
  requestControl(): Promise<{ control: 'agent' }>;
  releaseControl(): Promise<{ control: 'human' }>;
  log(): Promise<AgentLogEntry[]>;
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

export interface SecurityState {
  tab: number;
  url: string;
  scheme: string;
  secure: boolean;
  httpVersion?: string;
  certificate?: { subject?: string; validFrom?: number; validUntil?: number; dnsNames?: string[]; verificationError: number; chainLength: number };
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
  loading: CustomEvent<{ loading: boolean; error?: string; failedURL?: string; errorKind?: 'certificate' }>;
  navigationstate: CustomEvent<{ canGoBack: boolean; canGoForward: boolean }>;
  popup: CustomEvent<{ url: string }>;
  console: CustomEvent<{ level: string; message: string }>;
  /** The engine stopped; `windows` lists every window it took down. */
  crash: CustomEvent<{ reason: string; stack?: string; kind?: 'out_of_memory'; windows?: number[] }>;
  securitystate: CustomEvent<SecurityState>;
  /** A load failed because the server's certificate did not verify; there is no way past it. */
  certificateerror: CustomEvent<{ url: string; verificationError: number; description: string; subject?: string; validFrom?: number; validUntil?: number }>;
  cursor: CustomEvent<{ cursor: string }>;
  fullscreen: CustomEvent<{ active: boolean }>;
  /** An attached view: the document that held the profile went away; the view waits for the next one. */
  hostlost: CustomEvent<undefined>;
  /** An attached view: its window is open again on the new host. */
  reattached: CustomEvent<undefined>;
  /** An attached view became the host of its profile. */
  promoted: CustomEvent<undefined>;
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
  downloadstart: CustomEvent<{ id: number; url: string; filename: string; mime: string; size: number; userGesture?: boolean }>;
  downloadprogress: CustomEvent<{ id: number; received: number; size: number }>;
  /** A download cancelled because policy.downloads is 'block'. */
  downloadblocked: CustomEvent<{ url: string; filename: string; mime: string; size: number; reason: 'policy' | 'no-gesture' }>;
  /** A page dialog answered without UI (the default policy). */
  dialogblocked: CustomEvent<{ type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string }>;
  /** A window or tab a page opened was closed instead of shown. */
  popupblocked: CustomEvent<{ tab: number; opener: number; url: string; userGesture: boolean; window?: number }>;
  /** A page opened a window (policy.popups 'window'): preventDefault() closes it, allow() keeps it. Show it with <inception-window> or exportWindow(). */
  windowopen: CustomEvent<{ window: InceptionWindow | RemoteWindow; opener: number | string; openerWindow?: number; url: string; userGesture: boolean; allow?(): void }>;
  windowcreated: CustomEvent<WindowInfo>;
  windowclosed: CustomEvent<{ window: number }>;
  windowupdated: CustomEvent<WindowInfo>;
  /** A page in this window called window.focus(); the embedder decides whether to bring it forward. */
  windowfocusrequest: CustomEvent<{ window: number }>;
  /** A page opened a tab: preventDefault() closes it, allow() shows it. */
  newtab: CustomEvent<{ tab: number; opener: number; url: string; userGesture: boolean; allow(mode?: 'foreground' | 'background'): void }>;
  /**
   * The page shows a password or payment field, or a known sign-in page (kind is '' when that ends).
   * preventDefault() to show your own warning instead of the built-in notice. Fires even with provenance="off".
   */
  sensitivepage: CustomEvent<{ kind: 'password' | 'payment' | ''; reason: 'field' | 'signin-page' | ''; origin: string; url: string }>;
  /** The embedding page hid the provenance badge; the view covers the content until it is visible again. */
  provenancetampered: CustomEvent<{ hidden: boolean }>;
  downloadfinish: CustomEvent<{ id: number; filename: string; mime: string; error?: string; blob?: Blob }>;
  /** Who drives the view changed. */
  control: CustomEvent<{ control: 'human' | 'agent'; reason: 'request' | 'release' | 'input' | 'indicator' }>;
  agentaction: CustomEvent<AgentLogEntry>;
  /** The engine refused a submission or download the policy had not approved. */
  agentblocked: CustomEvent<{ action: 'submit' | 'download'; risk: AgentRisk; url: string; entry: AgentLogEntry }>;
}

export declare class InceptionView extends HTMLElement {
  /** CSS for every page this view shows (overrides InceptionConfig.userStyles); set before it starts. */
  userStyles: string | null;
  /**
   * 'host': this document holds the profile and runs the engine. 'client': another document holds it and
   * this view shows a window of it (agent, serve(), openWindow(), exportWindow(), downloads and the debug
   * methods other than debugEvaluate are not available there). null until the view has started. A client
   * takes the profile over, starting where its window was, if the host goes away and it is next in line;
   * "promoted" then fires and `role` becomes 'host'.
   */
  readonly role: 'host' | 'client' | null;
  /** The id of this view's window on the document that runs the engine (1 on the host itself). */
  readonly windowId: number;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** The connection of the page shown, for the embedder's own address bar. */
  readonly securityState: SecurityState | null;
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
   * `capabilities`, by default just 'view'; 'find' (a text oracle), 'history', 'observe' (console) and
   * 'agent' (when enabled) must be named. ['agent'] alone keeps an agent runtime to the policed namespace.
   */
  serve(transport: Transport, options?: { capabilities?: ProtocolCapability[]; window?: number }): unknown;
  /** The windows of this view's engine (one profile, cookies, storage and network), window 1 (the view) first. */
  readonly windows: WindowInfo[];
  /** Opens another window of this engine; hidden until a display shows it. */
  openWindow(options?: { width?: number; height?: number; url?: string; deviceScaleFactor?: number; hosts?: { allow?: string[]; block?: string[] } }): Promise<InceptionWindow>;
  /** The handle of a window other than 1, or null. */
  window(id: number): InceptionWindow | null;
  /**
   * A display channel for window `id`, to show it in another document with createDisplay(canvas, port).
   * `frames`: 'auto' (bitmaps where the browser carries them to the other document, RGBA pixels otherwise).
   */
  exportWindow(id: number, options?: { frames?: 'auto' | 'bitmap' | 'pixels' }): MessagePort;
  /** The agent namespace, or null unless the `agent` attribute or Inception.configure({ agent }) enables it. */
  readonly agent: Agent | null;
  /** Who drives the view. */
  readonly control: 'human' | 'agent';
  requestControl(): Promise<{ control: 'agent' }>;
  releaseControl(): Promise<{ control: 'human' }>;
  /** Moves keyboard focus into the page. */
  focusInput(): void;

  /** Development aids; they throw unless the `debug` attribute or `Inception.configure({ debug: true })` is set. */
  debugEvaluate(source: string, options?: { window?: number }): Promise<unknown>;
  /** JS heap size and capacity, and wasm memory, in bytes. */
  debugHeap(): Promise<{ heapSize: number; heapCapacity: number; memory: number }>;
  /** Sends a raw engine command; `args.window` picks the window, and so the engine, it goes to. */
  debugCommand(command: string, args?: Record<string, unknown>): Promise<void>;
  /** The engines of this view with the windows each runs, and their memory in bytes (`site` is set with isolation 'site'). */
  debugEngines(): Promise<{ engine: number; site?: string; windows: number[]; memory: number }[]>;
  /** The profile service (isolation 'window' or 'site'), or null. */
  debugProfileService(): Promise<EventTarget | null>;

  addEventListener<K extends keyof InceptionViewEventMap>(type: K, listener: (this: InceptionView, ev: InceptionViewEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends keyof InceptionViewEventMap>(type: K, listener: (this: InceptionView, ev: InceptionViewEventMap[K]) => unknown, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

/** 'windows': list, open, resize and close windows, and bind to another window in hello. */
export type ProtocolCapability = 'view' | 'find' | 'history' | 'observe' | 'agent' | 'windows';

export interface WindowInfo {
  window: number;
  visible: boolean;
  url: string;
  title: string;
  activeTab: number;
  width?: number;
  height?: number;
}

export interface InceptionWindowEventMap {
  navigate: CustomEvent<{ url: string; tab?: number }>;
  title: CustomEvent<{ title: string; tab?: number }>;
  loading: CustomEvent<{ loading: boolean; error?: string; failedURL?: string; errorKind?: 'certificate' }>;
  navigationstate: CustomEvent<{ canGoBack: boolean; canGoForward: boolean }>;
  tabcreated: CustomEvent<{ tab: number; opener?: number }>;
  tabactivated: CustomEvent<{ tab: number }>;
  tabclosed: CustomEvent<{ tab: number }>;
  control: CustomEvent<{ control: 'human' | 'agent'; reason: string }>;
  crash: CustomEvent<{ reason: string; windows?: number[] }>;
  /** The window was closed (by the embedder, a page or its last tab). */
  close: CustomEvent<{ window: number }>;
}

/** A window other than 1 of a view's engine: the view's navigation, tab and agent surface, scoped to it. */
export declare class InceptionWindow extends EventTarget {
  readonly id: number;
  readonly closed: boolean;
  readonly visible: boolean;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly securityState: SecurityState | null;
  readonly tabs: Array<{ id: number; url: string; title: string; active: boolean; [key: string]: unknown }>;
  readonly activeTab: number;
  /** The agent namespace bound to this window, or null when the agent is off. */
  readonly agent: Agent | null;
  readonly control: 'human' | 'agent';
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(options?: { bypassCache?: boolean }): Promise<void>;
  stop(): Promise<void>;
  find(text: string, options?: { backwards?: boolean; caseSensitive?: boolean }): Promise<FindResult>;
  findClear(): Promise<void>;
  zoom(factor: number): Promise<void>;
  createTab(url?: string, options?: { activate?: boolean }): Promise<void>;
  activateTab(id: number): Promise<void>;
  closeTab(id: number): Promise<void>;
  requestControl(): Promise<{ control: 'agent' }>;
  releaseControl(): Promise<{ control: 'human' }>;
  /** The layout size of a window no display shows. */
  resize(width: number, height: number, options?: { deviceScaleFactor?: number }): Promise<void>;
  close(): Promise<void>;
  /** Connects a protocol client bound to this window. */
  serve(transport: Transport, options?: { capabilities?: ProtocolCapability[] }): unknown;
  addEventListener<K extends keyof InceptionWindowEventMap>(type: K, listener: (this: InceptionWindow, ev: InceptionWindowEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
}

/** <inception-window view="#id" window="2">: shows a window of a view in the same document. */
export declare class InceptionWindowElement extends HTMLElement {}

/**
 * Shows a window of an engine in another document, through the port its view's exportWindow() returned.
 * Needs no cross-origin isolation. The window's dialogs (a cancelable "dialog" event on `dialogTarget`, as on a
 * view), file choosers ("filechooser"), videos (played here, under the canvas), Web Audio (samples that play once
 * the person has used this document) and copies (to this document's clipboard) all come here.
 * A "closed" event fires on the canvas when the window closes.
 */
export declare function createDisplay(canvas: HTMLCanvasElement, port: MessagePort, options?: {
  /** Whether the page may receive this document's clipboard on paste. */
  clipboard?: boolean;
  /** What takes keyboard focus (default the canvas). */
  element?: HTMLElement;
  textInput?: HTMLTextAreaElement;
  menuRoot?: Element | ShadowRoot;
  /** The box videos are placed in (default: one is added under the canvas). */
  mediaLayer?: HTMLElement;
  dialogTarget?: EventTarget;
  dialogs?: 'dismiss' | 'native';
  /** As policy.clipboard: whether a copy the page makes reaches the system clipboard. */
  clipboardWrite?: boolean | 'user';
  volume?: number;
  muted?: boolean;
  soundAllowed?: boolean;
}): {
  close(notify?: boolean): void;
  setLevel(level: { volume?: number; muted?: boolean }): void;
  /** Counters of the Web Audio samples received, and the state of the output ("suspended" until the person has used the document). */
  readonly audio: { readonly stats: { chunks: number; frames: number; peak: number; state: string } };
};

export interface RemoteWindowEventMap extends InceptionWindowEventMap {
  /** The profile's host went away; the window waits for the next one. */
  hostlost: CustomEvent<undefined>;
  /** The window is open on the host (again, after a failover). */
  attached: CustomEvent<{ window: number }>;
  /** A page of this window opened a window (policy.popups 'window'): preventDefault() closes it; show it with its show(canvas). */
  windowopen: CustomEvent<{ window: RemoteWindow; opener: string; url: string; userGesture: boolean }>;
}

/** A window of the profile's host, shown and driven from this document. */
export declare class RemoteWindow extends EventTarget {
  readonly key: string;
  /** The window's id on the host; 0 while it has none (the host is gone). */
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly securityState: SecurityState | null;
  readonly tabs: Array<{ id: number; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; audible: boolean; active: boolean }>;
  readonly activeTab: number;
  readonly closed: boolean;
  /** Resolves once the window is open on the host (again, after a failover). */
  readonly ready: Promise<void>;
  /** Draws the window on `canvas` and sends it the person's input; options as createDisplay's. */
  show(canvas: HTMLCanvasElement, options?: Parameters<typeof createDisplay>[2]): void;
  hide(): void;
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(options?: { bypassCache?: boolean }): Promise<void>;
  stop(): Promise<void>;
  find(text: string, options?: { backwards?: boolean; caseSensitive?: boolean }): Promise<FindResult>;
  findClear(): Promise<void>;
  zoom(factor: number): Promise<void>;
  history(options?: { text?: string; limit?: number; before?: number }): Promise<HistoryEntry[]>;
  createTab(url?: string, options?: { activate?: boolean }): Promise<unknown>;
  activateTab(id: number): Promise<void>;
  closeTab(id: number): Promise<void>;
  /** Closes the window on the host. */
  close(): void;
  addEventListener<K extends keyof RemoteWindowEventMap>(type: K, listener: (this: RemoteWindow, ev: RemoteWindowEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
}

/** This document's attachment to a profile whose host is another document. */
export declare class ProfileConnection extends EventTarget {
  readonly profile: string;
  readonly state: 'new' | 'attached' | 'lost' | 'closed';
  readonly windows: RemoteWindow[];
  /** Opens a window on the host; `key` names it across a failover. */
  open(options?: { width?: number; height?: number; deviceScaleFactor?: number; url?: string; frames?: 'auto' | 'bitmap' | 'pixels'; key?: string }): Promise<RemoteWindow>;
  close(reason?: string): void;
}

/** Rejected by connectProfile() and by a view's `ready` when no document holding the profile can be reached. */
export declare class AttachUnavailableError extends Error {}

/**
 * Attaches this document to the host of `profile` (the document that holds its lock), to open windows there and
 * show them. Finds the host through the document that opened this one, or through a shared worker; when the host
 * goes away, follows the profile to the next document that takes it and reopens the windows there.
 */
export declare function connectProfile(profile?: string, options?: { via?: Array<'opener' | 'broker'>; brokerUrl?: string }): Promise<ProfileConnection>;

declare global {
  interface HTMLElementTagNameMap {
    'inception-view': InceptionView;
    'inception-window': InceptionWindowElement;
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
  NotReady: -32010;
  NoSuchRef: -32011;
  StaleRef: -32012;
  Timeout: -32013;
  NavigationFailed: -32014;
  DeniedByPolicy: -32015;
  NotSupported: -32016;
  ControlHeld: -32017;
  EngineCrashed: -32018;
  RateLimited: -32019;
  NotActionable: -32020;
  UnsupportedMode: -32021;
}>;

/** Stable failure names (error.data.reason) and their codes. */
export declare const REASON_CODES: Readonly<Record<string, number>>;

export declare class ProtocolError extends Error {
  constructor(code: number, message: string, data?: unknown);
  code: number;
  data?: unknown;
  /** The stable failure name, e.g. 'stale_ref' or 'denied_by_policy'. */
  readonly reason: string | undefined;
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
  /** The window this client is bound to, after hello. */
  window: number;
  /** `window`: bind to that window (allowed for the connection's own, or with the 'windows' capability). */
  hello(capabilities?: string[], options?: { window?: number }): Promise<{ version: number; capabilities: string[]; window: number }>;
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
