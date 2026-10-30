// What keeps a view from passing for the person's own browser. Drawn by the
// host above the canvas, so the page inside can neither cover nor detect it.
//
// - A small badge in a corner: "InceptionJS on <site>", where <site> is the
//   page embedding the view, not the page loaded inside it.
// - A notice while the page inside shows a password or payment field, or a
//   major sign-in page: the moment a phishing page would do its harm.
//
// Embedders style the badge through ::part(provenance) and the
// provenance-corner attribute (top-left, top-right, bottom-left,
// bottom-right). A first-party embedder, one whose own window chrome already
// says what the view is (an operating system's browser app, say), turns both
// off with provenance="off"; it is on by default.
//
// Styling is not hiding. While the badge is on, the host checks once a second
// that it can be seen (not display:none, not transparent, not collapsed, not
// outside the view); if the embedding page has hidden it, the view covers the
// page with a message until the style is removed, and reports "provenancetampered".

const SIGN_IN_HOSTS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'idmsa.apple.com',
];

// English, as everything this library shows; localized text will follow the
// view's languages preference.
const text = {
  badge: (site) => `InceptionJS on ${site}`,
  password: (site) => `This page is shown inside ${site}, not in your browser. Check before you type your password.`,
  payment: (site) => `This page is shown inside ${site}, not in your browser. Check before you type your card details.`,
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

// "rgb(r g b / a)" or "rgba(r, g, b, a)" as [r, g, b, a]; null for anything else.
function parseColor(value) {
  const parts = String(value).match(/[\d.]+%?/g);
  if (!/^rgba?\(/.test(String(value)) || !parts || parts.length < 3) return null;
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  return [Number(parts[0]), Number(parts[1]), Number(parts[2]), alpha];
}

// WCAG contrast ratio between two opaque colours.
function contrast(a, b) {
  const luminance = ([r, g, b]) => {
    const channel = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

// How long something of the page may lie over the badge before it counts as
// hiding it: a menu or a dialog passing over the corner does not.
const COVERED_FOR_MS = 3000;

export class Provenance {
  #badge;
  #notice;
  #field = '';
  #fieldOrigin = '';
  #url = '';
  #reported = '';
  #handled = false;
  #signIn = false;
  #enabled = true;
  #site = location.hostname || location.host || 'this page';
  #host;
  #timer = null;
  #hidden = false;
  #coveredSince = 0;

  // `onHidden(hidden)` is told when the badge becomes unseeable or seeable again.
  constructor(shadow, host, onHidden = () => {}) {
    this.#host = host;
    this.onHidden = onHidden;
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
    this.setEnabled(host.getAttribute('provenance') !== 'off');
  }

  // The provenance attribute: "off" hides the badge and the notice.
  setEnabled(enabled) {
    this.#enabled = enabled;
    this.#badge.hidden = !enabled;
    this.#update();
    this.verify();
  }

  // Watching starts when the view is attached and stops when it is removed.
  start() {
    this.verify();
    this.#timer ??= setInterval(() => this.verify(), 1000);
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
  }

  // Whether the badge can be seen by the person right now.
  get visible() {
    if (!this.#enabled) return true;
    const style = getComputedStyle(this.#badge);
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) < 0.5) return false;
    if (style.clipPath !== 'none' || style.filter !== 'none') return false;
    // The text must stand out from the badge: a colour made transparent or
    // the same as the background hides it as well as display: none does.
    const color = parseColor(style.color);
    const background = parseColor(style.backgroundColor);
    if (color && color[3] < 0.5) return false;
    if (color && background && background[3] >= 0.5 && contrast(color, background) < 2) return false;
    const badge = this.#badge.getBoundingClientRect();
    const view = this.#host.getBoundingClientRect();
    if (!this.#host.isConnected || !view.width || !view.height) return true;
    if (badge.width < 24 || badge.height < 10) return false;
    const inside = Math.min(badge.right, view.right) - Math.max(badge.left, view.left) >= badge.width * 0.9
      && Math.min(badge.bottom, view.bottom) - Math.max(badge.top, view.top) >= badge.height * 0.9;
    if (!inside) return false;
    // Something of the page lying over the badge for a while hides it too.
    if (this.#covered(badge)) {
      this.#coveredSince ||= performance.now();
      if (performance.now() - this.#coveredSince >= COVERED_FOR_MS) return false;
    } else {
      this.#coveredSince = 0;
    }
    return true;
  }

  // Whether another element of the page (not another view or window) is the
  // topmost at most of the badge's points (its centre and corners, inset). Points outside the
  // viewport tell nothing. Elements with pointer-events: none are not seen
  // by hit testing, so an overlay can still pass unnoticed that way.
  #covered(badge) {
    const root = this.#host.getRootNode();
    if (typeof root.elementFromPoint !== 'function') return false;
    const inset = 3;
    const points = [
      [(badge.left + badge.right) / 2, (badge.top + badge.bottom) / 2],
      [badge.left + inset, badge.top + inset], [badge.right - inset, badge.top + inset],
      [badge.left + inset, badge.bottom - inset], [badge.right - inset, badge.bottom - inset],
    ].filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
    if (!points.length) return false;
    const coveredPoints = points.filter(([x, y]) => {
      const hit = root.elementFromPoint(x, y);
      if (!hit || hit === this.#host || this.#host.contains(hit)) return false;
      // Another view or window on top (overlapping windows of a desktop)
      // shows its own badge: that is not hiding this one.
      return !hit.closest('inception-view, inception-window');
    }).length;
    return coveredPoints * 2 > points.length;
  }

  verify() {
    // Only an attached view can be judged; before that (and in the element's
    // constructor) nothing is shown, and it must not gain attributes.
    if (!this.#host.isConnected) return;
    const hidden = !this.visible;
    if (hidden === this.#hidden) return;
    this.#hidden = hidden;
    this.onHidden(hidden);
  }

  setCorner(corner) {
    this.#badge.classList.remove(...CORNERS);
    this.#badge.classList.add(CORNERS.includes(corner) ? corner : 'bottom-right');
  }

  // The engine's "field.focus": {kind: "password" | "payment" | "", origin}.
  fieldFocused(kind, origin = '') {
    this.#field = kind;
    this.#fieldOrigin = typeof origin === 'string' ? origin : '';
    this.#update();
  }

  // The main frame's URL after each navigation.
  navigated(url) {
    this.#url = String(url ?? '');
    try {
      this.#signIn = SIGN_IN_HOSTS.includes(new URL(url).hostname);
    } catch {
      this.#signIn = false;
    }
    this.#update();
  }

  // "sensitivepage" is dispatched on the view when the page shows a password or
  // payment field or a known sign-in page, and again with kind "" when it stops:
  //   {kind: "password" | "payment" | "", reason: "field" | "signin-page", origin, url}
  // It is cancelable: preventDefault() means the embedder shows its own warning
  // and the built-in notice stays hidden. It fires whatever the provenance
  // attribute says.
  #update() {
    const kind = this.#field === 'payment' ? 'payment' : this.#field === 'password' || this.#signIn ? 'password' : '';
    const reason = this.#field ? 'field' : this.#signIn ? 'signin-page' : '';
    let origin = this.#fieldOrigin;
    if (!origin || !this.#field) {
      try {
        origin = new URL(this.#url).origin;
      } catch {
        origin = '';
      }
    }
    // Nothing to say while nothing is sensitive, and once when that ends.
    const key = kind ? `${kind}|${reason}|${origin}` : '';
    let handled = this.#handled;
    if (key !== this.#reported) {
      this.#reported = key;
      const event = new CustomEvent('sensitivepage', { cancelable: true, detail: { kind, reason, origin, url: this.#url } });
      this.#host.dispatchEvent(event);
      handled = this.#handled = event.defaultPrevented;
    }
    this.#notice.textContent = kind ? text[kind](this.#site) : '';
    this.#notice.classList.toggle('shown', !!kind && this.#enabled && !handled);
  }
}
