#include "config.h"
#include "storage/IndexedDB.h"

#include "DatabaseProvider.h"
#include "IDBConnectionToClient.h"
#include "IDBConnectionToClientDelegate.h"
#include "IDBConnectionToServer.h"
#include "IDBConnectionToServerDelegate.h"
#include "IDBCursorInfo.h"
#include "IDBGetAllRecordsData.h"
#include "IDBGetRecordData.h"
#include "IDBIndexInfo.h"
#include "IDBIterateCursorData.h"
#include "IDBKeyRangeData.h"
#include "IDBObjectStoreInfo.h"
#include "IDBOpenRequestData.h"
#include "IDBRequestData.h"
#include "IDBResultData.h"
#include "IDBServer.h"
#include "IDBTransactionInfo.h"
#include "IDBValue.h"
#include "IndexKey.h"
#include "UniqueIDBDatabaseConnection.h"
#include "storage/Profile.h"
#include <pal/SessionID.h>
#include <wtf/Lock.h>
#include <wtf/RunLoop.h>
#include <wtf/NeverDestroyed.h>

namespace Inception {
using namespace WebCore;
using namespace WebCore::IDBClient;

// Both directions are delivered as separate loop tasks, never inline: WebCore's
// IDB client and server expect replies to arrive after the call returns.
class LocalIDBServer final : public RefCounted<LocalIDBServer>, public IDBConnectionToServerDelegate, public IDBServer::IDBConnectionToClientDelegate {
    WTF_DEPRECATED_MAKE_FAST_ALLOCATED(LocalIDBServer);
    WTF_OVERRIDE_DELETE_FOR_CHECKED_PTR(LocalIDBServer);
public:
    static Ref<LocalIDBServer> create() { return adoptRef(*new LocalIDBServer); }

    IDBConnectionToServer& connectionToServer() { return m_connectionToServer.get(); }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    LocalIDBServer()
        : m_server(makeUnique<WebCore::IDBServer::IDBServer>(Profile::file("indexeddb"_s), [](const ClientOrigin&, uint64_t) { return true; }, m_serverLock))
        , m_connectionToServer(IDBConnectionToServer::create(*this, PAL::SessionID::defaultSessionID()))
        , m_connectionToClient(IDBServer::IDBConnectionToClient::create(*this))
    {
        Locker locker { m_serverLock };
        m_server->registerConnection(m_connectionToClient.get());
    }

    template<typename Function> void toServer(Function&& function)
    {
        RunLoop::mainSingleton().dispatch([protectedThis = Ref { *this }, function = std::forward<Function>(function)]() mutable {
            Locker locker { protectedThis->m_serverLock };
            function(*protectedThis->m_server);
        });
    }

    template<typename Function> void toClient(Function&& function)
    {
        RunLoop::mainSingleton().dispatch([protectedThis = Ref { *this }, function = std::forward<Function>(function)]() mutable {
            function(protectedThis->m_connectionToServer.get());
        });
    }

    // IDBConnectionToServerDelegate and IDBConnectionToClientDelegate share it.
    std::optional<IDBConnectionIdentifier> identifier() const final { return Process::identifier(); }

