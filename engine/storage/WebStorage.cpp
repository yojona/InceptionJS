#include "config.h"
#include "storage/WebStorage.h"

#include "Document.h"
#include "LocalFrame.h"
#include "DocumentPage.h"
#include "LocalFrameInlines.h"
#include "Page.h"
#include "PageGroup.h"
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
#include "link/IDBCoders.h"
#include "link/Link.h"
#include "storage/Profile.h"
#include "view/View.h"
#include <pal/SessionID.h>
#include <wtf/FileSystem.h>
#include <wtf/Function.h>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/WeakHashMap.h>
#include <wtf/NeverDestroyed.h>

namespace Inception {
using namespace WebCore;

// Same limit browsers use per origin.
static constexpr unsigned quotaBytes = 5 * 1024 * 1024;

// One origin's items, written through to SQLite for localStorage.
class WebStorageArea final : public StorageArea {
public:
    static Ref<WebStorageArea> create(StorageType type, const SecurityOriginData& origin) { return adoptRef(*new WebStorageArea(type, origin)); }

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
    WebStorageArea(StorageType type, const SecurityOriginData& origin)
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
        // The window that made the change gets no event; every other window
        // of the origin does, also those sharing this area (other tabs and
        // windows).
        Function<bool(Storage&)> isSource = [&frame](Storage& storage) { return storage.frame() == &frame; };
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

// A storage change, as both ends send it: kind (set, remove, clear), key,
// old and new values, the URL of the document that made it.
enum class StorageChange : uint8_t { Set, Remove, Clear };
template<> struct EnumLimit<StorageChange> {
    static constexpr std::optional<uint64_t> max = static_cast<uint64_t>(StorageChange::Clear);
};

static void dispatchLocalStorageChange(const SecurityOriginData& origin, const String& key, const String& oldValue, const String& newValue, const String& url, LocalFrame* source)
{
    // Every page of the engine is in one page group.
    PageGroup* group = nullptr;
    for (auto* view : View::all()) {
        group = &view->page().group();
        break;
    }
    if (!group)
        return;
    Function<bool(Storage&)> isSource = [source](Storage& storage) { return source && storage.frame() == source; };
    StorageEventDispatcher::dispatchLocalStorageEvents(key, oldValue, newValue, group, origin.securityOrigin(), url, isSource);
}

// A content engine's localStorage for one origin: the profile service holds
// the items and the file. The first use reads the whole map with a waiting
// call (as other engines load an area at once); writes apply here, go to the
// service, and reach other engines as "storage" events. The service numbers
// every change, so changes that crossed in flight apply in its order.
class ProxyStorageArea final : public StorageArea {
public:
    static Ref<ProxyStorageArea> create(const SecurityOriginData& origin) { return adoptRef(*new ProxyStorageArea(origin)); }

    static HashMap<SecurityOriginData, Ref<ProxyStorageArea>>& areas()
    {
        static NeverDestroyed<HashMap<SecurityOriginData, Ref<ProxyStorageArea>>> map;
        return map;
    }

    unsigned length() final { load(); return m_map.length(); }
    String key(unsigned index) final { load(); return m_map.key(index); }
    String item(const String& key) final { load(); return m_map.getItem(key); }
    bool contains(const String& key) final { load(); return m_map.contains(key); }
    StorageType storageType() const final { return StorageType::Local; }
    size_t memoryBytesUsedByCache() final { return 0; }

    void setItem(LocalFrame& frame, const String& key, const String& value, bool& quotaException) final
    {
        load();
        String oldValue;
        m_map.setItem(key, value, oldValue, quotaException);
        if (quotaException || oldValue == value)
            return;
        send(frame, StorageChange::Set, key, value);
        dispatch(frame, key, oldValue, value);
    }

    void removeItem(LocalFrame& frame, const String& key) final
    {
        load();
        String oldValue;
        m_map.removeItem(key, oldValue);
        if (oldValue.isNull())
            return;
        send(frame, StorageChange::Remove, key, { });
        dispatch(frame, key, oldValue, { });
    }

    void clear(LocalFrame& frame) final
    {
        load();
        if (!m_map.length())
            return;
        m_map.clear();
        send(frame, StorageChange::Clear, { }, { });
        dispatch(frame, { }, { }, { });
    }

    // A change the service numbered `sequence`; `mine`: this engine made it.
    void apply(uint64_t sequence, StorageChange change, const String& key, const String& oldValue, const String& newValue, const String& url, bool mine)
    {
        // Documents that never read the area still hear of the change; the
        // map itself is read when first used.
        if (!m_loaded) {
            if (!mine)
                dispatchLocalStorageChange(m_origin, key, oldValue, newValue, url, nullptr);
            return;
        }
        if (sequence <= m_sequence)
            return;
        m_sequence = sequence;
        bool differs = false;
        switch (change) {
        case StorageChange::Set:
            differs = m_map.getItem(key) != newValue;
            m_map.setItemIgnoringQuota(key, newValue);
            break;
        case StorageChange::Remove: {
            String removed;
            m_map.removeItem(key, removed);
            differs = !removed.isNull();
            break;
        }
        case StorageChange::Clear:
            differs = !!m_map.length();
            m_map.clear();
            break;
        }
        if (!mine && (differs || change == StorageChange::Clear))
            dispatchLocalStorageChange(m_origin, key, oldValue, newValue, url, nullptr);
    }

