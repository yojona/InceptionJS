# Changelog

Notable changes to the `inceptionjs` package and the engine files of each release.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/) (0.x: minor versions may
break the API).

## Unreleased

### Added

- Touch and pen input: a tap clicks, two quick taps double-click, one finger scrolls
  with momentum, two fingers pinch-zoom and a long press opens the context menu. The
  host page does not scroll or zoom under the view. Tapping a text field does not
  open the on-screen keyboard yet, and pages see mouse and wheel events, not touch
  events (#28).

## 0.1.4 (2026-11-05)

The engine files are the same as 0.1.3's. `@inceptionjs/react` is 0.1.1.

### Security

- A window created over the protocol can no longer replace or lift `policy.hosts`.
  Its own host rules only narrow the view's, and they are kept when the engine
  budget is spent (#11, #12).
- Media source fetches are capped by `policy.maxMediaBytes`, 512 MiB by default (#10).

### Added

- `maxMemoryMB: 'auto'` sizes engine memory from the device's memory (#29).
- `Inception.preload()` starts the engine download before any view exists. The Vite
  plugin serves precompressed `.br`/`.gz` engine files, and `inceptionjs check` reports
  compression and caching (#22).
- MP3 and AAC sources play as they download when their size is unknown (a live
  stream) or larger than `policy.maxMediaBytes` (#56).
- Relay: `GET /healthz`, an opt-in Prometheus `/metrics` and `stats()` (#34).
- Relay: `close({ graceMs })` drains. New sessions get 503 and `/healthz` reports
  `draining` while open sessions finish. The CLI has `--log json` and
  `--drain-seconds` (#34).
- `@inceptionjs/react`: a prop for every attribute and event of the view, and
  `agent`, `securityState` and `close()` on the handle (#19).
- Typings for `edit()`, `pauseDownload()`, `resumeDownload()` and the rest of the
  runtime API that was missing (#20).
- Tests and README notes for WebAssembly in pages, which runs through wasm2js (#35).

### Changed

- The provenance badge counts as hidden when the page makes it unreadable (low contrast
  or transparent text) or covers it with an opaque element for 3 seconds or more (#25).
- The Vite plugin ships only the binaryen files the host loads (#18).

### Fixed

- A bridge version mismatch fails the view instead of hanging `view.ready` (#16).
- A view whose engine fails to start releases its profile and attach-host locks
  (#14).
- An `<inception-window>` changed several times in one task attaches once (#15).
- Protocol requests fail instead of hanging when the engine crashes, the window
  closes or the attach host goes away (#13).
- `@inceptionjs/react` no longer undoes an earlier `Inception.configure()` with
  undefined `policy` or `modules` (#19).

## 0.1.3 (2026-10-23)

### Security

- The profile service checks what content engines send it more strictly: decoded
  messages, IndexedDB blob files and database connections. This is defense in depth for
  site isolation (#17). Advisories:
  [GHSA-c63g-m834-f5cc](https://github.com/yojona/InceptionJS/security/advisories/GHSA-c63g-m834-f5cc),
  [GHSA-h7ph-7j3m-4cgc](https://github.com/yojona/InceptionJS/security/advisories/GHSA-h7ph-7j3m-4cgc),
  [GHSA-6x6v-rpr2-6536](https://github.com/yojona/InceptionJS/security/advisories/GHSA-6x6v-rpr2-6536).

### Changed

- The README and the example browser show a page's address when it has no title.

## 0.1.2 (2026-10-23)

### Security

- Relay: a token issued for an origin is refused without an `Origin` header (#7).
- Relay: a secret shorter than 32 characters stops the relay at startup (#8).
- Relay: a stream's flow-control window is granted only once its connection opens,
  and a stream that queues more than 1 MiB before then is closed (#9).
- Agent: `type`, `fill` and `press` on a target that is not an editable field are
  weighed as a click, and a character pressed into a password or card field needs
  approval (#5).

### Added

- `view.close()` and `view.closed`. Removing a view from the page stops its engines and
  frees its profile (#4).
- `downloadstart` reports `initiator`: `'person'`, `'agent'` or `'page'` (#1).

### Fixed

- `<a download>` downloads instead of navigating, and link downloads carry the person's
  gesture (#1).
- `window.open()` without a user gesture is reported as `popupblocked` (#2).
- A page without a `<title>` reports `''` instead of the previous page's title (#3).
- Engines starting at the same time no longer leave the page's `Worker` replaced (#6).

## 0.1.1 (2026-10-14)

### Fixed

- Bundlers (Vite) shipped the host without two of its files.
- A view created by React could fail to start.

## 0.1.0 (2026-10-14)

First public release.
