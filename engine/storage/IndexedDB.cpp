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
#include "Page.h"
#include "UniqueIDBDatabaseConnection.h"
#include "link/IDBCoders.h"
#include "link/Link.h"
#include "storage/Profile.h"
#include "view/View.h"
#include <pal/SessionID.h>
#include <wtf/FileHandle.h>
#include <wtf/FileSystem.h>
#include <wtf/Lock.h>
#include <wtf/text/MakeString.h>
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

// IndexedDB with a profile service: the IDB server (and the databases'
// files) live in the service; each content engine's IDB client talks to it
// over its link. Every call of WebCore's client/server delegates crosses as
// one IDB frame: an operation, then its arguments in order.
enum class IDBOp : uint8_t {
    // Client to server.
    DeleteDatabase, OpenDatabase, AbortTransaction, CommitTransaction, DidFinishHandlingVersionChangeTransaction,
    CreateObjectStore, DeleteObjectStore, RenameObjectStore, ClearObjectStore, CreateIndex, DeleteIndex, RenameIndex,
    PutOrAdd, GetRecord, GetAllRecords, GetCount, DeleteRecord, OpenCursor, IterateCursor, EstablishTransaction,
    DatabaseConnectionPendingClose, DatabaseConnectionClosed, AbortOpenAndUpgradeNeeded, DidFireVersionChangeEvent,
    DidGenerateIndexKeyForRecord, OpenDBRequestCancelled, GetAllDatabaseNamesAndVersions,
    // Server to client.
    DidDeleteDatabase, DidOpenDatabase, DidAbortTransaction, DidCommitTransaction, DidCreateObjectStore,
    DidDeleteObjectStore, DidRenameObjectStore, DidClearObjectStore, DidCreateIndex, DidDeleteIndex, DidRenameIndex,
    DidPutOrAdd, DidGetRecord, DidGetAllRecords, DidGetCount, DidDeleteRecord, DidOpenCursor, DidIterateCursor,
    FireVersionChangeEvent, GenerateIndexKeyForRecord, DidStartTransaction, DidCloseFromServer,
    NotifyOpenDBRequestBlocked, DidGetAllDatabaseNamesAndVersions,
};

template<> struct EnumLimit<IndexedDB::ObjectStoreOverwriteMode> {
    static constexpr std::optional<uint64_t> max = static_cast<uint64_t>(IndexedDB::ObjectStoreOverwriteMode::NoOverwrite);
};

template<> struct Coder<IndexIDToIndexKeyMap> {
    static void encode(Encoder& encoder, const IndexIDToIndexKeyMap& map)
    {
        encoder.u32(map.size());
        for (auto& [index, key] : map)
            encoder << index << key;
    }
    static std::optional<IndexIDToIndexKeyMap> decode(Decoder& decoder)
    {
        auto count = decoder.count(9);
        if (!count)
            return std::nullopt;
        IndexIDToIndexKeyMap map;
        for (uint32_t i = 0; i < *count; ++i) {
            auto index = decoder.decode<IDBIndexIdentifier>();
            auto key = index ? decoder.decode<IndexKey>() : std::nullopt;
            if (!key)
                return std::nullopt;
            map.set(*index, WTF::move(*key));
        }
        return map;
    }
};

template<typename... Arguments> static Encoder idbFrame(IDBOp op, const Arguments&... arguments)
{
    Encoder encoder;
    encoder.u8(static_cast<uint8_t>(op));
    (encoder << ... << arguments);
    return encoder;
}

// Decodes the arguments of one frame; calls `function` only when all decoded
// and nothing is left over.
template<typename... Arguments, typename Function> static void withArguments(Decoder& decoder, Function&& function)
{
    std::tuple<std::optional<Arguments>...> values { decoder.decode<Arguments>()... };
    if (decoder.failed() || !decoder.atEnd())
        return;
    std::apply([&](auto&... value) {
        if ((... && !!value))
            function(WTF::move(*value)...);
    }, values);
}

// Content side: WebCore's IDB client, whose server is the service's.
class RemoteIDBServer final : public RefCounted<RemoteIDBServer>, public IDBConnectionToServerDelegate {
    WTF_DEPRECATED_MAKE_FAST_ALLOCATED(RemoteIDBServer);
public:
    static RemoteIDBServer& singleton()
    {
        static NeverDestroyed<Ref<RemoteIDBServer>> server { adoptRef(*new RemoteIDBServer) };
        return server.get();
    }

