#pragma once

#include <wtf/Ref.h>

namespace WebCore {
class StorageNamespaceProvider;
}

namespace Inception {

// localStorage persisted per origin in SQLite under the profile, and
// sessionStorage kept in memory per page.
Ref<WebCore::StorageNamespaceProvider> createStorageNamespaceProvider();

} // namespace Inception
