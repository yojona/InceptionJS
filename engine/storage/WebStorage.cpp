#include "config.h"
#include "storage/WebStorage.h"

#include "Document.h"
#include "LocalFrame.h"
#include "LocalFrameInlines.h"
#include "Page.h"
#include "SQLiteDatabase.h"
#include "SQLiteStatement.h"
#include "SecurityOrigin.h"
#include "SecurityOriginData.h"
#include "Storage.h"
#include "StorageArea.h"
#include "StorageEventDispatcher.h"
#include "StorageMap.h"
#include "StorageNamespace.h"
#include "StorageNamespaceProvider.h"
#include "StorageType.h"
#include "storage/Profile.h"
#include <pal/SessionID.h>
#include <wtf/FileSystem.h>
#include <wtf/Function.h>
#include <wtf/HashMap.h>
#include <wtf/WeakHashMap.h>

namespace Inception {
using namespace WebCore;

// Same limit browsers use per origin.
static constexpr unsigned quotaBytes = 5 * 1024 * 1024;

// One origin's items, written through to SQLite for localStorage.
class Area final : public StorageArea {
public:
    static Ref<Area> create(StorageType type, const SecurityOriginData& origin) { return adoptRef(*new Area(type, origin)); }

    unsigned length() final { return m_map.length(); }
    String key(unsigned index) final { return m_map.key(index); }
    String item(const String& key) final { return m_map.getItem(key); }
    bool contains(const String& key) final { return m_map.contains(key); }
    StorageType storageType() const final { return m_type; }
    size_t memoryBytesUsedByCache() final { return 0; }

    void setItem(LocalFrame& frame, const String& key, const String& value, bool& quotaException) final
    {
        String oldValue;
        m_map.setItem(key, value, oldValue, quotaException);
        if (quotaException || oldValue == value)
            return;
        persist([&](SQLiteDatabase& database) {
            auto statement = database.prepareStatement("INSERT OR REPLACE INTO items (key, value) VALUES (?, ?)"_s);
            if (statement && statement->bindText(1, key) == SQLITE_OK && statement->bindText(2, value) == SQLITE_OK)
                statement->executeCommand();
        });
        dispatch(frame, key, oldValue, value);
    }

    void removeItem(LocalFrame& frame, const String& key) final
    {
        String oldValue;
        m_map.removeItem(key, oldValue);
        if (oldValue.isNull())
            return;
        persist([&](SQLiteDatabase& database) {
            auto statement = database.prepareStatement("DELETE FROM items WHERE key = ?"_s);
            if (statement && statement->bindText(1, key) == SQLITE_OK)
                statement->executeCommand();
        });
        dispatch(frame, key, oldValue, { });
    }

    void clear(LocalFrame& frame) final
    {
        if (!m_map.length())
            return;
        m_map.clear();
        persist([](SQLiteDatabase& database) {
            database.executeCommand("DELETE FROM items"_s);
        });
        dispatch(frame, { }, { }, { });
    }

private:
    Area(StorageType type, const SecurityOriginData& origin)
        : m_type(type)
        , m_origin(origin)
        , m_map(quotaBytes)
    {
        if (m_type == StorageType::Local)
            load();
    }

    void load()
    {
        auto path = FileSystem::pathByAppendingComponent(Profile::originDirectory(m_origin), "localstorage.sqlite"_s);
        if (!m_database.open(path) || !m_database.executeCommand("CREATE TABLE IF NOT EXISTS items (key TEXT UNIQUE ON CONFLICT REPLACE, value TEXT NOT NULL)"_s)) {
            m_database.close();
            return;
        }
        HashMap<String, String> items;
        if (auto statement = m_database.prepareStatement("SELECT key, value FROM items"_s)) {
            while (statement->step() == SQLITE_ROW)
                items.set(statement->columnText(0), statement->columnText(1));
        }
        m_map.importItems(WTF::move(items));
    }

    template<typename Function> void persist(Function&& function)
    {
        if (m_type == StorageType::Local && m_database.isOpen())
            function(m_database);
    }

    void dispatch(LocalFrame& frame, const String& key, const String& oldValue, const String& newValue)
    {
        RefPtr document = frame.document();
        RefPtr page = frame.page();
        if (!document || !page)
            return;
        Function<bool(Storage&)> isSource = [this](Storage& storage) { return &storage.area() == static_cast<StorageArea*>(this); };
        if (m_type == StorageType::Session)
            StorageEventDispatcher::dispatchSessionStorageEvents(key, oldValue, newValue, *page, document->securityOrigin(), document->url().string(), isSource);
        else
            StorageEventDispatcher::dispatchLocalStorageEvents(key, oldValue, newValue, &page->group(), document->securityOrigin(), document->url().string(), isSource);
    }

    StorageType m_type;
    SecurityOriginData m_origin;
    StorageMap m_map;
    SQLiteDatabase m_database;
};

class Namespace final : public StorageNamespace {
public:
    static Ref<Namespace> create(StorageType type, PAL::SessionID sessionID) { return adoptRef(*new Namespace(type, sessionID)); }

    Ref<StorageArea> storageArea(const SecurityOrigin& origin) final
    {
        auto data = origin.data();
        return m_areas.ensure(data, [&] { return Area::create(m_type, data); }).iterator->value;
    }

    const SecurityOrigin* topLevelOrigin() const final { return nullptr; }

    // Only one page exists; a copy shares nothing with the original.
    Ref<StorageNamespace> copy(Page&) final { return create(m_type, m_sessionID); }
    PAL::SessionID sessionID() const final { return m_sessionID; }
    void setSessionIDForTesting(PAL::SessionID sessionID) final { m_sessionID = sessionID; }

private:
    Namespace(StorageType type, PAL::SessionID sessionID)
        : m_type(type)
        , m_sessionID(sessionID)
    {
    }

    StorageType m_type;
    PAL::SessionID m_sessionID;
    HashMap<SecurityOriginData, Ref<Area>> m_areas;
};

class Provider final : public StorageNamespaceProvider {
    RefPtr<StorageNamespace> sessionStorageNamespace(const SecurityOrigin&, Page& page, ShouldCreateNamespace shouldCreate) final
    {
        if (auto it = m_sessionNamespaces.find(page); it != m_sessionNamespaces.end())
            return it->value.ptr();
        if (shouldCreate == ShouldCreateNamespace::No)
            return nullptr;
        auto storage = Namespace::create(StorageType::Session, page.sessionID());
        m_sessionNamespaces.set(page, storage.copyRef());
        return storage;
    }

    Ref<StorageNamespace> createLocalStorageNamespace(unsigned, PAL::SessionID sessionID) final
    {
        return Namespace::create(StorageType::Local, sessionID);
    }

    Ref<StorageNamespace> createTransientLocalStorageNamespace(SecurityOrigin&, unsigned, PAL::SessionID sessionID) final
    {
        return Namespace::create(StorageType::TransientLocal, sessionID);
    }

    WeakHashMap<Page, Ref<Namespace>> m_sessionNamespaces;
};

Ref<StorageNamespaceProvider> createStorageNamespaceProvider()
{
    return adoptRef(*new Provider);
}

} // namespace Inception
