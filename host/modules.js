// Page capabilities the embedder decides on (architecture: Modules). For each
// kind, `modules[kind]` is:
//   undefined          ask: the view dispatches a cancelable "permissionrequest"
//                      event ({kind, origin, grant(), deny()}); unanswered is
//                      a denial, as when a person dismisses a prompt
//   false              denied
//   true | 'host'      granted, served by the host browser's own API
//   {provider, permission}
//                      provider: 'host' or an object (below); permission:
//                      'grant' | 'deny' | 'ask' | (origin) => boolean | Promise
//
// Providers: geolocation {watch(onPosition, onError, {highAccuracy}) -> stop},
// notifications {show(notification, {click, close}) -> {close}}.

const hostGeolocation = {
  watch(onPosition, onError, { highAccuracy }) {
    if (!navigator.geolocation) {
      onError({ denied: false, message: 'Geolocation is unavailable' });
      return () => {};
    }
    const id = navigator.geolocation.watchPosition(
      ({ coords, timestamp }) => onPosition({
        latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy,
        altitude: coords.altitude ?? undefined, altitudeAccuracy: coords.altitudeAccuracy ?? undefined,
        heading: Number.isFinite(coords.heading) ? coords.heading : undefined, speed: coords.speed ?? undefined,
        timestamp,
      }),
      (error) => onError({ denied: error.code === error.PERMISSION_DENIED, message: error.message }),
      { enableHighAccuracy: highAccuracy },
    );
    return () => navigator.geolocation.clearWatch(id);
  },
};

// The host browser would fetch a page's icon URL itself, outside the relay,
// telling the page's server the person's real address. Only inline images pass.
export function safeNotificationIcon(icon) {
  return typeof icon === 'string' && /^data:image\/(png|jpeg|gif|webp);/i.test(icon) ? icon : undefined;
}

const hostNotifications = {
  show({ title, body, icon, tag }, { click, close }) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      close();
      return { close() {} };
    }
    const shown = new Notification(title, { body, icon: safeNotificationIcon(icon), tag: tag || undefined });
    shown.onclick = click;
    shown.onclose = close;
    return { close: () => shown.close() };
  },
};

const HOST_PROVIDERS = { geolocation: hostGeolocation, notifications: hostNotifications };

function normalize(kind, setting) {
  if (setting === undefined || setting === null) return { permission: 'ask', provider: HOST_PROVIDERS[kind] };
  if (setting === false) return { permission: 'deny', provider: null };
  if (setting === true || setting === 'host') return { permission: 'grant', provider: HOST_PROVIDERS[kind] };
  const provider = !setting.provider || setting.provider === 'host' ? HOST_PROVIDERS[kind] : setting.provider;
  return { permission: setting.permission ?? 'grant', provider };
}

export class Modules {
  #view;
  #send;
  #settings;
  #stopGeolocation = null;
  #notifications = new Map();

  constructor(view, send, settings = {}) {
    this.#view = view;
    this.#send = send;
    this.#settings = settings;
  }

  #config(kind) {
    return normalize(kind, this.#settings[kind]);
  }

  handleEvent(name, data) {
    if (name === 'permission.request') return this.#request(data);
    if (name === 'geolocation.start') return this.#startGeolocation(data);
    if (name === 'geolocation.stop') return this.#stopWatching();
    if (name === 'notification.show') return this.#showNotification(data);
    if (name === 'notification.close') return this.#notifications.get(data.id)?.close();
  }

  async #request({ id, kind, origin }) {
    const reply = (granted) => this.#send('permission.reply', { id, granted: !!granted });
    const { permission, provider } = this.#config(kind);
    if (!provider || permission === 'deny') return reply(false);
    if (permission === 'grant') return reply(await this.#hostAllows(kind));
    if (typeof permission === 'function') {
      try {
        return reply(await permission(origin) && await this.#hostAllows(kind));
      } catch {
        return reply(false);
      }
    }
    // Ask: the embedder's own UI answers, or nobody does.
    let answered = false;
    const answer = async (granted) => {
      if (answered) return;
      answered = true;
      reply(granted && await this.#hostAllows(kind));
    };
    const event = new CustomEvent('permissionrequest', { cancelable: true, detail: { kind, origin, grant: () => answer(true), deny: () => answer(false) } });
    this.#view.dispatchEvent(event);
    if (!event.defaultPrevented) answer(false);
  }

  // A host provider can only give what the host page itself has been given.
  async #hostAllows(kind) {
    const { provider } = this.#config(kind);
    if (provider !== HOST_PROVIDERS[kind]) return true;
    if (kind === 'notifications') {
      if (typeof Notification === 'undefined') return false;
      if (Notification.permission === 'default') await Notification.requestPermission().catch(() => {});
      return Notification.permission === 'granted';
    }
    return true;
  }

  #startGeolocation({ highAccuracy }) {
    this.#stopWatching();
    const { provider } = this.#config('geolocation');
    if (!provider) return this.#send('geolocation.error', { denied: true, message: 'Geolocation is disabled' });
    this.#stopGeolocation = provider.watch(
      // WebCore keeps timestamps in seconds.
      (position) => this.#send('geolocation.position', { ...position, timestamp: (position.timestamp ?? Date.now()) / 1000 }),
      (error) => this.#send('geolocation.error', error),
      { highAccuracy },
    );
  }

  #stopWatching() {
    this.#stopGeolocation?.();
    this.#stopGeolocation = null;
  }

  #showNotification(notification) {
    const { provider } = this.#config('notifications');
    if (!provider) return;
    const { id } = notification;
    const shown = provider.show(notification, {
      click: () => this.#send('notification.click', { id }),
      close: () => {
        this.#notifications.delete(id);
        this.#send('notification.closed', { id });
      },
    });
    if (shown) this.#notifications.set(id, shown);
  }
}
