// <InceptionView>: the <inception-view> element as a React component. The
// element is loaded on the client only (dynamic import after mount), so on the
// server the component renders an empty placeholder of the same size.
import { createElement, forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

// Prop name -> DOM event the view dispatches.
const EVENTS = {
  onNavigate: 'navigate',
  onTitle: 'title',
  onLoading: 'loading',
  onNavigationState: 'navigationstate',
  onPopup: 'popup',
  onConsole: 'console',
  onCrash: 'crash',
  onCursor: 'cursor',
  onFullscreen: 'fullscreen',
  onZoom: 'zoom',
  onFindResult: 'findresult',
  onContextMenu: 'contextmenurequest',
  onDialog: 'dialog',
  onFileChooser: 'filechooser',
  onSelectMenu: 'selectmenu',
  onPermissionRequest: 'permissionrequest',
  onDownloadStart: 'downloadstart',
  onDownloadProgress: 'downloadprogress',
  onDownloadFinish: 'downloadfinish',
};

// Prop name -> element attribute. Booleans set or remove the attribute.
const ATTRIBUTES = {
  src: 'src',
  profile: 'profile',
  freshProfile: 'fresh-profile',
  userAgent: 'user-agent',
  gpu: 'gpu',
  autoplaySound: 'autoplay-sound',
  provenanceCorner: 'provenance-corner',
};

const METHODS = ['navigate', 'back', 'forward', 'reload', 'stop', 'find', 'findClear', 'zoom', 'history', 'deleteHistory', 'download', 'cancelDownload', 'serve', 'focusInput', 'debugEvaluate', 'debugHeap', 'debugCommand'];

let configured = false;
let loading = null;

// Loads the element once per page and applies the configuration the first time.
function load(config) {
  // Relative URLs (as the Next adapter gives) resolve against the page.
  for (const key of ['engineUrl', 'binaryenUrl']) if (config[key]) config[key] = new URL(config[key], location.href).href;
  loading ??= import('inceptionjs');
  return loading.then((module) => {
    if (!configured && config.engineUrl) {
      module.Inception.configure(config);
      configured = true;
    }
    return module;
  });
}

export const InceptionView = forwardRef(function InceptionView(props, ref) {
  const { engineUrl, relayUrl, binaryenUrl, userAgent: _ua, webglContexts, modules, policy, preferences, style, className, ...rest } = props;
  const element = useRef(null);
  const [defined, setDefined] = useState(false);
  const handlers = useRef({});
  handlers.current = props;

  useEffect(() => {
    let alive = true;
    load({ engineUrl, wispUrl: relayUrl, binaryenUrl, webglContexts, modules, policy })
      .then(() => alive && setDefined(true))
      .catch((error) => handlers.current.onCrash?.(new CustomEvent('crash', { detail: { reason: String(error?.message ?? error) } })));
    return () => {
      alive = false;
    };
    // Configuration is per page and read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Events: one listener per type, reading the latest prop.
  useEffect(() => {
    const node = element.current;
    if (!defined || !node) return;
    const listeners = Object.entries(EVENTS).map(([prop, type]) => {
      const listener = (event) => handlers.current[prop]?.(event);
      node.addEventListener(type, listener);
      return [type, listener];
    });
    return () => listeners.forEach(([type, listener]) => node.removeEventListener(type, listener));
  }, [defined]);

  useEffect(() => {
    if (defined && preferences && element.current) element.current.preferences = preferences;
  }, [defined, preferences]);

  useImperativeHandle(ref, () => {
    const handle = { get element() { return element.current; }, get ready() { return element.current?.ready; } };
    for (const name of METHODS) handle[name] = (...args) => element.current[name](...args);
    for (const name of ['url', 'title', 'loading', 'canGoBack', 'canGoForward'])
      Object.defineProperty(handle, name, { get: () => element.current?.[name] });
    return handle;
  }, []);

  // The element is created only after the module is loaded and configured:
  // an <inception-view> upgraded before configure() would start without an
  // engine URL. Until then (and on the server) a box of the same size.
  if (!defined) return createElement('div', { style, className, 'data-inception-placeholder': '' });
  const attributes = { ref: element, style, className };
  for (const [prop, attribute] of Object.entries(ATTRIBUTES)) {
    const value = prop === 'userAgent' ? _ua : rest[prop];
    if (value === true) attributes[attribute] = '';
    else if (value !== undefined && value !== false && value !== null) attributes[attribute] = String(value);
  }
  return createElement('inception-view', attributes);
});
