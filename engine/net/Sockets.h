#pragma once

#include <wtf/text/WTFString.h>

namespace Inception::Sockets {

// The engine's TCP: the socket system calls curl and OpenSSL make are served
// here, over streams multiplexed through one WebSocket to a Wisp relay that
// the engine worker opens itself. Everything is non-blocking; the network
// schedulers poll from the engine's run loop. Socket descriptors live in a
// range of their own, above the file system's.
void configure(const String& relayURL);

} // namespace Inception::Sockets