    IDBConnectionToServer& connectionToServer() { return m_connectionToServer.get(); }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    void receive(Decoder&);
    // Open databases close, as when a browser loses its storage process.
    // Documents already loaded keep the dead connection (their IndexedDB
    // fails until reloaded); pages get a new one for what they load next.
    void lost()
    {
        m_hello = nullptr;
        auto previous = std::exchange(m_connectionToServer, IDBConnectionToServer::create(*this, PAL::SessionID::defaultSessionID()));
        previous->connectionToServerLost(IDBError::serverConnectionLostError());
        for (auto* view : View::all())
            view->page().clearIDBConnection();
    }

private:
    RemoteIDBServer()
        : m_connectionToServer(IDBConnectionToServer::create(*this, PAL::SessionID::defaultSessionID()))
    {
    }

    template<typename... Arguments> void send(IDBOp op, const Arguments&... arguments)
    {
        RefPtr link = Link::service();
        if (!link)
            return;
        // The service learns which connection this engine speaks for once
        // per link, before anything else.
        if (m_hello != link) {
            m_hello = link.get();
            Encoder hello;
            hello << Process::identifier();
            link->send(Message::IDBHello, WTF::move(hello));
        }
        link->send(Message::IDBToServer, idbFrame(op, arguments...));
    }

    std::optional<IDBConnectionIdentifier> identifier() const final { return Process::identifier(); }

    void deleteDatabase(const IDBOpenRequestData& data) final { send(IDBOp::DeleteDatabase, data); }
    void openDatabase(const IDBOpenRequestData& data) final { send(IDBOp::OpenDatabase, data); }
    void abortTransaction(const IDBResourceIdentifier& id) final { send(IDBOp::AbortTransaction, id); }
    void commitTransaction(const IDBResourceIdentifier& id, uint64_t count) final { send(IDBOp::CommitTransaction, id, count); }
    void didFinishHandlingVersionChangeTransaction(IDBDatabaseConnectionIdentifier connection, const IDBResourceIdentifier& id) final { send(IDBOp::DidFinishHandlingVersionChangeTransaction, connection, id); }
    void createObjectStore(const IDBRequestData& request, const IDBObjectStoreInfo& info) final { send(IDBOp::CreateObjectStore, request, info); }
    void deleteObjectStore(const IDBRequestData& request, const String& name) final { send(IDBOp::DeleteObjectStore, request, name); }
    void renameObjectStore(const IDBRequestData& request, IDBObjectStoreIdentifier store, const String& name) final { send(IDBOp::RenameObjectStore, request, store, name); }
    void clearObjectStore(const IDBRequestData& request, IDBObjectStoreIdentifier store) final { send(IDBOp::ClearObjectStore, request, store); }
    void createIndex(const IDBRequestData& request, const IDBIndexInfo& info) final { send(IDBOp::CreateIndex, request, info); }
    void deleteIndex(const IDBRequestData& request, IDBObjectStoreIdentifier store, const String& name) final { send(IDBOp::DeleteIndex, request, store, name); }
    void renameIndex(const IDBRequestData& request, IDBObjectStoreIdentifier store, IDBIndexIdentifier index, const String& name) final { send(IDBOp::RenameIndex, request, store, index, name); }
    void putOrAdd(const IDBRequestData& request, const IDBKeyData& key, const IDBValue& value, const IndexIDToIndexKeyMap& indexKeys, const IndexedDB::ObjectStoreOverwriteMode mode) final { send(IDBOp::PutOrAdd, request, key, value, indexKeys, mode); }
    void getRecord(const IDBRequestData& request, const IDBGetRecordData& data) final { send(IDBOp::GetRecord, request, data); }
    void getAllRecords(const IDBRequestData& request, const IDBGetAllRecordsData& data) final { send(IDBOp::GetAllRecords, request, data); }
    void getCount(const IDBRequestData& request, const IDBKeyRangeData& range) final { send(IDBOp::GetCount, request, range); }
    void deleteRecord(const IDBRequestData& request, const IDBKeyRangeData& range) final { send(IDBOp::DeleteRecord, request, range); }
    void openCursor(const IDBRequestData& request, const IDBCursorInfo& info) final { send(IDBOp::OpenCursor, request, info); }
    void iterateCursor(const IDBRequestData& request, const IDBIterateCursorData& data) final { send(IDBOp::IterateCursor, request, data); }
    void establishTransaction(IDBDatabaseConnectionIdentifier connection, const IDBTransactionInfo& info) final { send(IDBOp::EstablishTransaction, connection, info); }
    void databaseConnectionPendingClose(IDBDatabaseConnectionIdentifier connection) final { send(IDBOp::DatabaseConnectionPendingClose, connection); }
    void databaseConnectionClosed(IDBDatabaseConnectionIdentifier connection) final { send(IDBOp::DatabaseConnectionClosed, connection); }
    void abortOpenAndUpgradeNeeded(IDBDatabaseConnectionIdentifier connection, const std::optional<IDBResourceIdentifier>& transaction) final { send(IDBOp::AbortOpenAndUpgradeNeeded, connection, transaction); }
    void didFireVersionChangeEvent(IDBDatabaseConnectionIdentifier connection, const IDBResourceIdentifier& request, const IndexedDB::ConnectionClosedOnBehalfOfServer closed) final { send(IDBOp::DidFireVersionChangeEvent, connection, request, closed); }
    void didGenerateIndexKeyForRecord(const IDBResourceIdentifier& transaction, const IDBResourceIdentifier& request, const IDBIndexInfo& info, const IDBKeyData& key, const IndexKey& indexKey, std::optional<int64_t> recordID) final
    {
        send(IDBOp::DidGenerateIndexKeyForRecord, transaction, request, info, key, indexKey, recordID);
    }
    void openDBRequestCancelled(const IDBOpenRequestData& data) final { send(IDBOp::OpenDBRequestCancelled, data); }
    void getAllDatabaseNamesAndVersions(const IDBResourceIdentifier& request, const ClientOrigin& origin) final { send(IDBOp::GetAllDatabaseNamesAndVersions, request, origin); }

