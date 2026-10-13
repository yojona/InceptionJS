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
//   {type: 'probe', ok}              whether the probe bitmap arrived
//   {type: 'answer', id, value}      the reply to an "ask"
//   {type: 'file', name, bytes}      a file the person chose for a file
//                                    chooser the window raised ("file.choose"
//                                    event); "file.chosen" input follows
//   {type: 'media', command, args}   state of a video the display plays
//                                    (media.state, media.bufferDone)
// host to display:
//   {type: 'probe', bitmap}          a 1x1 bitmap, once, at attach time
//   {type: 'frame', bitmap}          transferred, when the probe arrived
//   {type: 'pixels', width, height, buffer}
//                                    RGBA, transferred, otherwise: some
//                                    browsers drop a bitmap posted through a
//                                    port to another document (WebKit always,
//                                    Firefox when not isolated)
//   {type: 'event', name, data}      cursor, select.show|update|hide, control,
//                                    file.choose, clipboard.write
//   {type: 'closed'}                 the window was closed
//   {type: 'ask', id, question}      a dialog (alert, confirm, prompt,
//                                    beforeunload) the page is blocked on
//   {type: 'media', name, data}      media.* events of the window's videos and
//                                    {type: 'media-append' | 'media-chunk'}
//                                    with their bytes: the display plays them
//   {type: 'audio-port'} + [port]    a port that carries {type: 'pcm'} sound
//                                    of the window's Web Audio (host/pcm.js)
// Messages from a display are untrusted: anything not of this shape is
// dropped, and the host stamps the window id itself, so whatever window a
// display names is ignored.

import { attachInput, writeClipboard } from './input.js';
import { SelectMenu, answerDialog, chooseFiles } from './ui.js';
import { canvasSink } from './runtime.js';
import { MediaHost } from './media.js';
import { PcmPlayer, PcmTap } from './pcm.js';

export const DISPLAY_INPUT_COMMANDS = new Set(['mouse', 'wheel', 'key', 'ime.set', 'ime.commit', 'ime.cancel', 'focus', 'edit', 'clipboard.set', 'select.choose', 'file.chosen']);
// Events a display needs to draw its part.
export const DISPLAY_EVENTS = new Set(['cursor', 'select.show', 'select.update', 'select.hide', 'control', 'file.choose', 'clipboard.write']);

// What a display's videos may send back to the engine.
const MEDIA_COMMANDS = new Set(['media.state', 'media.bufferDone']);

const MAX_ARGS_CHARS = 64 * 1024;
const MAX_SIZE = 16384;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
// How long after the person's input in the display's document a page may
// still write the clipboard.
const CLIPBOARD_GESTURE_MS = 2000;

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
    case 'probe':
      return typeof message.ok === 'boolean' ? { type: 'probe', ok: message.ok } : null;
    case 'file':
      if (typeof message.name !== 'string' || !message.name || message.name.length > 255 || !(message.bytes instanceof ArrayBuffer) || message.bytes.byteLength > MAX_FILE_BYTES) return null;
      return { type: 'file', name: message.name, bytes: message.bytes };
    case 'answer': {
      const { id, value } = message;
      if (!Number.isInteger(id) || id < 1) return null;
      return { type: 'answer', id, value: value === null || typeof value === 'boolean' || typeof value === 'string' ? value : null };
    }
    case 'media': {
      if (!MEDIA_COMMANDS.has(message.command) || !isObject(message.args)) return null;
      let text;
      try {
        text = JSON.stringify(message.args);
      } catch {
        return null;
      }
      return text.length > MAX_ARGS_CHARS ? null : { type: 'media', command: message.command, args: JSON.parse(text) };
    }
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

