#pragma once

#include <wtf/text/WTFString.h>

namespace WebCore {
struct SecurityOriginData;
}

namespace Inception::Profile {

// Everything a profile stores lives under /inception/<profile>/: one
// directory per origin for site data, plus engine-wide files at the top. The
// host can clear, export or limit a site by its directory without
// understanding the files.

// Selects the profile; `fresh` deletes whatever it held first.
void select(const String& name, bool fresh);
const String& root();
// Created on first use.
String originDirectory(const WebCore::SecurityOriginData&);
String file(const String& name);

} // namespace Inception::Profile
