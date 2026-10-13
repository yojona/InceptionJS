// Displays: what shows one window of an engine and feeds it input. A display
// in the engine's own document draws into a canvas directly (Display); one in
// another document (or frame, or worker-free page without cross-origin
// isolation) talks to the engine's host over a MessagePort, the display
// channel (serveDisplay on the host's side, createDisplay on the other).
//
// The display channel, display to host:
//   {type: 'input', command, args}   command: mouse, wheel, key, ime.set,
//                                    ime.commit, ime.cancel, focus, edit,
//                                    clipboard.set, select.choose
//   {type: 'resize', width, height, deviceScaleFactor}
//   {type: 'visibility', visible}
//   {type: 'close'}                  the display goes away (the window stays)
// host to display:
//   {type: 'frame', bitmap}          transferred
//   {type: 'event', name, data}      cursor, select.show|update|hide, control
//   {type: 'closed'}                 the window was closed
// Messages from a display are untrusted: anything not of this shape is
// dropped, and the host stamps the window id itself, so whatever window a
// display names is ignored.

import { attachInput } from './input.js';
import { SelectMenu } from './ui.js';
import { canvasSink } from './runtime.js';

export const DISPLAY_INPUT_COMMANDS = new Set(['mouse', 'wheel', 'key', 'ime.set', 'ime.commit', 'ime.cancel', 'focus', 'edit', 'clipboard.set', 'select.choose']);
// Events a display needs to draw its part.
export const DISPLAY_EVENTS = new Set(['cursor', 'select.show', 'select.update', 'select.hide', 'control']);

const MAX_ARGS_CHARS = 64 * 1024;
const MAX_SIZE = 16384;

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const dimension = (value) => Number.isFinite(value) && value >= 1 && value <= MAX_SIZE;

// A message from a display, normalized, or null when it must be dropped.
export function validateDisplayMessage(message) {
  if (!isObject(message) || typeof message.type !== 'string') return null;
  switch (message.type) {
    case 'input': {
      if (!DISPLAY_INPUT_COMMANDS.has(message.command)) return null;
      const args = message.args ?? {};
      if (!isObject(args)) return null;
      let text;
      try {
        text = JSON.stringify(args);
      } catch {
        return null;
      }
      if (text.length > MAX_ARGS_CHARS) return null;
      const clean = JSON.parse(text);
      delete clean.window;
      return { type: 'input', command: message.command, args: clean };
    }
    case 'resize': {
      const { width, height } = message;
      const deviceScaleFactor = message.deviceScaleFactor ?? 1;
      if (!dimension(width) || !dimension(height) || !(deviceScaleFactor > 0 && deviceScaleFactor <= 8)) return null;
      return { type: 'resize', width: Math.round(width), height: Math.round(height), deviceScaleFactor };
    }
    case 'visibility':
      return typeof message.visible === 'boolean' ? { type: 'visibility', visible: message.visible } : null;
    case 'close':
      return { type: 'close' };
    default:
      return null;
  }
}

