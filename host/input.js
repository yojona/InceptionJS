// Forwards user input on a view's canvas to its engine. Positions are CSS
// pixels relative to the canvas; the engine maps them with the device scale.

const MODIFIER_BITS = { shiftKey: 1, ctrlKey: 2, altKey: 4, metaKey: 8 };

function modifiersOf(event) {
  let bits = 0;
  for (const [name, bit] of Object.entries(MODIFIER_BITS)) if (event[name]) bits |= bit;
  if (event.getModifierState?.('CapsLock')) bits |= 16;
  return bits;
}

// Keys the host browser keeps: reloading, closing, tab switching, devtools.
function belongsToHost(event) {
  const command = event.metaKey || event.ctrlKey;
  if (event.key === 'F5' || event.key === 'F12') return true;
  if (!command) return false;
  return ['r', 'w', 't', 'n', 'q', 'l', 'Tab'].includes(event.key) || (event.altKey && event.key.toLowerCase() === 'i');
}

// Keyboard input goes through `textInput`, a hidden <textarea> that holds the
// focus whenever the view has it: the platform's input method (dead keys and
// accents, IME composition, the emoji picker, dictation) only works on a real
// text field. Plain keys are forwarded as key events and kept out of it;
// composed text arrives through composition and input events. `clipboard`:
// whether the page may receive the host's clipboard on paste. `zoom()`: the
// page's current zoom factor, which a pinch starts from.
// Returns a function that removes every listener it added.
export function attachInput(element, canvas, textInput, send, { clipboard = true, zoom = () => 1 } = {}) {
  const controller = new AbortController();
  const { signal } = controller;
  const position = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const focusInput = () => textInput.focus({ preventScroll: true });
  element.focusInput = focusInput;
  element.addEventListener('focus', focusInput, { signal });

  let pressedButton = null;
  canvas.addEventListener('mousedown', (event) => {
    event.preventDefault();
    textInput.inputMode = '';
    focusInput();
    pressedButton = event.button;
    send('mouse', { type: 'down', ...position(event), button: event.button, clickCount: event.detail || 1, modifiers: modifiersOf(event) });
  }, { signal });
  // Releases and drags are followed outside the canvas too, like a native view.
  window.addEventListener('mouseup', (event) => {
    if (pressedButton === null) return;
    pressedButton = null;
    send('mouse', { type: 'up', ...position(event), button: event.button, clickCount: event.detail || 1, modifiers: modifiersOf(event) });
  }, { signal });
  window.addEventListener('mousemove', (event) => {
    // Listeners on window see the shadow host as the target; the composed
    // path says whether the pointer is over the canvas.
    if (pressedButton === null && !event.composedPath().includes(canvas)) return;
    send('mouse', { type: 'move', ...position(event), button: pressedButton ?? 0, pressed: pressedButton !== null, modifiers: modifiersOf(event) });
  }, { signal });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault(), { signal });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    send('wheel', { ...position(event), deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, modifiers: modifiersOf(event) });
  }, { passive: false, signal });

  attachTouch(canvas, textInput, send, { position, focusInput, zoom, signal });

  // While composing, keys belong to the input method; a dead key starts a
  // composition of its own.
  let composing = false;
  const composingKey = (event) => composing || event.isComposing || event.key === 'Dead' || event.keyCode === 229;
  // Paste is left to the platform so the paste event below carries the
  // clipboard; the engine pastes once it has the data.
  const isPaste = (event) => (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'v';
  textInput.addEventListener('keydown', (event) => {
    if (belongsToHost(event) || composingKey(event)) return;
    if (clipboard && isPaste(event)) return;
    event.preventDefault();
    const text = event.key.length === 1 || [...event.key].length === 1 ? event.key : event.key === 'Enter' ? '\r' : '';
    send('key', { type: 'down', key: event.key, code: event.code, keyCode: event.keyCode, text, repeat: event.repeat, modifiers: modifiersOf(event) });
  }, { signal });
  textInput.addEventListener('keyup', (event) => {
    if (belongsToHost(event) || composingKey(event)) return;
    event.preventDefault();
    send('key', { type: 'up', key: event.key, code: event.code, keyCode: event.keyCode, text: '', repeat: false, modifiers: modifiersOf(event) });
  }, { signal });

  textInput.addEventListener('compositionstart', () => {
    composing = true;
  }, { signal });
  textInput.addEventListener('compositionupdate', (event) => {
    send('ime.set', { text: event.data, selectionStart: event.data.length, selectionEnd: event.data.length });
  }, { signal });
  textInput.addEventListener('compositionend', (event) => {
    composing = false;
    send('ime.commit', { text: event.data });
    textInput.value = '';
  }, { signal });
  // Text that came without keys being forwarded: the emoji picker, dictation,
  // autocorrect.
  textInput.addEventListener('input', (event) => {
    if (composing || event.isComposing) return;
    if (event.data) send('ime.commit', { text: event.data });
    textInput.value = '';
  }, { signal });
  // Copy and cut are the engine's (it reports "clipboard.write"); paste brings
  // the host's clipboard in.
  for (const type of ['cut', 'copy']) textInput.addEventListener(type, (event) => event.preventDefault(), { signal });
  textInput.addEventListener('paste', (event) => {
    event.preventDefault();
    if (!clipboard) return;
    const items = {};
    for (const type of event.clipboardData.types)
      if (type.startsWith('text/')) items[type] = event.clipboardData.getData(type);
    send('clipboard.set', { items });
    send('edit', { command: 'Paste' });
  }, { signal });

  textInput.addEventListener('focus', () => send('focus', { focused: true }), { signal });
  textInput.addEventListener('blur', () => {
    if (composing) {
      composing = false;
      send('ime.cancel', {});
    }
    send('focus', { focused: false });
  }, { signal });
  return () => controller.abort();
}