    // Client -> server.
    void deleteDatabase(const IDBOpenRequestData& data) final { toServer([data](auto& server) { server.deleteDatabase(data); }); }
    void openDatabase(const IDBOpenRequestData& data) final { toServer([data](auto& server) { server.openDatabase(data); }); }
    void abortTransaction(const IDBResourceIdentifier& id) final { toServer([id](auto& server) { server.abortTransaction(id); }); }
    void commitTransaction(const IDBResourceIdentifier& id, uint64_t count) final { toServer([id, count](auto& server) { server.commitTransaction(id, count); }); }
    void didFinishHandlingVersionChangeTransaction(IDBDatabaseConnectionIdentifier connection, const IDBResourceIdentifier& id) final { toServer([connection, id](auto& server) { server.didFinishHandlingVersionChangeTransaction(connection, id); }); }
    void createObjectStore(const IDBRequestData& request, const IDBObjectStoreInfo& info) final { toServer([request, info](auto& server) { server.createObjectStore(request, info); }); }
    void deleteObjectStore(const IDBRequestData& request, const String& name) final { toServer([request, name](auto& server) { server.deleteObjectStore(request, name); }); }
    void renameObjectStore(const IDBRequestData& request, IDBObjectStoreIdentifier store, const String& name) final { toServer([request, store, name](auto& server) { server.renameObjectStore(request, store, name); }); }
    void clearObjectStore(const IDBRequestData& request, IDBObjectStoreIdentifier store) final { toServer([request, store](auto& server) { server.clearObjectStore(request, store); }); }
    void createIndex(const IDBRequestData& request, const IDBIndexInfo& info) final { toServer([request, info](auto& server) { server.createIndex(request, info); }); }
    void deleteIndex(const IDBRequestData& request, IDBObjectStoreIdentifier store, const String& name) final { toServer([request, store, name](auto& server) { server.deleteIndex(request, store, name); }); }
    void renameIndex(const IDBRequestData& request, IDBObjectStoreIdentifier store, IDBIndexIdentifier index, const String& name) final { toServer([request, store, index, name](auto& server) { server.renameIndex(request, store, index, name); }); }
    void putOrAdd(const IDBRequestData& request, const IDBKeyData& key, const IDBValue& value, const IndexIDToIndexKeyMap& indexKeys, const IndexedDB::ObjectStoreOverwriteMode mode) final
    {
        toServer([request, key, value, indexKeys, mode](auto& server) { server.putOrAdd(request, key, value, indexKeys, mode); });
    }
    void getRecord(const IDBRequestData& request, const IDBGetRecordData& data) final { toServer([request, data](auto& server) { server.getRecord(request, data); }); }
    void getAllRecords(const IDBRequestData& request, const IDBGetAllRecordsData& data) final { toServer([request, data](auto& server) { server.getAllRecords(request, data); }); }
    void getCount(const IDBRequestData& request, const IDBKeyRangeData& range) final { toServer([request, range](auto& server) { server.getCount(request, range); }); }
    void deleteRecord(const IDBRequestData& request, const IDBKeyRangeData& range) final { toServer([request, range](auto& server) { server.deleteRecord(request, range); }); }
    void openCursor(const IDBRequestData& request, const IDBCursorInfo& info) final { toServer([request, info](auto& server) { server.openCursor(request, info); }); }
    void iterateCursor(const IDBRequestData& request, const IDBIterateCursorData& data) final { toServer([request, data](auto& server) { server.iterateCursor(request, data); }); }
    void establishTransaction(IDBDatabaseConnectionIdentifier connection, const IDBTransactionInfo& info) final { toServer([connection, info](auto& server) { server.establishTransaction(connection, info); }); }
    void databaseConnectionPendingClose(IDBDatabaseConnectionIdentifier connection) final { toServer([connection](auto& server) { server.databaseConnectionPendingClose(connection); }); }
    void databaseConnectionClosed(IDBDatabaseConnectionIdentifier connection) final { toServer([connection](auto& server) { server.databaseConnectionClosed(connection); }); }
    void abortOpenAndUpgradeNeeded(IDBDatabaseConnectionIdentifier connection, const std::optional<IDBResourceIdentifier>& transaction) final { toServer([connection, transaction](auto& server) { server.abortOpenAndUpgradeNeeded(connection, transaction); }); }
    void didFireVersionChangeEvent(IDBDatabaseConnectionIdentifier connection, const IDBResourceIdentifier& request, const IndexedDB::ConnectionClosedOnBehalfOfServer closed) final { toServer([connection, request, closed](auto& server) { server.didFireVersionChangeEvent(connection, request, closed); }); }
    void didGenerateIndexKeyForRecord(const IDBResourceIdentifier& transaction, const IDBResourceIdentifier& request, const IDBIndexInfo& info, const IDBKeyData& key, const IndexKey& indexKey, std::optional<int64_t> recordID) final
    {
        toServer([transaction, request, info, key, indexKey, recordID](auto& server) { server.didGenerateIndexKeyForRecord(transaction, request, info, key, indexKey, recordID); });
    }
    void openDBRequestCancelled(const IDBOpenRequestData& data) final { toServer([data](auto& server) { server.openDBRequestCancelled(data); }); }
    void getAllDatabaseNamesAndVersions(const IDBResourceIdentifier& request, const ClientOrigin& origin) final
    {
        toServer([request, origin](auto& server) { server.getAllDatabaseNamesAndVersions(Process::identifier(), request, origin); });
    }