// The host's end of a display channel for one window: frames go out on the
// port, validated input comes in to `send` (the window's sender). `frames`:
// 'auto' (bitmaps if the display received the probe, RGBA otherwise),
// 'bitmap' or 'pixels'. Returns {sink, post(name, data), ask(question), media,
// audio, close()}; `onClose` runs when the display goes away.
//
// `send` carries input to the window, `sendMedia` the state of its videos to
// the engine. `ask` resolves with the display's answer to a dialog, or undefined when the
// display goes away first (the caller then answers by its own policy).
// `media` stands in for the window's MediaHost: the display plays the
// window's videos, so their events and bytes cross the port and their state
// comes back through `send`. `audio` takes the engine's audio rings.
export function serveDisplay(port, { send, sendMedia = send, sendFile, onVisibility, onClose, frames = 'auto' }) {
  let open = true;
  // Until the display answers the probe, frames go as pixels: they always arrive.
  let bitmaps = frames === 'bitmap';
  let scratch = null;
  const asks = new Map();
  let nextAsk = 1;
  let tap = null;
  // The display may send files only for a chooser the window raised.
  let choosing = false;
  const close = (notify) => {
    if (!open) return;
    open = false;
    if (notify) port.postMessage({ type: 'closed' });
    port.close();
    for (const resolve of asks.values()) resolve(undefined);
    asks.clear();
    tap?.stop();
    tap = null;
    onClose?.();
  };
  port.addEventListener('message', (event) => {
    const message = validateDisplayMessage(event.data);
    if (!open || !message) return;
    if (message.type === 'input') {
      if (message.command === 'file.chosen') {
        if (!choosing) return;
        choosing = false;
      }
      send(message.command, message.args);
    } else if (message.type === 'file') {
      if (choosing) sendFile?.(message.name, message.bytes);
    } else if (message.type === 'resize') send('resize', { width: message.width, height: message.height, deviceScaleFactor: message.deviceScaleFactor });
    else if (message.type === 'visibility') onVisibility?.(message.visible);
    else if (message.type === 'probe') bitmaps = frames === 'auto' ? message.ok : bitmaps;
    else if (message.type === 'answer') {
      asks.get(message.id)?.(message.value);
      asks.delete(message.id);
    } else if (message.type === 'media') sendMedia(message.command, message.args);
    else if (message.type === 'close') close(false);
  });
  port.start();
  if (frames === 'auto') {
    createImageBitmap(new ImageData(1, 1)).then((bitmap) => open && port.postMessage({ type: 'probe', bitmap }, [bitmap]), () => {});
  }
  // One readback per frame: the bitmap is drawn and its pixels transferred.
  const pixels = (bitmap) => {
    const { width, height } = bitmap;
    if (!scratch || scratch.canvas.width !== width || scratch.canvas.height !== height)
      scratch = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    scratch.clearRect(0, 0, width, height);
    scratch.drawImage(bitmap, 0, 0);
    bitmap.close();
    const { data } = scratch.getImageData(0, 0, width, height);
    port.postMessage({ type: 'pixels', width, height, buffer: data.buffer }, [data.buffer]);
  };
  // Bytes the engine handed over are transferred when they own their buffer.
  const bytesOf = (bytes) => {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength ? view : view.slice();
  };
  const players = new Set();
  const fetches = new Set();
  const media = {
    hasPlayer: (id) => players.has(id),
    ownsFetch: (id) => fetches.has(id),
    // The window moved to another engine: its videos there are gone.
    reset() {
      for (const id of [...players]) media.handleEvent('media.destroy', { id });
      fetches.clear();
    },
    handleEvent(name, data) {
      if (!open) return;
      if (name === 'media.create') players.add(data.id);
      if (name === 'media.destroy') players.delete(data.id);
      if (name === 'media.load' && data.fetch) fetches.add(data.fetch);
      port.postMessage({ type: 'media', name, data });
    },
    handleFetchEvent(name, data) {
      if (!open || !fetches.has(data.id)) return;
      if (name === 'media.fetch.finished') fetches.delete(data.id);
      port.postMessage({ type: 'media', name, data });
    },
    append(id, sb, seq, bytes) {
      if (!open) return;
      const view = bytesOf(bytes);
      port.postMessage({ type: 'media-append', id, sb, seq, bytes: view }, [view.buffer]);
    },
    fetchChunk({ id, bytes }) {
      if (!open) return;
      const view = bytesOf(bytes);
      port.postMessage({ type: 'media-chunk', id, bytes: view }, [view.buffer]);
    },
    keysUsable() {},
    setLayer() {},
    setMaster() {},
    userGesture() {},
  };
  const rings = new Set();
  const audio = {
    open(ring, memory) {
      if (!open) return;
      if (!tap) {
        const { port1, port2 } = new MessageChannel();
        port.postMessage({ type: 'audio-port' }, [port2]);
        tap = new PcmTap(port1);
      }
      rings.add(ring.id);
      tap.open(ring, memory);
    },
    close(id) {
      if (rings.delete(id)) tap?.close(id);
    },
    has: (id) => rings.has(id),
  };
  return {
    sink: {
      present(bitmap) {
        if (!open) return bitmap.close();
        if (bitmaps) port.postMessage({ type: 'frame', bitmap }, [bitmap]);
        else pixels(bitmap);
      },
    },
    post(name, data) {
      if (!open || !DISPLAY_EVENTS.has(name)) return;
      if (name === 'file.choose') choosing = true;
      port.postMessage({ type: 'event', name, data });
    },
    ask(question) {
      if (!open) return Promise.resolve(undefined);
      const id = nextAsk++;
      return new Promise((resolve) => {
        asks.set(id, resolve);
        port.postMessage({ type: 'ask', id, question });
      });
    },
    media,
    audio,
    close: () => close(true),
  };
}

