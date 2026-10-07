// Native-looking pieces the engine asks the host to draw: the list of a
// <select>, dialogs and the file picker. Each is announced first as a
// cancelable event on the view, so an embedder can draw its own; the defaults
// here are used otherwise.

const MENU_STYLE = `
  .menu { position: absolute; z-index: 10; box-sizing: border-box; margin: 0; padding: 4px 0; overflow-y: auto;
    background: Canvas; color: CanvasText; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    border-radius: 6px; box-shadow: 0 6px 20px rgb(0 0 0 / 0.25); font: menu; list-style: none; outline: none; }
  .menu li { padding: 3px 12px; white-space: pre; cursor: default; }
  .menu li.group { font-weight: 600; opacity: 0.7; }
  .menu li.option.in-group { padding-left: 24px; }
  .menu li.separator { padding: 0; margin: 4px 0; border-top: 1px solid color-mix(in srgb, CanvasText 20%, transparent); }
  .menu li.disabled { opacity: 0.4; }
  .menu li.active { background: Highlight; color: HighlightText; }
`;

export class SelectMenu {
  #root;
  #send;
  #open = null;

  constructor(root, send) {
    this.#root = root;
    this.#send = send;
    const style = document.createElement('style');
    style.textContent = MENU_STYLE;
    root.append(style);
  }