    // Server -> client.
    void didDeleteDatabase(const IDBResultData& result) final { toClient([result](auto& client) { client.didDeleteDatabase(result); }); }
    void didOpenDatabase(const IDBResultData& result) final { toClient([result](auto& client) { client.didOpenDatabase(result); }); }
    void didAbortTransaction(const IDBResourceIdentifier& id, const IDBError& error) final { toClient([id, error](auto& client) { client.didAbortTransaction(id, error); }); }
    void didCommitTransaction(const IDBResourceIdentifier& id, const IDBError& error) final { toClient([id, error](auto& client) { client.didCommitTransaction(id, error); }); }
    void didCreateObjectStore(const IDBResultData& result) final { toClient([result](auto& client) { client.didCreateObjectStore(result); }); }
    void didDeleteObjectStore(const IDBResultData& result) final { toClient([result](auto& client) { client.didDeleteObjectStore(result); }); }
    void didRenameObjectStore(const IDBResultData& result) final { toClient([result](auto& client) { client.didRenameObjectStore(result); }); }
    void didClearObjectStore(const IDBResultData& result) final { toClient([result](auto& client) { client.didClearObjectStore(result); }); }
    void didCreateIndex(const IDBResultData& result) final { toClient([result](auto& client) { client.didCreateIndex(result); }); }
    void didDeleteIndex(const IDBResultData& result) final { toClient([result](auto& client) { client.didDeleteIndex(result); }); }
    void didRenameIndex(const IDBResultData& result) final { toClient([result](auto& client) { client.didRenameIndex(result); }); }
    void didPutOrAdd(const IDBResultData& result) final { toClient([result](auto& client) { client.didPutOrAdd(result); }); }
    void didGetRecord(const IDBResultData& result) final { toClient([result](auto& client) { client.didGetRecord(result); }); }
    void didGetAllRecords(const IDBResultData& result) final { toClient([result](auto& client) { client.didGetAllRecords(result); }); }
    void didGetCount(const IDBResultData& result) final { toClient([result](auto& client) { client.didGetCount(result); }); }
    void didDeleteRecord(const IDBResultData& result) final { toClient([result](auto& client) { client.didDeleteRecord(result); }); }
    void didOpenCursor(const IDBResultData& result) final { toClient([result](auto& client) { client.didOpenCursor(result); }); }
    void didIterateCursor(const IDBResultData& result) final { toClient([result](auto& client) { client.didIterateCursor(result); }); }
    void fireVersionChangeEvent(IDBServer::UniqueIDBDatabaseConnection& connection, const IDBResourceIdentifier& request, uint64_t version) final
    {
        toClient([connection = connection.identifier(), request, version](auto& client) { client.fireVersionChangeEvent(connection, request, version); });
    }
    void generateIndexKeyForRecord(const IDBResourceIdentifier& request, const IDBIndexInfo& info, const std::optional<IDBKeyPath>& keyPath, const IDBKeyData& key, const IDBValue& value, std::optional<int64_t> recordID) final
    {
        toClient([request, info, keyPath, key, value, recordID](auto& client) { client.generateIndexKeyForRecord(request, info, keyPath, key, value, recordID); });
    }
    void didStartTransaction(const IDBResourceIdentifier& id, const IDBError& error) final { toClient([id, error](auto& client) { client.didStartTransaction(id, error); }); }
    void didCloseFromServer(IDBServer::UniqueIDBDatabaseConnection& connection, const IDBError& error) final
    {
        toClient([connection = connection.identifier(), error](auto& client) { client.didCloseFromServer(connection, error); });
    }
    void notifyOpenDBRequestBlocked(const IDBResourceIdentifier& request, uint64_t oldVersion, uint64_t newVersion) final { toClient([request, oldVersion, newVersion](auto& client) { client.notifyOpenDBRequestBlocked(request, oldVersion, newVersion); }); }
    void didGetAllDatabaseNamesAndVersions(const IDBResourceIdentifier& request, Vector<IDBDatabaseNameAndVersion>&& databases) final
    {
        toClient([request, databases = WTF::move(databases)](auto& client) mutable { client.didGetAllDatabaseNamesAndVersions(request, WTF::move(databases)); });
    }

    Lock m_serverLock;
    std::unique_ptr<WebCore::IDBServer::IDBServer> m_server;
    Ref<IDBConnectionToServer> m_connectionToServer;
    Ref<IDBServer::IDBConnectionToClient> m_connectionToClient;
};

class IDBDatabaseProvider final : public DatabaseProvider {
public:
    IDBConnectionToServer& idbConnectionToServerForSession(PAL::SessionID) final { return m_server->connectionToServer(); }

private:
    Ref<LocalIDBServer> m_server { LocalIDBServer::create() };
};

// One server for the profile, shared by every tab of every window: two
// servers on the same files would neither see each other's writes nor
// coordinate version changes.
Ref<DatabaseProvider> createDatabaseProvider()
{
    static NeverDestroyed<Ref<IDBDatabaseProvider>> provider { adoptRef(*new IDBDatabaseProvider) };
    return provider.get().copyRef();
}

} // namespace Inception