    Ref<IDBConnectionToServer> m_connectionToServer;
    Link* m_hello { nullptr };
};

// Blob values of records are files of the service. Before a result that
// names one reaches WebCore, the file is copied here, to the same path, so
// the blob reads as it would in the engine that stored it.
static void copyBlobFiles(const IDBValue& value)
{
    RefPtr link = Link::service();
    if (!link)
        return;
    for (auto& path : value.blobFilePaths()) {
        if (path.isEmpty() || FileSystem::fileExists(path))
            continue;
        Encoder encoder;
        encoder << path;
        auto reply = link->callSync(Message::IDBBlobRead, WTF::move(encoder));
        if (!reply)
            continue;
        Decoder decoder { reply->span() };
        auto bytes = decoder.view();
        if (!bytes)
            continue;
        FileSystem::makeAllDirectories(FileSystem::parentPath(path));
        FileSystem::overwriteEntireFile(path, *bytes);
    }
}

static void copyBlobFiles(const IDBResultData& result)
{
    if (auto* getResult = getResultOf(result)) {
        copyBlobFiles(getResult->value());
        for (auto& record : getResult->prefetchedRecords())
            copyBlobFiles(record.value);
    }
    if (auto* getAllResult = getAllResultOf(result); getAllResult && getAllResult->type() == IndexedDB::GetAllType::Values) {
        for (auto& value : getAllResult->values())
            copyBlobFiles(value);
    }
}