  // {id, rect, items: [{kind, label, disabled, title}], selected, fontSize, rtl}
  show(host, menu) {
    this.close(-1);
    const event = new CustomEvent('selectmenu', {
      cancelable: true,
      detail: { ...menu, choose: (index) => this.#send('select.choose', { id: menu.id, index }) },
    });
    if (!host.dispatchEvent(event)) return;

    const list = document.createElement('ul');
    list.className = 'menu';
    list.tabIndex = -1;
    list.setAttribute('role', 'listbox');
    if (menu.rtl) list.dir = 'rtl';
    if (menu.fontSize) list.style.fontSize = `${menu.fontSize}px`;
    let inGroup = false;
    const rows = menu.items.map((item, index) => {
      const row = document.createElement('li');
      row.className = item.kind;
      if (item.kind === 'group') inGroup = true;
      if (item.kind === 'option' && inGroup) row.classList.add('in-group');
      if (item.disabled) row.classList.add('disabled');
      if (item.title) row.title = item.title;
      row.textContent = item.kind === 'separator' ? '' : item.label;
      row.dataset.index = index;
      list.append(row);
      return row;
    });
    const choosable = (index) => menu.items[index]?.kind === 'option' && !menu.items[index].disabled;

    const bounds = host.getBoundingClientRect();
    const { x, y, width, height } = menu.rect;
    list.style.minWidth = `${width}px`;
    list.style.left = `${x}px`;
    this.#root.append(list);
    const below = bounds.height - (y + height);
    const above = y;
    const needed = Math.min(list.scrollHeight, Math.max(below, above) - 8);
    list.style.maxHeight = `${needed}px`;
    list.style.top = list.scrollHeight <= below || below >= above ? `${y + height}px` : `${y - needed}px`;
    const overflow = x + list.offsetWidth - bounds.width;
    if (overflow > 0) list.style.left = `${Math.max(0, x - overflow)}px`;

    let active = -1;
    const activate = (index) => {
      rows[active]?.classList.remove('active');
      active = index;
      rows[active]?.classList.add('active');
      rows[active]?.scrollIntoView({ block: 'nearest' });
    };
    const step = (from, direction) => {
      for (let i = from + direction; i >= 0 && i < rows.length; i += direction)
        if (choosable(i)) return i;
      return from;
    };
    activate(choosable(menu.selected) ? menu.selected : step(-1, 1));

    let typed = '';
    let typedAt = 0;
    const keydown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'ArrowDown') activate(step(active, 1));
      else if (event.key === 'ArrowUp') activate(step(active, -1));
      else if (event.key === 'Home') activate(step(-1, 1));
      else if (event.key === 'End') activate(step(rows.length, -1));
      else if (event.key === 'PageDown') { for (let i = 0; i < 10; i++) activate(step(active, 1)); }
      else if (event.key === 'PageUp') { for (let i = 0; i < 10; i++) activate(step(active, -1)); }
      else if (event.key === 'Enter' || event.key === ' ' || event.key === 'Tab') this.close(choosable(active) ? active : -1);
      else if (event.key === 'Escape') this.close(-1);
      else if (event.key.length === 1) {
        const now = performance.now();
        typed = now - typedAt > 800 ? event.key : typed + event.key;
        typedAt = now;
        const match = menu.items.findIndex((item, index) => choosable(index) && item.label.trim().toLowerCase().startsWith(typed.toLowerCase()));
        if (match >= 0) activate(match);
      }
    };
    list.addEventListener('keydown', keydown);
    list.addEventListener('mousemove', (event) => {
      const index = Number(event.target.closest?.('li')?.dataset.index);
      if (choosable(index)) activate(index);
    });
    list.addEventListener('mouseup', (event) => {
      const index = Number(event.target.closest?.('li')?.dataset.index);
      if (choosable(index)) this.close(index);
    });
    list.addEventListener('mousedown', (event) => event.preventDefault());
    const outside = (event) => {
      if (!event.composedPath().includes(list)) this.close(-1);
    };
    // The press that opened the menu is still being delivered.
    setTimeout(() => document.addEventListener('mousedown', outside, true));
    const blur = () => this.close(-1);
    window.addEventListener('blur', blur);
    list.focus({ preventScroll: true });
    this.#open = { id: menu.id, rect: menu.rect, list, host, cleanup: () => {
      document.removeEventListener('mousedown', outside, true);
      window.removeEventListener('blur', blur);
    } };
  }

  // The page changed its options while the list was open.
  update(menu) {
    if (this.#open?.id !== menu.id) return;
    const { host, rect } = this.#open;
    this.#dismiss();
    this.show(host, { ...menu, rect });
  }

  // The engine closed it (the page removed the <select>, navigated...).
  hide(id) {
    if (this.#open?.id !== id) return;
    this.#dismiss();
  }

  close(index) {
    if (!this.#open) return;
    const { id, host } = this.#open;
    this.#dismiss();
    this.#send('select.choose', { id, index });
    host.focusInput?.();
  }

  #dismiss() {
    this.#open.cleanup();
    this.#open.list.remove();
    this.#open = null;
  }
}

// alert / confirm / prompt / beforeunload. The engine is blocked until this
// resolves; the reply is what the page's call returns.
export async function answerDialog(host, question) {
  let respond;
  const reply = new Promise((resolve) => (respond = resolve));
  const event = new CustomEvent('dialog', { cancelable: true, detail: { ...question, type: question.question, respond } });
  if (!host.dispatchEvent(event)) return reply;
  switch (question.question) {
  case 'alert':
    alert(question.message);
    return null;
  case 'confirm':
    return confirm(question.message);
  case 'prompt':
    return prompt(question.message, question.defaultValue ?? '');
  case 'beforeunload':
    return confirm('Leave this page? Changes you made may not be saved.');
  }
  return null;
}

// <input type=file>: the host's picker; chosen files are copied into the
// engine before "file.chosen".
export function chooseFiles(host, runtime, { multiple, accept, directory }) {
  const finish = async (files) => {
    for (const file of files ?? [])
      runtime.sendFile(file.name, await file.arrayBuffer());
    runtime.send('file.chosen', { cancelled: !files?.length });
  };
  const event = new CustomEvent('filechooser', { cancelable: true, detail: { multiple, accept, directory, choose: finish } });
  if (!host.dispatchEvent(event)) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = multiple;
  if (accept?.length) input.accept = accept.join(',');
  if (directory) input.webkitdirectory = true;
  input.addEventListener('change', () => finish([...input.files]), { once: true });
  input.addEventListener('cancel', () => finish([]), { once: true });
  input.click();
}
