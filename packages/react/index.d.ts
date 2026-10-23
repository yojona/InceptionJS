import type { CSSProperties, ForwardRefExoticComponent, RefAttributes, RefObject } from 'react';
import type { InceptionConfig, InceptionView as InceptionViewElement, InceptionViewEventMap, Preferences } from 'inceptionjs';

type Handler<K extends keyof InceptionViewEventMap> = (event: InceptionViewEventMap[K]) => void;

export interface InceptionViewProps {
  /** Page to load. Changing it navigates. */
  src?: string;
  /** Read once per page, by the first view that mounts. */
  engineUrl?: string;
  relayUrl?: string;
  binaryenUrl?: string;
  webglContexts?: number;
  modules?: InceptionConfig['modules'];
  policy?: InceptionConfig['policy'];

  profile?: string;
  freshProfile?: boolean;
  userAgent?: string;
  gpu?: 'auto' | 'on' | 'off';
  autoplaySound?: boolean;
  /** Enables the handle's debug methods (development only). */
  debug?: boolean;
  provenanceCorner?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** false hides the provenance badge (provenance="off"). */
  provenance?: boolean;
  /** Turns the agent namespace on for this view. */
  agent?: boolean;
  isolation?: 'shared' | 'window' | 'site';
  /** Window 1 is not drawn here until exportWindow(1) or an <InceptionWindow> shows it. */
  headless?: boolean;
  /** false: never attach to a profile another tab holds (attach="off"). */
  attach?: boolean;
  muted?: boolean;
  /** 0 to 1. */
  volume?: number;
  preferences?: Partial<Preferences>;
  style?: CSSProperties;
  className?: string;

  onNavigate?: Handler<'navigate'>;
  onTitle?: Handler<'title'>;
  onLoading?: Handler<'loading'>;
  onNavigationState?: Handler<'navigationstate'>;
  onPopup?: Handler<'popup'>;
  onConsole?: Handler<'console'>;
  onCrash?: Handler<'crash'>;
  onCursor?: Handler<'cursor'>;
  onFullscreen?: Handler<'fullscreen'>;
  onZoom?: Handler<'zoom'>;
  onFindResult?: Handler<'findresult'>;
  onContextMenu?: Handler<'contextmenurequest'>;
  onDialog?: Handler<'dialog'>;
  onFileChooser?: Handler<'filechooser'>;
  onSelectMenu?: Handler<'selectmenu'>;
  onPermissionRequest?: Handler<'permissionrequest'>;
  onDownloadStart?: Handler<'downloadstart'>;
  onDownloadProgress?: Handler<'downloadprogress'>;
  onDownloadFinish?: Handler<'downloadfinish'>;
  onDownloadBlocked?: Handler<'downloadblocked'>;
  onDialogBlocked?: Handler<'dialogblocked'>;
  onPopupBlocked?: Handler<'popupblocked'>;
  onNewTab?: Handler<'newtab'>;
  onSecurityState?: Handler<'securitystate'>;
  onCertificateError?: Handler<'certificateerror'>;
  onSensitivePage?: Handler<'sensitivepage'>;
  onProvenanceTampered?: Handler<'provenancetampered'>;
  onHostLost?: Handler<'hostlost'>;
  onReattached?: Handler<'reattached'>;
  onPromoted?: Handler<'promoted'>;
  onSiteSwap?: Handler<'siteswap'>;
  onWindowOpen?: Handler<'windowopen'>;
  onWindowCreated?: Handler<'windowcreated'>;
  onWindowClosed?: Handler<'windowclosed'>;
  onWindowUpdated?: Handler<'windowupdated'>;
  onWindowFocusRequest?: Handler<'windowfocusrequest'>;
  onControl?: Handler<'control'>;
  onAgentAction?: Handler<'agentaction'>;
  onAgentBlocked?: Handler<'agentblocked'>;
}

export type InceptionViewHandle = Pick<
  InceptionViewElement,
  | 'navigate' | 'back' | 'forward' | 'reload' | 'stop' | 'find' | 'findClear' | 'zoom'
  | 'history' | 'deleteHistory' | 'download' | 'cancelDownload' | 'close'
  | 'serve' | 'focusInput' | 'securityState' | 'agent' | 'closed'
  | 'openWindow' | 'window' | 'exportWindow' | 'windows'
  | 'debugEvaluate' | 'debugHeap' | 'debugCommand'
  | 'url' | 'title' | 'loading' | 'canGoBack' | 'canGoForward'
> & {
  readonly element: InceptionViewElement | null;
  readonly ready: InceptionViewElement['ready'] | undefined;
};

export declare const InceptionView: ForwardRefExoticComponent<InceptionViewProps & RefAttributes<InceptionViewHandle>>;

export interface InceptionWindowProps {
  /** The <InceptionView> (its ref or handle) whose engine owns the window. */
  view: RefObject<InceptionViewHandle | null> | InceptionViewHandle | InceptionViewElement | null;
  /** The window id (2 or more; window 1 is the view). */
  window: number;
  style?: CSSProperties;
  className?: string;
}

export declare const InceptionWindow: ForwardRefExoticComponent<InceptionWindowProps & RefAttributes<{ readonly element: HTMLElement | null }>>;