void RemoteIDBServer::receive(Decoder& decoder)
{
    auto op = decoder.u8();
    if (!op)
        return;
    Ref client = m_connectionToServer;
    auto result = [&](void (IDBConnectionToServer::*method)(const IDBResultData&)) {
        withArguments<IDBResultData>(decoder, [&](IDBResultData&& data) {
            copyBlobFiles(data);
            (client.get().*method)(data);
        });
    };
    switch (static_cast<IDBOp>(*op)) {
    case IDBOp::DidDeleteDatabase: return result(&IDBConnectionToServer::didDeleteDatabase);
    case IDBOp::DidOpenDatabase: return result(&IDBConnectionToServer::didOpenDatabase);
    case IDBOp::DidCreateObjectStore: return result(&IDBConnectionToServer::didCreateObjectStore);
    case IDBOp::DidDeleteObjectStore: return result(&IDBConnectionToServer::didDeleteObjectStore);
    case IDBOp::DidRenameObjectStore: return result(&IDBConnectionToServer::didRenameObjectStore);
    case IDBOp::DidClearObjectStore: return result(&IDBConnectionToServer::didClearObjectStore);
    case IDBOp::DidCreateIndex: return result(&IDBConnectionToServer::didCreateIndex);
    case IDBOp::DidDeleteIndex: return result(&IDBConnectionToServer::didDeleteIndex);
    case IDBOp::DidRenameIndex: return result(&IDBConnectionToServer::didRenameIndex);
    case IDBOp::DidPutOrAdd: return result(&IDBConnectionToServer::didPutOrAdd);
    case IDBOp::DidGetRecord: return result(&IDBConnectionToServer::didGetRecord);
    case IDBOp::DidGetAllRecords: return result(&IDBConnectionToServer::didGetAllRecords);
    case IDBOp::DidGetCount: return result(&IDBConnectionToServer::didGetCount);
    case IDBOp::DidDeleteRecord: return result(&IDBConnectionToServer::didDeleteRecord);
    case IDBOp::DidOpenCursor: return result(&IDBConnectionToServer::didOpenCursor);
    case IDBOp::DidIterateCursor: return result(&IDBConnectionToServer::didIterateCursor);
    case IDBOp::DidAbortTransaction:
        return withArguments<IDBResourceIdentifier, IDBError>(decoder, [&](auto&& id, auto&& error) { client->didAbortTransaction(id, error); });
    case IDBOp::DidCommitTransaction:
        return withArguments<IDBResourceIdentifier, IDBError>(decoder, [&](auto&& id, auto&& error) { client->didCommitTransaction(id, error); });
    case IDBOp::DidStartTransaction:
        return withArguments<IDBResourceIdentifier, IDBError>(decoder, [&](auto&& id, auto&& error) { client->didStartTransaction(id, error); });
    case IDBOp::FireVersionChangeEvent:
        return withArguments<IDBDatabaseConnectionIdentifier, IDBResourceIdentifier, uint64_t>(decoder, [&](auto&& connection, auto&& request, auto&& version) { client->fireVersionChangeEvent(connection, request, version); });
    case IDBOp::GenerateIndexKeyForRecord:
        return withArguments<IDBResourceIdentifier, IDBIndexInfo, std::optional<IDBKeyPath>, IDBKeyData, IDBValue, std::optional<int64_t>>(decoder, [&](auto&& request, auto&& info, auto&& keyPath, auto&& key, auto&& value, auto&& recordID) {
            client->generateIndexKeyForRecord(request, info, keyPath, key, value, recordID);
        });
    case IDBOp::DidCloseFromServer:
        return withArguments<IDBDatabaseConnectionIdentifier, IDBError>(decoder, [&](auto&& connection, auto&& error) { client->didCloseFromServer(connection, error); });
    case IDBOp::NotifyOpenDBRequestBlocked:
        return withArguments<IDBResourceIdentifier, uint64_t, uint64_t>(decoder, [&](auto&& request, auto&& oldVersion, auto&& newVersion) { client->notifyOpenDBRequestBlocked(request, oldVersion, newVersion); });
    case IDBOp::DidGetAllDatabaseNamesAndVersions:
        return withArguments<IDBResourceIdentifier, Vector<IDBDatabaseNameAndVersion>>(decoder, [&](auto&& request, auto&& databases) { client->didGetAllDatabaseNamesAndVersions(request, WTF::move(databases)); });
    default:
        return;
    }
}

// Service side: one IDB server for the profile; each content engine is one
// of its client connections, under the identifier it said hello with.
class ServiceIDB;

class ServiceIDBClient final : public RefCounted<ServiceIDBClient>, public IDBServer::IDBConnectionToClientDelegate {
    WTF_DEPRECATED_MAKE_FAST_ALLOCATED(ServiceIDBClient);
    WTF_OVERRIDE_DELETE_FOR_CHECKED_PTR(ServiceIDBClient);
public:
    static Ref<ServiceIDBClient> create(Link& link, IDBConnectionIdentifier identifier) { return adoptRef(*new ServiceIDBClient(link, identifier)); }