    // The service went away: read everything again on next use.
    void forget()
    {
        m_loaded = false;
        m_sequence = 0;
        m_map.clear();
    }

private:
    explicit ProxyStorageArea(const SecurityOriginData& origin)
        : m_origin(origin)
        , m_map(quotaBytes)
    {
    }

    void load()
    {
        if (m_loaded)
            return;
        RefPtr link = Link::service();
        if (!link)
            return;
        Encoder encoder;
        encoder << m_origin;
        auto reply = link->callSync(Message::StorageLoad, WTF::move(encoder));
        if (!reply)
            return;
        Decoder decoder { reply->span() };
        auto sequence = decoder.u64();
        auto items = decoder.decode<Vector<std::pair<String, String>>>();
        if (!items)
            return;
        HashMap<String, String> map;
        for (auto& [key, value] : *items)
            map.set(key, value);
        m_map.clear();
        m_map.importItems(WTF::move(map));
        m_sequence = *sequence;
        m_loaded = true;
    }

    void send(LocalFrame& frame, StorageChange change, const String& key, const String& value)
    {
        RefPtr link = Link::service();
        if (!link)
            return;
        RefPtr document = frame.document();
        Encoder encoder;
        encoder << m_origin << change << key << value << (document ? document->url().string() : String { });
        link->send(Message::StorageChange, WTF::move(encoder));
    }

    void dispatch(LocalFrame& frame, const String& key, const String& oldValue, const String& newValue)
    {
        RefPtr document = frame.document();
        if (document)
            dispatchLocalStorageChange(m_origin, key, oldValue, newValue, document->url().string(), &frame);
    }

    SecurityOriginData m_origin;
    StorageMap m_map;
    uint64_t m_sequence { 0 };
    bool m_loaded { false };
};

// The service's localStorage for one origin: the items and their file, and
// the content engines that hold a copy.
class ServiceStorageArea {
    WTF_DEPRECATED_MAKE_FAST_ALLOCATED(ServiceStorageArea);
public:
    explicit ServiceStorageArea(const SecurityOriginData& origin)
        : m_map(quotaBytes)
    {
        auto path = FileSystem::pathByAppendingComponent(Profile::originDirectory(origin), "localstorage.sqlite"_s);
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

    Vector<std::pair<String, String>> items()
    {
        Vector<std::pair<String, String>> result;
        for (unsigned i = 0; i < m_map.length(); ++i) {
            auto key = m_map.key(i);
            result.append({ key, m_map.getItem(key) });
        }
        return result;
    }

    // Applies a change; false when it changed nothing (or broke the quota).
    bool apply(StorageChange change, const String& key, const String& value, String& oldValue)
    {
        bool quotaException = false;
        switch (change) {
        case StorageChange::Set:
            m_map.setItem(key, value, oldValue, quotaException);
            if (quotaException || oldValue == value)
                return false;
            persist("INSERT OR REPLACE INTO items (key, value) VALUES (?, ?)"_s, key, value);
            return true;
        case StorageChange::Remove:
            m_map.removeItem(key, oldValue);
            if (oldValue.isNull())
                return false;
            persist("DELETE FROM items WHERE key = ?"_s, key, { });
            return true;
        case StorageChange::Clear:
            if (!m_map.length())
                return false;
            m_map.clear();
            if (m_database.isOpen())
                m_database.executeCommand("DELETE FROM items"_s);
            return true;
        }
        return false;
    }

    uint64_t sequence { 0 };

private:
    void persist(ASCIILiteral sql, const String& first, const String& second)
    {
        if (!m_database.isOpen())
            return;
        auto statement = m_database.prepareStatement(sql);
        if (!statement || statement->bindText(1, first) != SQLITE_OK)
            return;
        if (!second.isNull() && statement->bindText(2, second) != SQLITE_OK)
            return;
        statement->executeCommand();
    }

    StorageMap m_map;
    SQLiteDatabase m_database;
};

static HashMap<SecurityOriginData, std::unique_ptr<ServiceStorageArea>>& serviceAreas()
{
    static NeverDestroyed<HashMap<SecurityOriginData, std::unique_ptr<ServiceStorageArea>>> map;
    return map;
}

static ServiceStorageArea& serviceArea(const SecurityOriginData& origin)
{
    return *serviceAreas().ensure(origin, [&] { return makeUnique<ServiceStorageArea>(origin); }).iterator->value;
}

void installStorageService()
{
    // {origin} -> {sequence, items}
    Link::handleSync(Message::StorageLoad, [](Link&, Decoder& decoder, Encoder& reply) {
        auto origin = decoder.decode<SecurityOriginData>();
        if (!origin)
            return false;
        auto& area = serviceArea(*origin);
        reply.u64(area.sequence);
        reply << area.items();
        return true;
    });
    // {origin, change, key, value, url}: every content engine hears it,
    // numbered; the one that made it only to keep its order.
    Link::handle(Message::StorageChange, [](Link& link, Decoder& decoder) {
        auto origin = decoder.decode<SecurityOriginData>();
        auto change = decoder.decode<StorageChange>();
        auto key = decoder.string();
        auto value = decoder.string();
        auto url = decoder.string();
        if (!url)
            return;
        auto& area = serviceArea(*origin);
        String oldValue;
        if (!area.apply(*change, *key, *value, oldValue))
            return;
        auto sequence = ++area.sequence;
        // Every content engine hears it: those holding the map apply it, and
        // documents of the origin elsewhere get their storage event.
        for (auto& target : Link::all()) {
            if (!target->isServiceEnd() || !target->isOpen())
                continue;
            auto holder = target->id();
            Encoder encoder;
            encoder << *origin;
            encoder.u64(sequence);
            encoder << *change << *key << oldValue << *value << *url;
            encoder.boolean(holder == link.id());
            target->send(Message::StorageChanged, WTF::move(encoder));
        }
    });
}

void installStorageProxy()
{
    // {origin, sequence, change, key, old, new, url, mine}
    Link::handle(Message::StorageChanged, [](Link&, Decoder& decoder) {
        auto origin = decoder.decode<SecurityOriginData>();
        auto sequence = decoder.u64();
        auto change = decoder.decode<StorageChange>();
        auto key = decoder.string();
        auto oldValue = decoder.string();
        auto newValue = decoder.string();
        auto url = decoder.string();
        auto mine = decoder.boolean();
        if (!mine)
            return;
        auto it = ProxyStorageArea::areas().find(*origin);
        if (it != ProxyStorageArea::areas().end())
            Ref { it->value }->apply(*sequence, *change, *key, *oldValue, *newValue, *url, *mine);
        else if (!*mine)
            dispatchLocalStorageChange(*origin, *key, *oldValue, *newValue, *url, nullptr);
    });
    Link::addCloseObserver([](Link& link) {
        if (link.isServiceEnd())
            return;
        for (auto& area : ProxyStorageArea::areas().values())
            area->forget();
    });
}

class WebStorageNamespace final : public StorageNamespace {
public:
    static Ref<WebStorageNamespace> create(StorageType type, PAL::SessionID sessionID) { return adoptRef(*new WebStorageNamespace(type, sessionID)); }

