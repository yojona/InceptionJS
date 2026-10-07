#pragma once

#include <wtf/Ref.h>

namespace WebCore {
class SocketProvider;
}

namespace Inception {

// Page WebSockets over the engine's own network stack: a TCP stream through
// the relay, TLS inside the engine for wss:, and WebCore's handshake and
// framing on top.
Ref<WebCore::SocketProvider> createSocketProvider();

} // namespace Inception
