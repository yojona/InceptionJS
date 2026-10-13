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
  onWindowOpen?: Handler<'windowopen'>;
  onWindowCreated?: Handler<'windowcreated'>;
  onWindowClosed?: Handler<'windowclosed'>;
}

export type InceptionViewHandle = Pick<
  InceptionViewElement,
  | 'navigate' | 'back' | 'forward' | 'reload' | 'stop' | 'find' | 'findClear' | 'zoom'
  | 'history' | 'deleteHistory' | 'download' | 'cancelDownload' | 'serve' | 'focusInput'
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