// Shows a window of an engine that lives in another document, through the
// port its view's exportWindow() returned. `canvas` is this document's; the
// display follows its size and sends its input. It needs no cross-origin
// isolation. The window's dialogs, videos and Web Audio come here too: a
// dialog is raised as a cancelable "dialog" event on `dialogTarget` (see
// answerDialog in host/ui.js), videos play in this document under the canvas
// and their sound through it, Web Audio arrives as samples that play once the
// person has used this document. A "closed" event fires on the canvas when the
// window closes.
//
// options: clipboard (whether the page may receive this document's clipboard
// on paste), element (what takes the keyboard focus; default the canvas),
// textInput (the hidden field IME input goes through; default: one is added),
// menuRoot (where select menus open), mediaLayer (the box videos are placed
// in; default: one is added under the canvas), dialogTarget and dialogs
// ('dismiss' | 'native', as policy.dialogs), clipboardWrite (as
// policy.clipboard: whether a copy the page makes reaches this document's
// system clipboard; 'user' only soon after the person's own input), volume,
// muted, soundAllowed (playing with sound is allowed without a gesture). A
// file chooser the window raises is a cancelable "filechooser" event on
// dialogTarget, or this document's own picker.
//
// Returns {close(notify = true), setLevel({volume, muted}), media, audio}:
// `media` is the MediaHost of this display's videos and `audio` its PcmPlayer.
export function createDisplay(canvas, port, { clipboard = true, element = canvas, textInput = null, menuRoot = null, mediaLayer = null, dialogTarget = canvas, dialogs = 'dismiss', clipboardWrite = 'user', volume = 1, muted = false, soundAllowed = false } = {}) {
  const sink = canvasSink(canvas);
  let ownTextInput = null;
  if (!textInput) {
    ownTextInput = textInput = document.createElement('textarea');
    textInput.setAttribute('aria-label', 'Web content');
    Object.assign(textInput.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', padding: '0', border: '0', opacity: '0', resize: 'none', pointerEvents: 'none' });
    canvas.after(textInput);
  }
  if (!element.hasAttribute('tabindex')) element.tabIndex = 0;
  const send = (command, args = {}) => port.postMessage({ type: 'input', command, args });
  const selectMenu = new SelectMenu(menuRoot ?? canvas.parentElement ?? document.body, send);
  const detachInput = attachInput(element, canvas, textInput, send, { clipboard });

  // Videos play in a box under the canvas, which the engine leaves
  // transparent where a video is.
  let ownLayer = null;
  let layerFollows = null;
  if (!mediaLayer) {
    ownLayer = mediaLayer = document.createElement('div');
    Object.assign(mediaLayer.style, { position: 'absolute', overflow: 'hidden', pointerEvents: 'none', zIndex: '0' });
    const style = getComputedStyle(canvas);
    if (style.position === 'static') canvas.style.position = 'relative';
    if (style.zIndex === 'auto') canvas.style.zIndex = '1';
    canvas.before(mediaLayer);
    layerFollows = () => Object.assign(mediaLayer.style, { left: `${canvas.offsetLeft}px`, top: `${canvas.offsetTop}px`, width: `${canvas.clientWidth}px`, height: `${canvas.clientHeight}px` });
    layerFollows();
  }
  const mediaHost = new MediaHost(mediaLayer, (command, args) => port.postMessage({ type: 'media', command, args }), { soundAllowed });
  mediaHost.setMaster({ volume, muted });
  const gesture = () => mediaHost.userGesture();
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, gesture, true);
  const player = new PcmPlayer({ volume, muted });
  const level = { volume, muted };
  let lastInput = -Infinity;
  const used = (event) => event.isTrusted && (lastInput = performance.now());
  const inputTypes = ['pointerdown', 'keydown', 'copy', 'cut'];
  for (const type of inputTypes) document.addEventListener(type, used, true);
  const mayWriteClipboard = () => clipboardWrite === true || (clipboardWrite === 'user' && performance.now() - lastInput < CLIPBOARD_GESTURE_MS);
  const chooser = {
    send: (command, args) => port.postMessage({ type: 'input', command, args }),
    sendFile: (name, bytes) => port.postMessage({ type: 'file', name, bytes }, [bytes]),
  };

  const sendSize = () => {
    const { width, height } = cssSizeOf(canvas);
    layerFollows?.();
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
    for (const type of ['pointerdown', 'keydown']) document.removeEventListener(type, gesture, true);
    for (const type of inputTypes) document.removeEventListener(type, used, true);
    detachInput?.();
    ownTextInput?.remove();
    ownLayer?.remove();
    player.close();
  };
  // A bitmap that cannot cross into this document arrives as an error: the
  // host then sends pixels.
  port.addEventListener('messageerror', () => open && port.postMessage({ type: 'probe', ok: false }));
  const MAX_PIXELS = MAX_SIZE * MAX_SIZE;
  const MAX_ASK_CHARS = 64 * 1024;
  port.addEventListener('message', (event) => {
    const message = event.data;
    if (!open || !isObject(message)) return;
    if (message.type === 'probe') {
      message.bitmap?.close?.();
      port.postMessage({ type: 'probe', ok: !!message.bitmap });
    } else if (message.type === 'frame' && message.bitmap) sink.present(message.bitmap);
    else if (message.type === 'pixels' && message.buffer instanceof ArrayBuffer) {
      const { width, height, buffer } = message;
      if (!(width > 0 && height > 0 && width * height <= MAX_PIXELS && buffer.byteLength === width * height * 4)) return;
      createImageBitmap(new ImageData(new Uint8ClampedArray(buffer), width, height)).then((bitmap) => open && sink.present(bitmap), () => {});
    }
    else if (message.type === 'event' && isObject(message.data)) {
      const { name, data } = message;
      if (name === 'cursor') canvas.style.cursor = String(data.cursor ?? 'default');
      if (name === 'select.show') selectMenu.show(canvas, data);
      if (name === 'select.update') selectMenu.update(data);
      if (name === 'select.hide') selectMenu.hide(data.id);
      if (name === 'control') canvas.dataset.control = data.control === 'agent' ? 'agent' : 'human';
      if (name === 'file.choose') chooseFiles(dialogTarget, chooser, { multiple: !!data.multiple, accept: Array.isArray(data.accept) ? data.accept.map(String).slice(0, 64) : [], directory: !!data.directory });
      if (name === 'clipboard.write' && isObject(data.items) && mayWriteClipboard()) writeClipboard(Object.fromEntries(Object.entries(data.items).filter(([, value]) => typeof value === 'string')));
    } else if (message.type === 'ask' && Number.isInteger(message.id) && isObject(message.question)) {
      const { question: kind, message: text, defaultValue } = message.question;
      const question = { question: String(kind ?? '').slice(0, 32), message: String(text ?? '').slice(0, MAX_ASK_CHARS), ...(defaultValue === undefined ? {} : { defaultValue: String(defaultValue).slice(0, MAX_ASK_CHARS) }) };
      answerDialog(dialogTarget, question, () => ({ dialogs })).then((value) => open && port.postMessage({ type: 'answer', id: message.id, value: value ?? null }));
    } else if (message.type === 'media' && typeof message.name === 'string' && isObject(message.data)) {
      if (message.name.startsWith('media.fetch.')) mediaHost.handleFetchEvent(message.name, message.data);
      else mediaHost.handleEvent(message.name, message.data);
    } else if (message.type === 'media-append' && message.bytes instanceof Uint8Array) mediaHost.append(message.id, message.sb, message.seq, message.bytes);
    else if (message.type === 'media-chunk' && message.bytes instanceof Uint8Array) mediaHost.fetchChunk({ id: message.id, bytes: message.bytes });
    else if (message.type === 'audio-port' && event.ports[0]) player.attach(event.ports[0]);
    else if (message.type === 'closed') {
      stop();
      canvas.dispatchEvent(new CustomEvent('closed'));
    }
  });
  port.start();
  visibility();
  sendSize();
  return {
    media: mediaHost,
    audio: player,
    setLevel(change = {}) {
      Object.assign(level, change);
      mediaHost.setMaster(level);
      player.setLevel(level);
    },
    // Input as if the person made it: an editing command, say.
    input: send,
    // `notify` false: the host is gone, so there is nobody to tell.
    close(notify = true) {
      if (!open) return;
      if (notify) port.postMessage({ type: 'close' });
      stop();
      port.close();
    },
  };
}
