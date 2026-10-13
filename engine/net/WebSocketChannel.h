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

// A content engine's page WebSockets run in its profile service: the content
// side forwards them, the service side carries them over its streams.
void installRemoteWebSockets();
void installServiceWebSockets();

} // namespace Inception