const cssSizeOf = (element) => {
  const rect = element.getBoundingClientRect();
  return { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
};

// A display in the engine's document. `element` is the box it fills (the
// view or an <inception-window>); `shadow` holds the select menu; `send`
// sends a command to its window. Input and size reporting start with
// start(), once the engine is ready.
export class Display {
  #element;
  #canvas;
  #textInput;
  #send;
  #selectMenu;
  #resizeObserver = null;
  #detachInput = null;

  constructor({ element, shadow, canvas, textInput, send }) {
    this.#element = element;
    this.#canvas = canvas;
    this.#textInput = textInput;
    this.#send = send;
    this.sink = canvasSink(canvas);
    this.#selectMenu = new SelectMenu(shadow, send);
  }

  get element() { return this.#element; }
  get canvas() { return this.#canvas; }

  cssSize() {
    return cssSizeOf(this.#element);
  }

  // `input`: the sender input goes through (the agent's watch wraps it).
  start({ input = this.#send, clipboard = true } = {}) {
    this.#detachInput = attachInput(this.#element, this.#canvas, this.#textInput, input, { clipboard });
    this.#resizeObserver = new ResizeObserver(() => this.#send('resize', { ...this.cssSize(), deviceScaleFactor: devicePixelRatio }));
    this.#resizeObserver.observe(this.#element);
  }

  stop() {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#detachInput?.();
    this.#detachInput = null;
  }

  // Engine events for this window that the display draws.
  handleEvent(name, data) {
    if (name === 'cursor') this.#canvas.style.cursor = data.cursor;
    if (name === 'select.show') this.#selectMenu.show(this.#element, data);
    if (name === 'select.update') this.#selectMenu.update(data);
    if (name === 'select.hide') this.#selectMenu.hide(data.id);
  }
}

// The host's end of a display channel for window `window`: frames go out on
// the port, validated input comes in to `send` (the window's sender). Returns
// {sink, post(event), close()}; `onClose` runs when the display goes away.
export function serveDisplay(port, { send, onVisibility, onClose }) {
  let open = true;
  const close = (notify) => {
    if (!open) return;
    open = false;
    if (notify) port.postMessage({ type: 'closed' });
    port.close();
    onClose?.();
  };
  port.addEventListener('message', (event) => {
    const message = validateDisplayMessage(event.data);
    if (!open || !message) return;
    if (message.type === 'input') send(message.command, message.args);
    else if (message.type === 'resize') send('resize', { width: message.width, height: message.height, deviceScaleFactor: message.deviceScaleFactor });
    else if (message.type === 'visibility') onVisibility?.(message.visible);
    else if (message.type === 'close') close(false);
  });
  port.start();
  return {
    sink: {
      present(bitmap) {
        if (!open) return bitmap.close();
        port.postMessage({ type: 'frame', bitmap }, [bitmap]);
      },
    },
    post(name, data) {
      if (open && DISPLAY_EVENTS.has(name)) port.postMessage({ type: 'event', name, data });
    },
    close: () => close(true),
  };
}

// Shows a window of an engine that lives in another document, through the
// port its view's exportWindow() returned. `canvas` is this document's; the
// display follows its size and sends its input. It needs no cross-origin
// isolation. Video, audio and dialogs of the window stay in the engine's
// document. Returns {close()}; a "closed" event fires on the canvas when the
// window closes.
export function createDisplay(canvas, port, { clipboard = true } = {}) {
  const sink = canvasSink(canvas);
  const textInput = document.createElement('textarea');
  textInput.setAttribute('aria-label', 'Web content');
  Object.assign(textInput.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', padding: '0', border: '0', opacity: '0', resize: 'none', pointerEvents: 'none' });
  canvas.after(textInput);
  if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
  const send = (command, args = {}) => port.postMessage({ type: 'input', command, args });
  const menuRoot = canvas.parentElement ?? document.body;
  const selectMenu = new SelectMenu(menuRoot, send);
  const detachInput = attachInput(canvas, canvas, textInput, send, { clipboard });
  const sendSize = () => {
    const { width, height } = cssSizeOf(canvas);
    port.postMessage({ type: 'resize', width, height, deviceScaleFactor: devicePixelRatio });
  };
  const resizeObserver = new ResizeObserver(sendSize);
  resizeObserver.observe(canvas);
  const visibility = () => port.postMessage({ type: 'visibility', visible: document.visibilityState === 'visible' });
  document.addEventListener('visibilitychange', visibility);
  let open = true;
  const stop = () => {
    open = false;
    resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', visibility);
    detachInput?.();
    textInput.remove();
  };
  port.addEventListener('message', (event) => {
    const message = event.data;
    if (!open || !isObject(message)) return;
    if (message.type === 'frame' && message.bitmap) sink.present(message.bitmap);
    else if (message.type === 'event' && isObject(message.data)) {
      const { name, data } = message;
      if (name === 'cursor') canvas.style.cursor = String(data.cursor ?? 'default');
      if (name === 'select.show') selectMenu.show(canvas, data);
      if (name === 'select.update') selectMenu.update(data);
      if (name === 'select.hide') selectMenu.hide(data.id);
      if (name === 'control') canvas.dataset.control = data.control === 'agent' ? 'agent' : 'human';
    } else if (message.type === 'closed') {
      stop();
      canvas.dispatchEvent(new CustomEvent('closed'));
    }
  });
  port.start();
  visibility();
  sendSize();
  return {
    close() {
      if (!open) return;
      port.postMessage({ type: 'close' });
      stop();
      port.close();
    },
  };
}
