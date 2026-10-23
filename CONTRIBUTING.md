# Contributing

Thanks for helping. InceptionJS is pre-1.0, so please open an issue before a large
change.

## Ground rules

- **No copied code.** Contributions must be your own work, written from scratch or from
  public specifications. Do not paste, translate or closely paraphrase code from other
  browsers, engines, emulators or libraries, whatever their license, and do not submit
  code you cannot license to this project. Third-party code that we intentionally ship
  (WebKit, our build dependencies) comes in as pinned, documented dependencies or as
  reviewable patch files, never as unattributed snippets. If something looks impossible
  to write anew, open an issue and ask first.
- **English** for identifiers, comments, commit messages and everything user-visible.
  Comments only where the reason is not obvious.
- **Honest identity stays.** We will not merge changes that remove or weaken the UA
  token, `navigator.inception` or the provenance defaults, or that add fingerprint
  spoofing, captcha solving or detection evasion.
- **Engine-neutral API.** The public API, protocol and host never expose WebKit internal
  names or types.
- Be kind: see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Layout

```
host/                 browser host (ES modules): view element, protocol, input, media
packages/inceptionjs  npm package: assembles host/ plus server/, vite/, next/, bin
packages/react        @inceptionjs/react
engine/               C++ embedder (wasm)
patches/webkit/       the WebKit patch series
build/                pinned, scripted build of dependencies, WebKit and the engine
tests/                browser acceptance suite (Playwright)
examples/             basic, debug and a React + Vite app
```

## Running tests

```bash
npm install
npm run test:unit                # unit tests for the host modules (Node 20+)
npm run build:packages           # assemble packages/inceptionjs/dist
npm test -w inceptionjs          # relay, token and policy unit tests
npm run serve                    # dev server with isolation headers on 127.0.0.1:8085
npm test                         # browser acceptance suite (needs a browser and engine files)
```

The acceptance suite runs one browser at a time and expects the engine files in the
directory `tests/serve.mjs` reads (`ENGINE_DIR`, default `.work/out/engine`). Set
`BASE_URL` to test a deployment. Pick a browser with `--project=chrome|firefox|webkit`.
Verify behavior in a real browser; passing tests alone are not enough for a change to
rendering, input or media.

Pages load through a relay on `ws://127.0.0.1:5001/`; start a development one with
`node -e "import('./packages/inceptionjs/src/server/relay.js').then((m) => m.startRelay({ port: 5001 }))"`.

CI runs the unit tests, the package's tests and the type check on every push and pull
request (`.github/workflows/ci.yml`). The browser suite runs weekly and on demand
against the latest release's engine (`.github/workflows/e2e.yml`, Actions → E2E →
Run workflow).

## Building the engine

Building WebKit takes a large machine and hours. The scripts in `build/` pin every
toolchain, dependency and the WebKit commit; see [LGPL.md](LGPL.md) for the steps.
Do not build WebKit on a laptop.

WebKit changes live only as numbered patch files in `patches/webkit/`: small, by topic,
rebase-friendly. Batch C++ changes before triggering a build.

## Pull requests

- One logical change per commit, with a meaningful message. Add or update tests.
- Keep patches to WebKit small and explain why in the commit message.
- Security issues: do not open a PR or issue; see [SECURITY.md](SECURITY.md).

## Sign-off (DCO)

Every commit needs a `Signed-off-by:` line (`git commit -s`) certifying the
[Developer Certificate of Origin](https://developercertificate.org/): you wrote the
change or have the right to submit it under the project's license. Contributions are
licensed under the Apache License 2.0, except changes to files under `patches/webkit/`,
which keep the license of the WebKit file they modify. You keep your copyright; add
yourself to [AUTHORS](AUTHORS) in your first pull request.
