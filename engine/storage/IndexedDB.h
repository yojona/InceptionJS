#pragma once

#include <wtf/Ref.h>

namespace WebCore {
class DatabaseProvider;
}

namespace Inception {

// IndexedDB for the engine: WebCore's IDB server running in-process, behind
// the same asynchronous client/server boundary other ports put across
// processes. Databases are SQLite files under the profile's indexeddb/
// directory, which the server lays out by origin.
Ref<WebCore::DatabaseProvider> createDatabaseProvider();

} // namespace Inception
