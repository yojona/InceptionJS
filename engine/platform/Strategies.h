#pragma once

namespace Inception {

// Installs WebCore's platform strategies (loader, pasteboard, media, blobs).
// Must run once, before the first Page is created.
void installPlatformStrategies();

} // namespace Inception