// How far a finger may move and still tap (CSS pixels), how long it holds for
// a context menu, and how close in time and place two taps make a double tap.
const TAP_SLOP = 10;
const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 25;
// Momentum after a flick: the speed (px/ms) kept per 16 ms frame, and the
// speed below which it stops.
const FRICTION = 0.95;
const MIN_SPEED = 0.02;

// Touch and pen input, until the engine takes touch events of its own: a tap
// clicks, one finger scrolls (with momentum), two fingers pinch-zoom the page
// and a long press opens the context menu. Canceling pointerdown keeps the
// browser from also sending the mouse events it makes up after a touch, and
// touch-action keeps it from scrolling or zooming the host page instead.
// A tap focuses the view without the on-screen keyboard (inputmode none);
// the keyboard needs to know that the page focused a text field.
function attachTouch(canvas, textInput, send, { position, focusInput, zoom, signal }) {
  canvas.style.touchAction = 'none';
  const points = new Map();
  let gesture = null;
  let lastTap = null;
  let momentum = 0;

  const stopMomentum = () => {
    cancelAnimationFrame(momentum);
    momentum = 0;
  };
  const click = (at, button, clickCount) => {
    send('mouse', { type: 'move', ...at, button: 0, pressed: false, modifiers: 0 });
    send('mouse', { type: 'down', ...at, button, clickCount, modifiers: 0 });
    send('mouse', { type: 'up', ...at, button, clickCount, modifiers: 0 });
  };
  const scroll = (at, dx, dy) => send('wheel', { ...at, deltaX: dx, deltaY: dy, deltaMode: 0, modifiers: 0 });
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const pair = () => [...points.values()].slice(0, 2);
  const glide = (at, vx, vy) => {
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(now - last, 50);
      last = now;
      scroll(at, vx * dt, vy * dt);
      const keep = FRICTION ** (dt / 16);
      vx *= keep;
      vy *= keep;
      momentum = Math.hypot(vx, vy) < MIN_SPEED ? 0 : requestAnimationFrame(step);
    };
    momentum = requestAnimationFrame(step);
  };
  const endPinch = () => {
    canvas.style.transform = '';
    canvas.style.transformOrigin = '';
    const factor = Math.min(5, Math.max(0.25, gesture.zoom * gesture.scale));
    if (Math.abs(gesture.scale - 1) > 0.02) send('zoom', { factor });
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') return;
    event.preventDefault();
    stopMomentum();
    canvas.setPointerCapture?.(event.pointerId);
    const at = position(event);
    points.set(event.pointerId, at);
    textInput.inputMode = 'none';
    focusInput();
    if (points.size === 1) {
      gesture = { kind: 'press', start: at, last: at, samples: [{ ...at, t: event.timeStamp }] };
      gesture.timer = setTimeout(() => {
        if (gesture?.kind !== 'press') return;
        gesture.kind = 'held';
        click(gesture.start, 2, 1);
      }, LONG_PRESS_MS);
    } else if (points.size === 2) {
      clearTimeout(gesture?.timer);
      const [a, b] = pair();
      gesture = { kind: 'pinch', distance: distance(a, b) || 1, zoom: zoom(), scale: 1 };
      canvas.style.transformOrigin = `${(a.x + b.x) / 2}px ${(a.y + b.y) / 2}px`;
    }
  }, { signal });

  canvas.addEventListener('pointermove', (event) => {
    if (!points.has(event.pointerId) || !gesture) return;
    const at = position(event);
    points.set(event.pointerId, at);
    if (gesture.kind === 'pinch') {
      const [a, b] = pair();
      gesture.scale = distance(a, b) / gesture.distance;
      canvas.style.transform = `scale(${gesture.scale})`;
      return;
    }
    if (gesture.kind === 'press' && distance(at, gesture.start) > TAP_SLOP) {
      clearTimeout(gesture.timer);
      gesture.kind = 'pan';
    }
    if (gesture.kind !== 'pan') return;
    scroll(at, gesture.last.x - at.x, gesture.last.y - at.y);
    gesture.last = at;
    gesture.samples.push({ ...at, t: event.timeStamp });
    while (gesture.samples.length > 2 && event.timeStamp - gesture.samples[0].t > 100) gesture.samples.shift();
  }, { signal });

  const release = (event) => {
    if (!points.delete(event.pointerId) || !gesture) return;
    if (gesture.kind === 'pinch') {
      // The other finger stays down: nothing until it lifts too.
      endPinch();
      gesture = { kind: 'done' };
      return;
    }
    if (points.size) return;
    clearTimeout(gesture.timer);
    const { kind, start, samples } = gesture;
    gesture = null;
    if (event.type === 'pointercancel') return;
    if (kind === 'press') {
      const double = lastTap && event.timeStamp - lastTap.t < DOUBLE_TAP_MS && distance(start, lastTap) < DOUBLE_TAP_SLOP;
      const clickCount = double ? lastTap.count + 1 : 1;
      lastTap = { ...start, t: event.timeStamp, count: clickCount };
      click(start, 0, clickCount);
    } else if (kind === 'pan' && samples.length > 1) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = last.t - first.t;
      if (dt > 0 && event.timeStamp - last.t < 100) glide(last, (first.x - last.x) / dt, (first.y - last.y) / dt);
    }
  };
  canvas.addEventListener('pointerup', release, { signal });
  canvas.addEventListener('pointercancel', release, { signal });
  signal.addEventListener('abort', () => {
    stopMomentum();
    clearTimeout(gesture?.timer);
  });
}

// The engine copied or cut: mirror it to the system clipboard. Browsers allow
// this within the user's gesture, which the copy shortcut was.
export async function writeClipboard(items) {
  try {
    // The engine names types with parameters ("text/plain;charset=utf-8").
    const parts = {};
    for (const [type, value] of Object.entries(items)) {
      const base = type.split(';')[0].trim();
      if (base === 'text/plain' || base === 'text/html') parts[base] = new Blob([value], { type: base });
    }
    if (Object.keys(parts).length) await navigator.clipboard.write([new ClipboardItem(parts)]);
  } catch {
    const text = Object.entries(items).find(([type]) => type.split(';')[0].trim() === 'text/plain')?.[1];
    if (text !== undefined) await navigator.clipboard.writeText(text).catch(() => {});
  }
}