    IDBServer::IDBConnectionToClient& connection() { return m_connection.get(); }
    IDBConnectionIdentifier connectionIdentifier() const { return m_identifier; }

private:
    ServiceIDBClient(Link& link, IDBConnectionIdentifier identifier)
        : m_link(&link)
        , m_identifier(identifier)
        , m_connection(IDBServer::IDBConnectionToClient::create(*this))
    {
    }

    template<typename... Arguments> void send(IDBOp op, const Arguments&... arguments)
    {
        m_link->send(Message::IDBToClient, idbFrame(op, arguments...));
    }

    std::optional<IDBConnectionIdentifier> identifier() const final { return m_identifier; }

    void didDeleteDatabase(const IDBResultData& result) final { send(IDBOp::DidDeleteDatabase, result); }
    void didOpenDatabase(const IDBResultData& result) final { send(IDBOp::DidOpenDatabase, result); }
    void didAbortTransaction(const IDBResourceIdentifier& id, const IDBError& error) final { send(IDBOp::DidAbortTransaction, id, error); }
    void didCommitTransaction(const IDBResourceIdentifier& id, const IDBError& error) final { send(IDBOp::DidCommitTransaction, id, error); }
    void didCreateObjectStore(const IDBResultData& result) final { send(IDBOp::DidCreateObjectStore, result); }
    void didDeleteObjectStore(const IDBResultData& result) final { send(IDBOp::DidDeleteObjectStore, result); }
    void didRenameObjectStore(const IDBResultData& result) final { send(IDBOp::DidRenameObjectStore, result); }
    void didClearObjectStore(const IDBResultData& result) final { send(IDBOp::DidClearObjectStore, result); }
    void didCreateIndex(const IDBResultData& result) final { send(IDBOp::DidCreateIndex, result); }
    void didDeleteIndex(const IDBResultData& result) final { send(IDBOp::DidDeleteIndex, result); }
    void didRenameIndex(const IDBResultData& result) final { send(IDBOp::DidRenameIndex, result); }
    void didPutOrAdd(const IDBResultData& result) final { send(IDBOp::DidPutOrAdd, result); }
    void didGetRecord(const IDBResultData& result) final { send(IDBOp::DidGetRecord, result); }
    void didGetAllRecords(const IDBResultData& result) final { send(IDBOp::DidGetAllRecords, result); }
    void didGetCount(const IDBResultData& result) final { send(IDBOp::DidGetCount, result); }
    void didDeleteRecord(const IDBResultData& result) final { send(IDBOp::DidDeleteRecord, result); }
    void didOpenCursor(const IDBResultData& result) final { send(IDBOp::DidOpenCursor, result); }
    void didIterateCursor(const IDBResultData& result) final { send(IDBOp::DidIterateCursor, result); }
    void fireVersionChangeEvent(IDBServer::UniqueIDBDatabaseConnection& connection, const IDBResourceIdentifier& request, uint64_t version) final
    {
        send(IDBOp::FireVersionChangeEvent, connection.identifier(), request, version);
    }
    void generateIndexKeyForRecord(const IDBResourceIdentifier& request, const IDBIndexInfo& info, const std::optional<IDBKeyPath>& keyPath, const IDBKeyData& key, const IDBValue& value, std::optional<int64_t> recordID) final
    {
        send(IDBOp::GenerateIndexKeyForRecord, request, info, keyPath, key, value, recordID);
    }
    void didStartTransaction(const IDBResourceIdentifier& id, const IDBError& error) final { send(IDBOp::DidStartTransaction, id, error); }
    void didCloseFromServer(IDBServer::UniqueIDBDatabaseConnection& connection, const IDBError& error) final { send(IDBOp::DidCloseFromServer, connection.identifier(), error); }
    void notifyOpenDBRequestBlocked(const IDBResourceIdentifier& request, uint64_t oldVersion, uint64_t newVersion) final { send(IDBOp::NotifyOpenDBRequestBlocked, request, oldVersion, newVersion); }
    void didGetAllDatabaseNamesAndVersions(const IDBResourceIdentifier& request, Vector<IDBDatabaseNameAndVersion>&& databases) final { send(IDBOp::DidGetAllDatabaseNamesAndVersions, request, databases); }

