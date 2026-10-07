// What keeps a view from passing for the person's own browser. Drawn by the
// host above the canvas, so the page inside can neither cover nor detect it.
//
// - A small badge in a corner: "InceptionJS en <site>", where <site> is the
//   page embedding the view, not the page loaded inside it.
// - A notice while the page inside shows a password or payment field, or a
//   major sign-in page: the moment a phishing page would do its harm.
//
// Embedders style the badge through ::part(provenance) and the
// provenance-corner attribute (top-left, top-right, bottom-left,
// bottom-right). Hiding it takes a key our service verifies; until that
// service exists it is always shown.

const SIGN_IN_HOSTS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'idmsa.apple.com',
];

const spanish = () => (navigator.language || '').toLowerCase().startsWith('es');

const text = {
  badge: (site) => (spanish() ? `InceptionJS en ${site}` : `InceptionJS on ${site}`),
  password: (site) => (spanish()
    ? `Esta página se muestra dentro de ${site}, no en tu navegador. Verifica antes de escribir tu contraseña.`
    : `This page is shown inside ${site}, not in your browser. Check before you type your password.`),
  payment: (site) => (spanish()
    ? `Esta página se muestra dentro de ${site}, no en tu navegador. Verifica antes de escribir los datos de tu tarjeta.`
    : `This page is shown inside ${site}, not in your browser. Check before you type your card details.`),
};

export const PROVENANCE_STYLE = `
  .provenance { position: absolute; z-index: 2; pointer-events: none; font: 500 11px/1.4 system-ui, sans-serif;
    color: #fff; background: rgb(20 20 28 / 0.72); padding: 3px 8px; border-radius: 6px; margin: 6px; white-space: nowrap; }
  .provenance.top-left { top: 0; left: 0; } .provenance.top-right { top: 0; right: 0; }
  .provenance.bottom-left { bottom: 0; left: 0; } .provenance.bottom-right { bottom: 0; right: 0; }
  .notice { position: absolute; z-index: 3; left: 0; right: 0; top: 0; pointer-events: none; display: none;
    font: 500 13px/1.45 system-ui, sans-serif; color: #1d1600; background: #ffd75e; padding: 10px 14px;
    box-shadow: 0 1px 6px rgb(0 0 0 / 0.25); }
  .notice.shown { display: block; }
`;

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

export class Provenance {
  #badge;
  #notice;
  #field = '';
  #signIn = false;
  #site = location.hostname || location.host || 'this page';

  constructor(shadow, host) {
    this.#badge = document.createElement('div');
    this.#badge.className = 'provenance';
    this.#badge.setAttribute('part', 'provenance');
    this.#badge.textContent = text.badge(this.#site);
    this.#notice = document.createElement('div');
    this.#notice.className = 'notice';
    this.#notice.setAttribute('part', 'provenance-notice');
    this.#notice.setAttribute('role', 'alert');
    shadow.append(this.#badge, this.#notice);
    this.setCorner(host.getAttribute('provenance-corner'));
  }

  setCorner(corner) {
    this.#badge.classList.remove(...CORNERS);
    this.#badge.classList.add(CORNERS.includes(corner) ? corner : 'bottom-right');
  }

  // The engine's "field.focus": {kind: "password" | "payment" | ""}.
  fieldFocused(kind) {
    this.#field = kind;
    this.#update();
  }

  // The main frame's URL after each navigation.
  navigated(url) {
    try {
      this.#signIn = SIGN_IN_HOSTS.includes(new URL(url).hostname);
    } catch {
      this.#signIn = false;
    }
    this.#update();
  }

  #update() {
    const kind = this.#field === 'payment' ? 'payment' : this.#field === 'password' || this.#signIn ? 'password' : '';
    this.#notice.textContent = kind ? text[kind](this.#site) : '';
    this.#notice.classList.toggle('shown', !!kind);
  }
}
