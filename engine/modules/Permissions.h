#pragma once

#include <wtf/CompletionHandler.h>
#include <wtf/text/WTFString.h>

namespace Inception::Permissions {

// What a page asked for. The host answers per the embedder's `modules`
// configuration (host/modules.js): a fixed answer, its own UI, or a denial.
enum class Kind : uint8_t { Geolocation, Notifications };

// Asks the host for `origin`; `completion` gets true when granted.
void request(Kind, const String& origin, CompletionHandler<void(bool granted)>&&);

void install();

} // namespace Inception::Permissions
