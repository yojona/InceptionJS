#pragma once

#include <wtf/URL.h>
#include <wtf/text/WTFString.h>

namespace WebCore {
class FormState;
class LocalFrame;
class ResourceRequest;
}

namespace Inception::SiteLock {

// isolation 'site': a content engine shows pages of one site (a registrable
// domain, "" for an engine made for a blank window, which shows none). A
// main-frame navigation to another site does not happen here: the engine
// reports it ("navigation.crossSite") and the host opens it in an engine of
// that site. Its profile service enforces the same lock on the link
// (net/LinkPolicy.h), so a subverted engine gains nothing by ignoring it.
void set(const String& site);
bool active();
const String& site();
// Whether a main-frame navigation to `url` stays in this engine: other
// schemes (about:, data:, blob:) do; http(s) only to the engine's site.
bool keeps(const URL&);
// Reports a navigation `keeps` refused: {tab, url, method, body?,
// contentType?, referrer?, initiator?, userGesture}.
void reportCrossSite(unsigned tab, const WebCore::ResourceRequest&, const String& initiator, bool userGesture);

} // namespace Inception::SiteLock
