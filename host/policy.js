// What a page may do to the person's browser, decided by the embedder with
// Inception.configure({ policy }). Every default is the safe one: a public
// embedder that configures nothing hands pages no way to write files, open
// windows, raise browser dialogs or reach the clipboard on their own. Values
// outside the lists fall back to the default.
//
//   downloads        'events' (default): the view reports the download and
//                    hands the embedder the finished Blob, but saves nothing.
//                    'save': also save it to the person's disk, as a browser
//                    does. 'block': cancel downloads as they start.
//   gesturelessDownloads
//                    'block' (default): a download the page starts without the
//                    person's input (a script clicking a link, a redirect after
//                    a timer) is cancelled and reported as downloadblocked with
//                    reason 'no-gesture'. 'allow': it proceeds under `downloads`.
//                    Downloads the embedder asks for with view.download() count
//                    as the person's.
//   maxDownloadBytes largest download kept in memory (default 256 MiB); a bigger
//                    one is cancelled, since a page could otherwise fill it.
//   newTabs          'block' (default): a window or tab a page opens is closed
//                    and reported as "popupblocked"; the embedder may accept one
//                    from the "newtab" event. 'foreground' / 'background' accept
//                    all that follow a user gesture.
//   popups           'tab' (default): what a page opens is a new tab of its
//                    window. 'window': a new window ("windowopen"), which the
//                    newTabs rule then accepts or closes the same way.
//   dialogs          'dismiss' (default): alert, confirm, prompt and
//                    beforeunload are answered without showing anything
//                    (alert returns, confirm false, prompt null, leaving is
//                    allowed); "dialog" lets the embedder draw its own. 'native'
//                    uses the browser's own dialogs.
//   clipboard        'user' (default): the page receives the clipboard only when
//                    the person pastes, and the system clipboard is written only
//                    soon after the person's own input. true: copy requests
//                    from the page are always honoured. false: neither way.
//   autoplaySound    the embedder knows playback with sound is allowed.
//   hosts            {allow?: [host], block?: [host]}: where pages may go (a host
//                    matches itself and its subdomains; block wins; without
//                    allow, every host not blocked). Enforced by the profile
//                    service, so with isolation 'window' or 'site' only.
//   thirdPartyCookies
//                    isolation 'site' only. 'block' (default): a request to a
//                    site other than the window's page carries none of the
//                    profile's cookies, sets none, and another site's frame gets
//                    no cookies, localStorage or IndexedDB of the profile (its
//                    localStorage lives as long as the window). The profile
//                    service enforces it, so a subverted engine cannot read
//                    another site's data either. 'allow': other sites' frames
//                    and requests have their cookies and storage, as the other
//                    isolations do, which hands a subverted engine those
//                    sites' data too.

export const POLICY_DEFAULTS = Object.freeze({
  downloads: 'events',
  gesturelessDownloads: 'block',
  maxDownloadBytes: 256 * 1024 * 1024,
  newTabs: 'block',
  popups: 'tab',
  dialogs: 'dismiss',
  clipboard: 'user',
  autoplaySound: false,
  hosts: null,
  thirdPartyCookies: 'block',
});

// A window's own host rules within the view's (policy.hosts): a window can be
// given less than the policy allows, never more. Block lists add up; allow
// lists keep the hosts both reach (a host matches itself and its subdomains).
export function narrowHostRules(base, extra) {
  if (!extra) return base ?? null;
  if (!base) return extra;
  const within = (host, pattern) => host === pattern || host.endsWith(`.${pattern}`);
  const block = [...new Set([...base.block, ...extra.block])];
  let allow = extra.allow ?? base.allow;
  if (extra.allow && base.allow) {
    allow = [];
    for (const a of extra.allow) {
      for (const b of base.allow) {
        if (within(a, b)) allow.push(a);
        else if (within(b, a)) allow.push(b);
      }
    }
    allow = [...new Set(allow)];
  }
  return { ...(allow ? { allow } : {}), block };
}

// Whether two sets of host rules are the same (null: none).
export function sameHostRules(a, b) {
  const key = (rules) => (rules ? JSON.stringify({ allow: rules.allow ? [...rules.allow].sort() : null, block: [...rules.block].sort() }) : null);
  return key(a) === key(b);
}

// A host list as the engine takes it: lowercase names, nothing else.
export function hostRules(value) {
  if (!value || typeof value !== 'object') return null;
  const list = (hosts) => (Array.isArray(hosts) ? hosts.filter((host) => typeof host === 'string' && /^[a-z0-9.-]{1,253}$/i.test(host)).map((host) => host.toLowerCase()) : undefined);
  const allow = list(value.allow);
  const block = list(value.block) ?? [];
  return { ...(allow ? { allow } : {}), block };
}

const CHOICES = {
  downloads: ['events', 'save', 'block'],
  gesturelessDownloads: ['block', 'allow'],
  newTabs: ['block', 'foreground', 'background'],
  popups: ['tab', 'window'],
  dialogs: ['dismiss', 'native'],
  clipboard: ['user', true, false],
  thirdPartyCookies: ['block', 'allow'],
};

/** The effective policy for the configured one: defaults filled in, invalid values replaced. */
export function resolvePolicy(configured) {
  const policy = { ...POLICY_DEFAULTS };
  for (const [name, value] of Object.entries(configured ?? {})) {
    if (!(name in POLICY_DEFAULTS)) continue;
    if (name === 'hosts') {
      policy.hosts = hostRules(value);
      continue;
    }
    if (CHOICES[name] ? CHOICES[name].includes(value) : typeof value === typeof POLICY_DEFAULTS[name]) policy[name] = value;
  }
  return policy;
}
