#pragma once

#include <wtf/text/WTFString.h>

namespace WebCore {
class DOMWrapperWorld;
class LocalFrame;
}

namespace Inception::GuestWasm {

// WebAssembly for guest pages. The engine's JavaScript runs on the C loop
// interpreter, which has no WebAssembly tier, so guest modules are translated
// to JavaScript (by the host, with wasm2js) and run as ordinary script in the
// guest's own realm. The guest-side WebAssembly API is a script the host
// supplies (host/guest-wasm.js); this module installs it in every window.
void setPolyfill(String&&);
void installInWindow(WebCore::LocalFrame&, WebCore::DOMWrapperWorld&);

} // namespace Inception::GuestWasm
