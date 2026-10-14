<p align="center">
  <img src="https://raw.githubusercontent.com/yojona/InceptionJS/main/.github/assets/logo.svg" alt="InceptionJS" width="310">
</p>

<h3 align="center">The world's first truly usable browser inside a browser. For real.</h3>

<p align="center">
  Not an iframe. Not a screenshot. Not a remote stream. Not a cloud browser.<br>
  A full web engine, compiled for the web.
</p>

InceptionJS is a web browser engine (WebKit compiled to WebAssembly) that runs inside a
web page and draws into a canvas. Your app embeds a real browser with
`<inception-view>`; rendering, JavaScript and media run on the visitor's device, and
network traffic leaves through a small WebSocket relay that you run or host.

**Early release (0.x).** APIs and the protocol can still change. Read the limitations
in the [repository](https://github.com/yojona/InceptionJS#limitations) before you build
on it.

```bash
npm install inceptionjs
```

```html
<inception-view id="v" src="https://example.com"></inception-view>
<script type="module">
  import { Inception } from 'inceptionjs';
  Inception.configure({
    engineUrl: '/engine/inception-engine.js',
    relayUrl: 'wss://relay.example.com/?token=...',
  });
</script>
```

This package contains the host library, the relay (`inceptionjs/server`), the Vite
plugin (`inceptionjs/vite`), the Next.js adapter (`inceptionjs/next`) and the CLI
(`npx inceptionjs`). The engine files are not included; see the
[repository](https://github.com/yojona/InceptionJS) for how to get or build them.
For React, use [`@inceptionjs/react`](https://www.npmjs.com/package/@inceptionjs/react).

- Documentation, compatibility and quick start: https://github.com/yojona/InceptionJS
- Website: https://inceptionjs.com
- License: Apache-2.0. The engine files contain WebKit (LGPL); see LGPL.md in the repository.
