// Tabs: several pages in one engine, one of them shown. The engine reports
// each page's events with its tab id; the view keeps a record per tab and
// re-dispatches:
//   tabcreated   {tab, opener?}
//   tabupdated   {tab, url?, title?, loading?, canGoBack?, canGoForward?,
//                 audible?, icons?}
//   tabactivated {tab}
//   tabclosed    {tab}
//   newtab       {tab, opener, url, userGesture, allow(mode?)}: a page opened
//                a tab (window.open, target=_blank). preventDefault() closes
//                it; allow('foreground' | 'background') accepts it. Otherwise
//                policy.newTabs decides: by default it is closed, and
//                'foreground' or 'background' accept the ones that follow a
//                user gesture.
//   popupblocked {tab, opener, url, userGesture}: a tab was closed instead of
//                shown, so the embedder can tell the person.
export class Tabs {
  #view;
  #send;
  #policy;
  #tabs = new Map();
  #active = 0;

  constructor(view, send, policy) {
    this.#view = view;
    this.#send = send;
    this.#policy = policy;
  }

  get active() { return this.#active; }

  list() {
    return [...this.#tabs.values()].map((tab) => ({ ...tab, active: tab.id === this.#active }));
  }

  get(id) { return this.#tabs.get(id); }

  // The tab the engine started with.
  started(id) {
    this.#add(id, {});
    this.#active = id;
  }

  // The window moved to another engine (isolation 'site'): its tab there takes
  // the place of this one, which is reported closed.
  replace(oldId, newId) {
    if (oldId === newId) return;
    const previous = this.#tabs.get(oldId);
    const tab = this.#tabs.get(newId) ?? this.#add(newId, {});
    if (previous) this.#update(tab, { url: previous.url, title: previous.title });
    this.#active = newId;
    this.#view.dispatchEvent(new CustomEvent('tabactivated', { detail: { tab: newId } }));
    if (previous) {
      this.#tabs.delete(oldId);
      this.#view.dispatchEvent(new CustomEvent('tabclosed', { detail: { tab: oldId } }));
    }
  }

  create(url = '', { activate = true } = {}) {
    this.#send('tab.create', { url, activate });
  }

  activate(id) { this.#send('tab.activate', { tab: id }); }
  close(id) { this.#send('tab.close', { tab: id }); }

  // A page event ("navigate", "title", "loading", "navigation.state") for some
  // tab. Returns whether it belongs to the shown tab, so the view also reports
  // it as its own.
  track(name, data) {
    const id = data?.tab ?? this.#active;
    const tab = this.#tabs.get(id);
    if (tab) {
      const changes = {};
      if (name === 'navigate') changes.url = data.url;
      if (name === 'title') changes.title = data.title;
      if (name === 'loading') changes.loading = data.loading;
      if (name === 'navigation.state') Object.assign(changes, { canGoBack: data.canGoBack, canGoForward: data.canGoForward });
      if (Object.keys(changes).length) this.#update(tab, changes);
    }
    return id === this.#active;
  }

  handleEvent(name, data) {
    const id = data.tab;
    if (name === 'tab.created') {
      this.#add(id, data.opener ? { opener: data.opener } : {});
    } else if (name === 'tab.opened') {
      const tab = this.#tabs.get(id) ?? this.#add(id, {});
      tab.opener = data.opener;
      if (data.url) this.#update(tab, { url: data.url });
      const detail = { tab: id, opener: data.opener, url: data.url ?? '', userGesture: !!data.userGesture };
      let accepted = null;
      const allow = (mode = 'foreground') => {
        accepted = mode === 'background' ? 'background' : 'foreground';
      };
      const event = new CustomEvent('newtab', { detail: { ...detail, allow }, cancelable: true });
      this.#view.dispatchEvent(event);
      const configured = this.#policy().newTabs;
      const mode = event.defaultPrevented ? 'block' : accepted ?? (detail.userGesture ? configured : 'block');
      if (mode === 'block') {
        this.close(id);
        if (!event.defaultPrevented) this.#view.dispatchEvent(new CustomEvent('popupblocked', { detail }));
      } else if (mode === 'foreground') {
        this.activate(id);
      }
    } else if (name === 'tab.focus') {
      // window.focus() from a hidden tab: only a gesture the person made may
      // switch tabs, so the embedder decides.
      this.#view.dispatchEvent(new CustomEvent('tabfocusrequest', { detail: { tab: id } }));
    } else if (name === 'tab.activated') {
      this.#active = id;
      this.#view.dispatchEvent(new CustomEvent('tabactivated', { detail: { tab: id } }));
    } else if (name === 'tab.closed') {
      this.#tabs.delete(id);
      this.#view.dispatchEvent(new CustomEvent('tabclosed', { detail: { tab: id } }));
    } else if (name === 'tab.audible') {
      const tab = this.#tabs.get(id);
      if (tab) this.#update(tab, { audible: data.audible });
    } else if (name === 'tab.icons') {
      const tab = this.#tabs.get(id);
      if (tab) this.#update(tab, { icons: data.icons });
    }
  }

  #add(id, extra) {
    const tab = { id, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, audible: false, icons: [], ...extra };
    this.#tabs.set(id, tab);
    this.#view.dispatchEvent(new CustomEvent('tabcreated', { detail: { tab: id, ...(extra.opener ? { opener: extra.opener } : {}) } }));
    return tab;
  }

  #update(tab, changes) {
    Object.assign(tab, changes);
    this.#view.dispatchEvent(new CustomEvent('tabupdated', { detail: { tab: tab.id, ...changes } }));
  }
}
