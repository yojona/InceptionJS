#pragma once

#include <wtf/Ref.h>

namespace WebCore {
class StorageNamespaceProvider;
}

namespace Inception {

// localStorage persisted per origin in SQLite under the profile, and
// sessionStorage kept in memory per page.
Ref<WebCore::StorageNamespaceProvider> createStorageNamespaceProvider();

// With a profile service, localStorage lives there: a content engine keeps a
// copy of each origin's items it uses, and changes reach every engine.
void installStorageProxy();
void installStorageService();

} // namespace Inception
