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

// With a profile service, the IDB server is the service's: a content
// engine's IDB client speaks to it over the link.
void installIDBProxy();
void installIDBService();

} // namespace Inception
