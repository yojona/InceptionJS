#pragma once

#include <wtf/text/WTFString.h>

namespace WebCore {
class DOMWrapperWorld;
class LocalFrame;
class Page;
}

namespace Inception {

// Page capabilities the embedder decides on (see the architecture's Modules
// section): the WebCore clients that forward them to the host, and the shims
// for APIs this engine does not build, which exist and answer as a browser
// that denied them would.
void installModules(WebCore::Page&);
void registerModuleCommands();

void setPageShims(String&& source);
void installPageShims(WebCore::LocalFrame&, WebCore::DOMWrapperWorld&);

} // namespace Inception