    RefPtr<Link> m_link;
    IDBConnectionIdentifier m_identifier;
    Ref<IDBServer::IDBConnectionToClient> m_connection;
};

class ServiceIDB {
public:
    static ServiceIDB& singleton()
    {
        static NeverDestroyed<ServiceIDB> service;
        return service;
    }

    void hello(Link& link, IDBConnectionIdentifier identifier)
    {
        if (m_clients.contains(link.id()))
            return;
        // An identifier another engine already speaks for is not given out.
        for (auto& client : m_clients.values()) {
            if (client->connectionIdentifier() == identifier)
                return;
        }
        Ref client = ServiceIDBClient::create(link, identifier);
        Locker locker { m_lock };
        server().registerConnection(client->connection());
        m_clients.add(link.id(), WTF::move(client));
    }

    void closed(Link& link)
    {
        auto client = m_clients.take(link.id());
        if (!client)
            return;
        Locker locker { m_lock };
        client->connection().connectionToClientClosed();
        server().unregisterConnection(client->connection());
    }

    void receive(Link&, Decoder&);

private:
    friend class NeverDestroyed<ServiceIDB>;
    ServiceIDB() = default;

    IDBServer::IDBServer& server()
    {
        if (!m_server)
            m_server = makeUnique<IDBServer::IDBServer>(Profile::file("indexeddb"_s), [](const ClientOrigin&, uint64_t) { return true; }, m_lock);
        return *m_server;
    }

    Lock m_lock;
    std::unique_ptr<IDBServer::IDBServer> m_server;
    HashMap<unsigned, Ref<ServiceIDBClient>> m_clients;
};

