#pragma once

#include "FloatRect.h"
#include <optional>
#include <wtf/JSONValues.h>
#include <wtf/text/WTFString.h>

namespace WebCore {
class ContentType;
}

namespace Inception::Media {

// Media in the engine plays through the host page's own media stack: every
// media player here is mirrored by a <video> element there (see host/media.js),
// fed through a real MediaSource when the page uses Media Source Extensions.

// Registers the engine's media engine with WebCore and the host's commands.
void install();

// What the host can decode, probed once at startup ("media" in init).
void setCapabilities(JSON::Object&);
bool hostSupports(const WebCore::ContentType&, bool mediaSource);

// Called after each painted frame: tells the host where each video is now.
// `repainted` (CSS pixels) is the part of the view the frame painted, all of
// it when absent: a video outside it was not painted and has not moved.
void endFrame(unsigned window, std::optional<WebCore::FloatRect> repainted = std::nullopt);

unsigned nextPlayerID();

} // namespace Inception::Media
