#pragma once

#include <wtf/URL.h>
#include <wtf/text/WTFString.h>

namespace Inception::History {

// The profile's browsing history (history.sqlite): one row per visit to a
// main-frame http(s) page, with the title it ended up with. The host queries
// and deletes it through commands; nothing in it leaves the profile.
void recordVisit(const URL&);
void updateTitle(const URL&, const String& title);
void registerCommands();

} // namespace Inception::History