void ServiceIDB::receive(Link& link, Decoder& decoder)
{
    auto it = m_clients.find(link.id());
    auto op = decoder.u8();
    if (it == m_clients.end() || !op)
        return;
    auto identifier = it->value->connectionIdentifier();
    // A content engine acts only for its own connection.
    auto mine = [&](IDBConnectionIdentifier connection) { return connection == identifier; };
    auto ownsResource = [&](const IDBResourceIdentifier& resource) { return resource.connectionIdentifier() == identifier; };
    Locker locker { m_lock };
    auto& server = this->server();
    switch (static_cast<IDBOp>(*op)) {
    case IDBOp::DeleteDatabase:
        return withArguments<IDBOpenRequestData>(decoder, [&](auto&& data) { if (mine(data.serverConnectionIdentifier())) server.deleteDatabase(data); });
    case IDBOp::OpenDatabase:
        return withArguments<IDBOpenRequestData>(decoder, [&](auto&& data) { if (mine(data.serverConnectionIdentifier())) server.openDatabase(data); });
    case IDBOp::OpenDBRequestCancelled:
        return withArguments<IDBOpenRequestData>(decoder, [&](auto&& data) { if (mine(data.serverConnectionIdentifier())) server.openDBRequestCancelled(data); });
    case IDBOp::AbortTransaction:
        return withArguments<IDBResourceIdentifier>(decoder, [&](auto&& id) { if (ownsResource(id)) server.abortTransaction(id); });
    case IDBOp::CommitTransaction:
        return withArguments<IDBResourceIdentifier, uint64_t>(decoder, [&](auto&& id, auto&& count) { if (ownsResource(id)) server.commitTransaction(id, count); });
    case IDBOp::DidFinishHandlingVersionChangeTransaction:
        return withArguments<IDBDatabaseConnectionIdentifier, IDBResourceIdentifier>(decoder, [&](auto&& connection, auto&& id) { if (ownsResource(id)) server.didFinishHandlingVersionChangeTransaction(connection, id); });
    case IDBOp::CreateObjectStore:
        return withArguments<IDBRequestData, IDBObjectStoreInfo>(decoder, [&](auto&& request, auto&& info) { if (mine(request.serverConnectionIdentifier())) server.createObjectStore(request, info); });
    case IDBOp::DeleteObjectStore:
        return withArguments<IDBRequestData, String>(decoder, [&](auto&& request, auto&& name) { if (mine(request.serverConnectionIdentifier())) server.deleteObjectStore(request, name); });
    case IDBOp::RenameObjectStore:
        return withArguments<IDBRequestData, IDBObjectStoreIdentifier, String>(decoder, [&](auto&& request, auto&& store, auto&& name) { if (mine(request.serverConnectionIdentifier())) server.renameObjectStore(request, store, name); });
    case IDBOp::ClearObjectStore:
        return withArguments<IDBRequestData, IDBObjectStoreIdentifier>(decoder, [&](auto&& request, auto&& store) { if (mine(request.serverConnectionIdentifier())) server.clearObjectStore(request, store); });
    case IDBOp::CreateIndex:
        return withArguments<IDBRequestData, IDBIndexInfo>(decoder, [&](auto&& request, auto&& info) { if (mine(request.serverConnectionIdentifier())) server.createIndex(request, info); });
    case IDBOp::DeleteIndex:
        return withArguments<IDBRequestData, IDBObjectStoreIdentifier, String>(decoder, [&](auto&& request, auto&& store, auto&& name) { if (mine(request.serverConnectionIdentifier())) server.deleteIndex(request, store, name); });
    case IDBOp::RenameIndex:
        return withArguments<IDBRequestData, IDBObjectStoreIdentifier, IDBIndexIdentifier, String>(decoder, [&](auto&& request, auto&& store, auto&& index, auto&& name) { if (mine(request.serverConnectionIdentifier())) server.renameIndex(request, store, index, name); });
    case IDBOp::PutOrAdd:
        return withArguments<IDBRequestData, IDBKeyData, IDBValue, IndexIDToIndexKeyMap, IndexedDB::ObjectStoreOverwriteMode>(decoder, [&](auto&& request, auto&& key, auto&& value, auto&& indexKeys, auto&& mode) {
            if (mine(request.serverConnectionIdentifier()))
                server.putOrAdd(request, key, value, indexKeys, mode);
        });
    case IDBOp::GetRecord:
        return withArguments<IDBRequestData, IDBGetRecordData>(decoder, [&](auto&& request, auto&& data) { if (mine(request.serverConnectionIdentifier())) server.getRecord(request, data); });
    case IDBOp::GetAllRecords:
        return withArguments<IDBRequestData, IDBGetAllRecordsData>(decoder, [&](auto&& request, auto&& data) { if (mine(request.serverConnectionIdentifier())) server.getAllRecords(request, data); });
    case IDBOp::GetCount:
        return withArguments<IDBRequestData, IDBKeyRangeData>(decoder, [&](auto&& request, auto&& range) { if (mine(request.serverConnectionIdentifier())) server.getCount(request, range); });
    case IDBOp::DeleteRecord:
        return withArguments<IDBRequestData, IDBKeyRangeData>(decoder, [&](auto&& request, auto&& range) { if (mine(request.serverConnectionIdentifier())) server.deleteRecord(request, range); });
    case IDBOp::OpenCursor:
        return withArguments<IDBRequestData, IDBCursorInfo>(decoder, [&](auto&& request, auto&& info) { if (mine(request.serverConnectionIdentifier())) server.openCursor(request, info); });
    case IDBOp::IterateCursor:
        return withArguments<IDBRequestData, IDBIterateCursorData>(decoder, [&](auto&& request, auto&& data) { if (mine(request.serverConnectionIdentifier())) server.iterateCursor(request, data); });
    case IDBOp::EstablishTransaction:
        return withArguments<IDBDatabaseConnectionIdentifier, IDBTransactionInfo>(decoder, [&](auto&& connection, auto&& info) { if (ownsResource(info.identifier())) server.establishTransaction(connection, info); });
    case IDBOp::DatabaseConnectionPendingClose:
        return withArguments<IDBDatabaseConnectionIdentifier>(decoder, [&](auto&& connection) { server.databaseConnectionPendingClose(connection); });
    case IDBOp::DatabaseConnectionClosed:
        return withArguments<IDBDatabaseConnectionIdentifier>(decoder, [&](auto&& connection) { server.databaseConnectionClosed(connection); });
    case IDBOp::AbortOpenAndUpgradeNeeded:
        return withArguments<IDBDatabaseConnectionIdentifier, std::optional<IDBResourceIdentifier>>(decoder, [&](auto&& connection, auto&& transaction) { server.abortOpenAndUpgradeNeeded(connection, transaction); });
    case IDBOp::DidFireVersionChangeEvent:
        return withArguments<IDBDatabaseConnectionIdentifier, IDBResourceIdentifier, IndexedDB::ConnectionClosedOnBehalfOfServer>(decoder, [&](auto&& connection, auto&& request, auto&& closed) { server.didFireVersionChangeEvent(connection, request, closed); });
    case IDBOp::DidGenerateIndexKeyForRecord:
        return withArguments<IDBResourceIdentifier, IDBResourceIdentifier, IDBIndexInfo, IDBKeyData, IndexKey, std::optional<int64_t>>(decoder, [&](auto&& transaction, auto&& request, auto&& info, auto&& key, auto&& indexKey, auto&& recordID) {
            if (ownsResource(transaction))
                server.didGenerateIndexKeyForRecord(transaction, request, info, key, indexKey, recordID);
        });
    case IDBOp::GetAllDatabaseNamesAndVersions:
        return withArguments<IDBResourceIdentifier, ClientOrigin>(decoder, [&](auto&& request, auto&& origin) { if (ownsResource(request)) server.getAllDatabaseNamesAndVersions(identifier, request, origin); });
    default:
        return;
    }
}

