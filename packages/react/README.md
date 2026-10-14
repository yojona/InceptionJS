# @inceptionjs/react

React component for [InceptionJS](https://github.com/yojona/InceptionJS): a real web
browser engine (WebKit compiled to WebAssembly) that runs inside your app and draws
into a canvas.

```bash
npm install inceptionjs @inceptionjs/react
```

```jsx
import { InceptionView } from '@inceptionjs/react';

export function Browser() {
  return (
    <InceptionView
      src="https://example.com"
      engineUrl="/engine/inception-engine.js"
      relayUrl="wss://relay.example.com/?token=..."
      onTitle={(e) => console.log(e.detail.title)}
    />
  );
}
```

The engine files and a relay are required; see the
[repository](https://github.com/yojona/InceptionJS) for setup, compatibility and
limitations. Early release (0.x). License: Apache-2.0.
