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

export function attachInput(element, canvas, send) {
  const position = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  let pressedButton = null;
  canvas.addEventListener('mousedown', (event) => {
    event.preventDefault();
    element.focus({ preventScroll: true });
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
    if (pressedButton === null && event.target !== canvas) return;
    send('mouse', { type: 'move', ...position(event), button: pressedButton ?? 0, pressed: pressedButton !== null, modifiers: modifiersOf(event) });
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    send('wheel', { ...position(event), deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, modifiers: modifiersOf(event) });
  }, { passive: false });

  const key = (type) => (event) => {
    if (belongsToHost(event)) return;
    event.preventDefault();
    const text = type === 'down' && event.key.length === 1 ? event.key : type === 'down' && event.key === 'Enter' ? '\r' : '';
    send('key', { type, key: event.key, code: event.code, keyCode: event.keyCode, text, repeat: event.repeat, modifiers: modifiersOf(event) });
  };
  element.addEventListener('keydown', key('down'));
  element.addEventListener('keyup', key('up'));

  element.addEventListener('focus', () => send('focus', { focused: true }));
  element.addEventListener('blur', () => send('focus', { focused: false }));
}
