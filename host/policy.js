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

export const POLICY_DEFAULTS = Object.freeze({
  downloads: 'events',
  gesturelessDownloads: 'block',
  maxDownloadBytes: 256 * 1024 * 1024,
  newTabs: 'block',
  dialogs: 'dismiss',
  clipboard: 'user',
  autoplaySound: false,
});

const CHOICES = {
  downloads: ['events', 'save', 'block'],
  gesturelessDownloads: ['block', 'allow'],
  newTabs: ['block', 'foreground', 'background'],
  dialogs: ['dismiss', 'native'],
  clipboard: ['user', true, false],
};

/** The effective policy for the configured one: defaults filled in, invalid values replaced. */
export function resolvePolicy(configured) {
  const policy = { ...POLICY_DEFAULTS };
  for (const [name, value] of Object.entries(configured ?? {})) {
    if (!(name in POLICY_DEFAULTS)) continue;
    if (CHOICES[name] ? CHOICES[name].includes(value) : typeof value === typeof POLICY_DEFAULTS[name]) policy[name] = value;
  }
  return policy;
}
