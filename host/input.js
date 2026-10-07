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
// composed text arrives through composition and input events.
export function attachInput(element, canvas, textInput, send) {
  const position = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const focusInput = () => textInput.focus({ preventScroll: true });
  element.focusInput = focusInput;
  element.addEventListener('focus', focusInput);

  let pressedButton = null;
  canvas.addEventListener('mousedown', (event) => {
    event.preventDefault();
    focusInput();
    pressedButton = event.button;
    send('mouse', { type: 'down', ...position(event), button: event.button, clickCount: event.detail || 1, modifiers: modifiersOf(event) });
  });
  // Releases and drags are followed outside the canvas too, like a native view.
  window.addEventListener('mouseup', (event) => {
    if (pressedButton === null) return;
    pressedButton = null;
    send('mouse', { type: 'up', ...position(event), button: event.button, clickCount: event.detail || 1, modifiers: modifiersOf(event) });
  });
  window.addEventListener('mousemove', (event) => {
    // Listeners on window see the shadow host as the target; the composed
    // path says whether the pointer is over the canvas.
    if (pressedButton === null && !event.composedPath().includes(canvas)) return;
    send('mouse', { type: 'move', ...position(event), button: pressedButton ?? 0, pressed: pressedButton !== null, modifiers: modifiersOf(event) });
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    send('wheel', { ...position(event), deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, modifiers: modifiersOf(event) });
  }, { passive: false });

  // While composing, keys belong to the input method; a dead key starts a
  // composition of its own.
  let composing = false;
  const composingKey = (event) => composing || event.isComposing || event.key === 'Dead' || event.keyCode === 229;
  textInput.addEventListener('keydown', (event) => {
    if (belongsToHost(event) || composingKey(event)) return;
    event.preventDefault();
    const text = event.key.length === 1 || [...event.key].length === 1 ? event.key : event.key === 'Enter' ? '\r' : '';
    send('key', { type: 'down', key: event.key, code: event.code, keyCode: event.keyCode, text, repeat: event.repeat, modifiers: modifiersOf(event) });
  });
  textInput.addEventListener('keyup', (event) => {
    if (belongsToHost(event) || composingKey(event)) return;
    event.preventDefault();
    send('key', { type: 'up', key: event.key, code: event.code, keyCode: event.keyCode, text: '', repeat: false, modifiers: modifiersOf(event) });
  });

  textInput.addEventListener('compositionstart', () => {
    composing = true;
  });
  textInput.addEventListener('compositionupdate', (event) => {
    send('ime.set', { text: event.data, selectionStart: event.data.length, selectionEnd: event.data.length });
  });
  textInput.addEventListener('compositionend', (event) => {
    composing = false;
    send('ime.commit', { text: event.data });
    textInput.value = '';
  });
  // Text that came without keys being forwarded: the emoji picker, dictation,
  // autocorrect.
  textInput.addEventListener('input', (event) => {
    if (composing || event.isComposing) return;
    if (event.data) send('ime.commit', { text: event.data });
    textInput.value = '';
  });
  // Clipboard shortcuts reach the textarea as events; the engine handles
  // them from the key events it already received.
  for (const type of ['cut', 'copy', 'paste']) textInput.addEventListener(type, (event) => event.preventDefault());

  textInput.addEventListener('focus', () => send('focus', { focused: true }));
  textInput.addEventListener('blur', () => {
    if (composing) {
      composing = false;
      send('ime.cancel', {});
    }
    send('focus', { focused: false });
  });
}
