#pragma once

#include <wtf/JSONValues.h>
#include <wtf/text/WTFString.h>

namespace Inception {

// view.preferences: color scheme, reduced motion, contrast, languages and time
// zone, from the host ("preferences" command), live.
void registerPreferenceCommands();
void applyPreferences(JSON::Object&);

// The Accept-Language value for the current languages, e.g. "es-MX,es;q=0.9".
const String& acceptLanguage();

} // namespace Inception
