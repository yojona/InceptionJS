#pragma once

#if ENABLE(ENCRYPTED_MEDIA)

#include "CDMInstance.h"

namespace WebCore {
class Page;
}

namespace Inception::Media {

// Encrypted Media Extensions through the host browser's own CDM. The engine has
// none and cannot ship one; every EME call from the page is mirrored on real
// EME objects in the host page, whose CDM requests the license (the page sends
// it to its license server with its own code), decrypts and presents the video
// in the host <video>. The engine relays opaque bytes only: no key and no
// decrypted sample ever passes through it.
void installHostCDM();

// Lets the page's requests for key system access through; the host browser's
// own EME applies its policies when the request is mirrored there.
void provideMediaKeySystem(WebCore::Page&);

// The host's handle for the MediaKeys behind a CDM instance, to attach to a
// host <video>; 0 if the instance is not one of ours.
unsigned hostMediaKeysID(WebCore::CDMInstance&);

} // namespace Inception::Media

#endif // ENABLE(ENCRYPTED_MEDIA)
