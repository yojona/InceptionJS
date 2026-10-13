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
// whether the page may receive the host's clipboard on paste.
// Returns a function that removes every listener it added.
export function attachInput(element, canvas, textInput, send, { clipboard = true } = {}) {
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
