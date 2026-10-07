#pragma once

#include <wtf/text/WTFString.h>

namespace Inception {

// view.preferences: color scheme, reduced motion, contrast, languages and time
// zone, from the host ("preferences" command), live.
void registerPreferenceCommands();

// The Accept-Language value for the current languages, e.g. "es-MX,es;q=0.9".
const String& acceptLanguage();

} // namespace Inception