// Where a content engine may read blob files from: the service's temporary
// blob files and its IndexedDB directory, nothing else of the profile.
static bool isBlobFilePath(const String& path)
{
    if (path.contains(".."_s))
        return false;
    return path.startsWith("/tmp/Blob"_s) || path.startsWith(makeString(Profile::file("indexeddb"_s), '/'));
}

void installIDBService()
{
    // {[bytes]} -> {[path]}: blobs a content engine stores in a record
    // become files here, as the IDB server expects.
    Link::handleCall(Message::IDBBlobWrite, [](Link&, Decoder& decoder, Reply&& reply) {
        auto blobs = decoder.decode<Vector<Vector<uint8_t>>>();
        if (!blobs)
            return;
        Vector<String> paths;
        for (auto& bytes : *blobs) {
            auto [path, file] = FileSystem::openTemporaryFile("Blob"_s);
            if (!file || file.write(bytes.span()) != bytes.size())
                return;
            paths.append(WTF::move(path));
        }
        Encoder encoder;
        encoder << paths;
        reply.send(WTF::move(encoder));
    });
    // {path} -> {bytes}
    Link::handleSync(Message::IDBBlobRead, [](Link&, Decoder& decoder, Encoder& reply) {
        auto path = decoder.string();
        if (!path || !isBlobFilePath(*path))
            return false;
        auto bytes = FileSystem::readEntireFile(*path);
        if (!bytes)
            return false;
        reply.bytes(bytes->span());
        return true;
    });
    // {identifier}: the IDB connection a content engine speaks for.
    Link::handle(Message::IDBHello, [](Link& link, Decoder& decoder) {
        if (auto identifier = decoder.decode<IDBConnectionIdentifier>())
            ServiceIDB::singleton().hello(link, *identifier);
    });
    Link::handle(Message::IDBToServer, [](Link& link, Decoder& decoder) {
        ServiceIDB::singleton().receive(link, decoder);
    });
    Link::addCloseObserver([](Link& link) {
        if (link.isServiceEnd())
            ServiceIDB::singleton().closed(link);
    });
}

void installIDBProxy()
{
    // A content engine's IDB connection says who it is: unique among the
    // service's content engines (the host gives each engine its number).
    Link::handle(Message::IDBToClient, [](Link&, Decoder& decoder) {
        RemoteIDBServer::singleton().receive(decoder);
    });
    Link::addCloseObserver([](Link& link) {
        if (!link.isServiceEnd())
            RemoteIDBServer::singleton().lost();
    });
}

class IDBDatabaseProvider final : public DatabaseProvider {
public:
    IDBConnectionToServer& idbConnectionToServerForSession(PAL::SessionID) final
    {
        if (role() == Role::Content)
            return RemoteIDBServer::singleton().connectionToServer();
        if (!m_server)
            m_server = LocalIDBServer::create();
        return m_server->connectionToServer();
    }

private:
    RefPtr<LocalIDBServer> m_server;
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