    Ref<StorageArea> storageArea(const SecurityOrigin& origin) final
    {
        auto data = origin.data();
        if (m_type == StorageType::Local && role() == Role::Content)
            return ProxyStorageArea::areas().ensure(data, [&] { return ProxyStorageArea::create(data); }).iterator->value;
        return m_areas.ensure(data, [&] { return WebStorageArea::create(m_type, data); }).iterator->value;
    }

    const SecurityOrigin* topLevelOrigin() const final { return nullptr; }

    // A copy (sessionStorage for a page another opened) shares nothing with
    // the original.
    Ref<StorageNamespace> copy(Page&) final { return create(m_type, m_sessionID); }
    PAL::SessionID sessionID() const final { return m_sessionID; }
    void setSessionIDForTesting(PAL::SessionID sessionID) final { m_sessionID = sessionID; }

private:
    WebStorageNamespace(StorageType type, PAL::SessionID sessionID)
        : m_type(type)
        , m_sessionID(sessionID)
    {
    }

    StorageType m_type;
    PAL::SessionID m_sessionID;
    HashMap<SecurityOriginData, Ref<WebStorageArea>> m_areas;
};

class WebStorageNamespaceProvider final : public StorageNamespaceProvider {
    RefPtr<StorageNamespace> sessionStorageNamespace(const SecurityOrigin&, Page& page, ShouldCreateNamespace shouldCreate) final
    {
        if (auto it = m_sessionNamespaces.find(page); it != m_sessionNamespaces.end())
            return it->value.ptr();
        if (shouldCreate == ShouldCreateNamespace::No)
            return nullptr;
        auto storage = WebStorageNamespace::create(StorageType::Session, page.sessionID());
        m_sessionNamespaces.set(page, storage.copyRef());
        return storage;
    }

    Ref<StorageNamespace> createLocalStorageNamespace(unsigned, PAL::SessionID sessionID) final
    {
        return WebStorageNamespace::create(StorageType::Local, sessionID);
    }

    Ref<StorageNamespace> createTransientLocalStorageNamespace(SecurityOrigin&, unsigned, PAL::SessionID sessionID) final
    {
        return WebStorageNamespace::create(StorageType::TransientLocal, sessionID);
    }

    WeakHashMap<Page, Ref<WebStorageNamespace>> m_sessionNamespaces;
};

// One provider for every tab of every window, so localStorage is one map per
// origin (pages saw stale copies with a provider each); sessionStorage stays
// per page.
Ref<StorageNamespaceProvider> createStorageNamespaceProvider()
{
    static NeverDestroyed<Ref<WebStorageNamespaceProvider>> provider { adoptRef(*new WebStorageNamespaceProvider) };
    return provider.get().copyRef();
}

} // namespace Inception
