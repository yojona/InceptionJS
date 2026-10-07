#pragma once

#include <wtf/Ref.h>

namespace WebCore {
class DatabaseProvider;
}

namespace Inception {

// IndexedDB for the engine: WebCore's IDB server running in-process, behind
// the same asynchronous client/server boundary other ports put across
// processes. Databases are in memory for now; a directory path (backed by host
// storage) turns on SQLite persistence later without changing this interface.
Ref<WebCore::DatabaseProvider> createDatabaseProvider();

} // namespace Inception
