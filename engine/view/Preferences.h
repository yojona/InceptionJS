#pragma once

#include <wtf/JSONValues.h>
#include <wtf/text/WTFString.h>

namespace WebCore {
class Page;
}

namespace Inception {

// view.preferences: color scheme, reduced motion, contrast, languages and time
// zone, from the host ("preferences" command), live.
void registerPreferenceCommands();
void applyPreferences(JSON::Object&);
// A new tab gets the preferences already in effect.
void applyPagePreferences(WebCore::Page&);

// The Accept-Language value for the current languages, e.g. "es-MX,es;q=0.9".
const String& acceptLanguage();

} // namespace Inception
