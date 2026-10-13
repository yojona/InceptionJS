#include "config.h"
#include "link/IDBCoders.h"

#include "ClientOrigin.h"
#include "IDBCursorRecord.h"
#include "IDBGetAllResult.h"
#include "IDBGetResult.h"
#include "SecurityOriginData.h"
#include "ThreadSafeDataBuffer.h"
#include <wtf/ArgumentCoder.h>

using namespace WebCore;
using Inception::Decoder;
using Inception::Encoder;

namespace Inception {

template<> struct EnumLimit<IndexedDB::RequestType> {
    static constexpr std::optional<uint64_t> max = static_cast<uint64_t>(IndexedDB::RequestType::Other);
};
template<> struct EnumLimit<IndexedDB::CursorDirection> {
    static constexpr std::optional<uint64_t> max = static_cast<uint64_t>(IndexedDB::CursorDirection::Prevunique);
};
template<> struct EnumLimit<IDBTransactionMode> {
    static constexpr std::optional<uint64_t> max = static_cast<uint64_t>(IDBTransactionMode::Versionchange);
};
template<> struct EnumLimit<IDBTransactionDurability> {
    static constexpr std::optional<uint64_t> max = static_cast<uint64_t>(IDBTransactionDurability::Default);
};
template<> struct EnumLimit<IDBResultType> {
    static constexpr std::optional<uint64_t> max = static_cast<uint64_t>(IDBResultType::RenameIndexSuccess);
};
template<> struct EnumLimit<ExceptionCode> {
    static constexpr std::optional<uint64_t> max = static_cast<uint64_t>(ExceptionCode::ExistingExceptionError);
};

// Writes an optional value held by pointer, without copying it.
template<typename T> static void encodePointee(Encoder& encoder, const T* value)
{
    encoder.boolean(!!value);
    if (value)
        encoder << *value;
}

} // namespace Inception

// The types that let only their IPC coder build them. These are our coders
// for them (WebKit's own generated ones are not part of this build).
namespace IPC {

template<> struct ArgumentCoder<ThreadSafeDataBuffer> {
    static void encode(Inception::Encoder& encoder, const ThreadSafeDataBuffer& buffer)
    {
        auto* data = buffer.data();
        encoder.boolean(!!data);
        if (data)
            encoder.bytes(data->span());
    }
    static std::optional<ThreadSafeDataBuffer> decode(Inception::Decoder& decoder)
    {
        auto present = decoder.boolean();
        if (!present)
            return std::nullopt;
        if (!*present)
            return ThreadSafeDataBuffer { };
        auto bytes = decoder.bytes();
        if (!bytes)
            return std::nullopt;
        return ThreadSafeDataBuffer::create(WTF::move(*bytes));
    }
};

template<> struct ArgumentCoder<IDBResourceIdentifier> {
    static void encode(Inception::Encoder& encoder, const IDBResourceIdentifier& identifier)
    {
        encoder << identifier.m_idbConnectionIdentifier.asOptional() << identifier.m_resourceNumber.asOptional();
    }
    static std::optional<IDBResourceIdentifier> decode(Inception::Decoder& decoder)
    {
        auto connection = decoder.decode<std::optional<IDBConnectionIdentifier>>();
        auto number = connection ? decoder.decode<std::optional<IDBResourceObjectIdentifier>>() : std::nullopt;
        if (!number)
            return std::nullopt;
        return IDBResourceIdentifier { *connection, *number };
    }
};

template<> struct ArgumentCoder<IDBOpenRequestData> {
    static void encode(Inception::Encoder& encoder, const IDBOpenRequestData& data)
    {
        encoder << data.m_serverConnectionIdentifier << data.m_requestIdentifier << data.m_databaseIdentifier << data.m_requestedVersion << data.m_requestType;
    }
    static std::optional<IDBOpenRequestData> decode(Inception::Decoder& decoder)
    {
        auto connection = decoder.decode<IDBConnectionIdentifier>();
        auto request = decoder.decode<IDBResourceIdentifier>();
        auto database = decoder.decode<IDBDatabaseIdentifier>();
        auto version = decoder.u64();
        auto type = decoder.decode<IndexedDB::RequestType>();
        if (!type)
            return std::nullopt;
        return IDBOpenRequestData { *connection, *request, WTF::move(*database), *version, *type };
    }
};

template<> struct ArgumentCoder<IDBRequestData> {
    static void encode(Inception::Encoder& encoder, const IDBRequestData& data)
    {
        encoder << data.m_serverConnectionIdentifier << data.m_requestIdentifier << data.m_transactionIdentifier << data.m_cursorIdentifier;
        encoder << data.m_objectStoreIdentifier.asOptional() << data.m_indexIdentifier.asOptional();
        encoder << data.m_indexRecordType << data.m_requestedVersion << data.m_requestType;
    }
    static std::optional<IDBRequestData> decode(Inception::Decoder& decoder)
    {
        auto connection = decoder.decode<IDBConnectionIdentifier>();
        auto request = decoder.decode<IDBResourceIdentifier>();
        auto transaction = decoder.decode<IDBResourceIdentifier>();
        auto cursor = decoder.decode<std::optional<IDBResourceIdentifier>>();
        auto store = decoder.decode<std::optional<IDBObjectStoreIdentifier>>();
        auto index = decoder.decode<std::optional<IDBIndexIdentifier>>();
        auto recordType = decoder.decode<IndexedDB::IndexRecordType>();
        auto version = decoder.u64();
        auto type = decoder.decode<IndexedDB::RequestType>();
        if (!type)
            return std::nullopt;
        return IDBRequestData { *connection, *request, *transaction, WTF::move(*cursor), *store, *index, *recordType, *version, *type };
    }
};

template<> struct ArgumentCoder<IDBDatabaseInfo> {
    static void encode(Inception::Encoder& encoder, const IDBDatabaseInfo& info)
    {
        encoder << info.m_name << info.m_version << info.m_maxIndexID;
        encoder.u32(info.m_objectStoreMap.size());
        for (auto& store : info.m_objectStoreMap.values())
            encoder << store;
    }
    static std::optional<IDBDatabaseInfo> decode(Inception::Decoder& decoder)
    {
        auto name = decoder.string();
        auto version = decoder.u64();
        auto maxIndexID = decoder.u64();
        auto count = maxIndexID ? decoder.count(8) : std::nullopt;
        if (!count)
            return std::nullopt;
        IDBDatabaseInfo info;
        info.m_name = WTF::move(*name);
        info.m_version = *version;
        info.m_maxIndexID = *maxIndexID;
        for (uint32_t i = 0; i < *count; ++i) {
            auto store = decoder.decode<IDBObjectStoreInfo>();
            if (!store)
                return std::nullopt;
            auto identifier = store->identifier();
            info.m_objectStoreMap.set(identifier, WTF::move(*store));
        }
        return info;
    }
};

template<> struct ArgumentCoder<IDBCursorInfo> {
    static void encode(Inception::Encoder& encoder, const IDBCursorInfo& info)
    {
        encoder << info.m_cursorIdentifier << info.m_transactionIdentifier << info.m_objectStoreIdentifier;
        WTF::switchOn(info.m_sourceIdentifier,
            [&](IDBObjectStoreIdentifier store) { encoder.u8(0); encoder << store; },
            [&](IDBIndexIdentifier index) { encoder.u8(1); encoder << index; });
        encoder << info.m_range << info.m_source << info.m_direction << info.m_type;
    }
    static std::optional<IDBCursorInfo> decode(Inception::Decoder& decoder)
    {
        auto cursor = decoder.decode<IDBResourceIdentifier>();
        auto transaction = decoder.decode<IDBResourceIdentifier>();
        auto store = decoder.decode<IDBObjectStoreIdentifier>();
        auto sourceKind = decoder.u8();
        if (!sourceKind || *sourceKind > 1) {
            decoder.fail();
            return std::nullopt;
        }
        std::optional<Variant<IDBObjectStoreIdentifier, IDBIndexIdentifier>> source;
        if (!*sourceKind) {
            if (auto value = decoder.decode<IDBObjectStoreIdentifier>())
                source = *value;
        } else if (auto value = decoder.decode<IDBIndexIdentifier>())
            source = *value;
        auto range = decoder.decode<IDBKeyRangeData>();
        auto cursorSource = decoder.decode<IndexedDB::CursorSource>();
        auto direction = decoder.decode<IndexedDB::CursorDirection>();
        auto type = decoder.decode<IndexedDB::CursorType>();
        if (!type || !source)
            return std::nullopt;
        return IDBCursorInfo { *cursor, *transaction, *store, WTF::move(*source), *range, *cursorSource, *direction, *type };
    }
};

template<> struct ArgumentCoder<IDBGetAllResult> {
    static void encode(Inception::Encoder& encoder, const IDBGetAllResult& result)
    {
        encoder << result.m_type << result.m_keys << result.m_values << result.m_keyPath;
    }
    static std::optional<IDBGetAllResult> decode(Inception::Decoder& decoder)
    {
        auto type = decoder.decode<IndexedDB::GetAllType>();
        auto keys = decoder.decode<Vector<IDBKeyData>>();
        auto values = keys ? decoder.decode<Vector<IDBValue>>() : std::nullopt;
        auto keyPath = values ? decoder.decode<std::optional<IDBKeyPath>>() : std::nullopt;
        if (!keyPath)
            return std::nullopt;
        return IDBGetAllResult { *type, WTF::move(*keys), WTF::move(*values), WTF::move(*keyPath) };
    }
};

template<> struct ArgumentCoder<IDBResultData> {
    static const IDBGetResult* getResult(const IDBResultData& result) { return result.m_getResult.get(); }
    static const IDBGetAllResult* getAllResult(const IDBResultData& result) { return result.m_getAllResult.get(); }
    static void encode(Inception::Encoder& encoder, const IDBResultData& result)
    {
        encoder << result.m_type << result.m_requestIdentifier << result.m_error << result.m_databaseConnectionIdentifier << result.m_resultInteger;
        Inception::encodePointee(encoder, result.m_databaseInfo.get());
        Inception::encodePointee(encoder, result.m_transactionInfo.get());
        Inception::encodePointee(encoder, result.m_resultKey.get());
        Inception::encodePointee(encoder, result.m_getResult.get());
        Inception::encodePointee(encoder, result.m_getAllResult.get());
    }
    static std::optional<IDBResultData> decode(Inception::Decoder& decoder)
    {
        auto type = decoder.decode<IDBResultType>();
        auto request = decoder.decode<IDBResourceIdentifier>();
        auto error = decoder.decode<IDBError>();
        auto connection = decoder.decode<std::optional<IDBDatabaseConnectionIdentifier>>();
        auto integer = decoder.u64();
        auto databaseInfo = integer ? decoder.decode<std::optional<IDBDatabaseInfo>>() : std::nullopt;
        auto transactionInfo = databaseInfo ? decoder.decode<std::optional<IDBTransactionInfo>>() : std::nullopt;
        auto resultKey = transactionInfo ? decoder.decode<std::optional<IDBKeyData>>() : std::nullopt;
        auto getResult = resultKey ? decoder.decode<std::optional<IDBGetResult>>() : std::nullopt;
        auto getAllResult = getResult ? decoder.decode<std::optional<IDBGetAllResult>>() : std::nullopt;
        if (!getAllResult)
            return std::nullopt;
        IDBResultData result { *type, *request };
        result.m_error = WTF::move(*error);
        result.m_databaseConnectionIdentifier = *connection;
        result.m_resultInteger = *integer;
        if (*databaseInfo)
            result.m_databaseInfo = makeUnique<IDBDatabaseInfo>(WTF::move(**databaseInfo));
        if (*transactionInfo)
            result.m_transactionInfo = makeUnique<IDBTransactionInfo>(WTF::move(**transactionInfo));
        if (*resultKey)
            result.m_resultKey = makeUnique<IDBKeyData>(WTF::move(**resultKey));
        if (*getResult)
            result.m_getResult = makeUnique<IDBGetResult>(WTF::move(**getResult));
        if (*getAllResult)
            result.m_getAllResult = makeUnique<IDBGetAllResult>(WTF::move(**getAllResult));
        return result;
    }
};

} // namespace IPC

namespace Inception {

const IDBGetResult* getResultOf(const IDBResultData& result)
{
    return IPC::ArgumentCoder<IDBResultData>::getResult(result);
}

const IDBGetAllResult* getAllResultOf(const IDBResultData& result)
{
    return IPC::ArgumentCoder<IDBResultData>::getAllResult(result);
}

#define INCEPTION_IPC_CODER(Type) \
    void Coder<Type>::encode(Encoder& encoder, const Type& value) { IPC::ArgumentCoder<Type>::encode(encoder, value); } \
    std::optional<Type> Coder<Type>::decode(Decoder& decoder) { return IPC::ArgumentCoder<Type>::decode(decoder); }

INCEPTION_IPC_CODER(ThreadSafeDataBuffer)
INCEPTION_IPC_CODER(IDBResourceIdentifier)
INCEPTION_IPC_CODER(IDBOpenRequestData)
INCEPTION_IPC_CODER(IDBRequestData)
INCEPTION_IPC_CODER(IDBDatabaseInfo)
INCEPTION_IPC_CODER(IDBCursorInfo)
INCEPTION_IPC_CODER(IDBGetAllResult)
INCEPTION_IPC_CODER(IDBResultData)

#undef INCEPTION_IPC_CODER

// Origins: a tuple (scheme, host, port); empty is an empty origin; an opaque
// origin never crosses.
void Coder<SecurityOriginData>::encode(Encoder& encoder, const SecurityOriginData& origin)
{
    if (origin.isNull() || origin.isOpaque()) {
        encoder.u8(origin.isOpaque() ? 2 : 0);
        return;
    }
    encoder.u8(1);
    encoder << origin.protocol() << origin.host() << origin.port();
}

std::optional<SecurityOriginData> Coder<SecurityOriginData>::decode(Decoder& decoder)
{
    auto kind = decoder.u8();
    if (!kind)
        return std::nullopt;
    if (!*kind)
        return SecurityOriginData { };
    if (*kind != 1) {
        decoder.fail();
        return std::nullopt;
    }
    auto protocol = decoder.string();
    auto host = decoder.string();
    auto port = decoder.decode<std::optional<uint16_t>>();
    if (!port)
        return std::nullopt;
    return SecurityOriginData { *protocol, *host, *port };
}

void Coder<ClientOrigin>::encode(Encoder& encoder, const ClientOrigin& origin)
{
    encoder << origin.topOrigin << origin.clientOrigin;
}

std::optional<ClientOrigin> Coder<ClientOrigin>::decode(Decoder& decoder)
{
    auto top = decoder.decode<SecurityOriginData>();
    auto client = top ? decoder.decode<SecurityOriginData>() : std::nullopt;
    if (!client)
        return std::nullopt;
    return ClientOrigin { WTF::move(*top), WTF::move(*client) };
}

void Coder<IDBKeyPath>::encode(Encoder& encoder, const IDBKeyPath& path)
{
    WTF::switchOn(path,
        [&](const String& string) { encoder.u8(0); encoder << string; },
        [&](const Vector<String>& strings) { encoder.u8(1); encoder << strings; });
}

std::optional<IDBKeyPath> Coder<IDBKeyPath>::decode(Decoder& decoder)
{
    auto kind = decoder.u8();
    if (!kind)
        return std::nullopt;
    if (!*kind) {
        auto string = decoder.string();
        if (!string)
            return std::nullopt;
        return IDBKeyPath { WTF::move(*string) };
    }
    if (*kind != 1) {
        decoder.fail();
        return std::nullopt;
    }
    auto strings = decoder.decode<Vector<String>>();
    if (!strings)
        return std::nullopt;
    return IDBKeyPath { WTF::move(*strings) };
}

// Keys nest (arrays of keys); deeper than this is refused rather than
// recursed into.
static constexpr unsigned maxKeyDepth = 256;

enum class KeyKind : uint8_t { Null, Invalid, Array, String, Number, Date, Binary, Min, Max };

static void encodeKey(Encoder& encoder, const IDBKeyData& key)
{
    encoder.boolean(key.isPlaceholder());
    WTF::switchOn(key.value(),
        [&](std::nullptr_t) { encoder.u8(static_cast<uint8_t>(KeyKind::Null)); },
        [&](const IDBKeyData::Invalid&) { encoder.u8(static_cast<uint8_t>(KeyKind::Invalid)); },
        [&](const Vector<IDBKeyData>& array) {
            encoder.u8(static_cast<uint8_t>(KeyKind::Array));
            encoder.u32(array.size());
            for (auto& item : array)
                encodeKey(encoder, item);
        },
        [&](const String& string) { encoder.u8(static_cast<uint8_t>(KeyKind::String)); encoder << string; },
        [&](double number) { encoder.u8(static_cast<uint8_t>(KeyKind::Number)); encoder.f64(number); },
        [&](const IDBKeyData::Date& date) { encoder.u8(static_cast<uint8_t>(KeyKind::Date)); encoder.f64(date.value); },
        [&](const ThreadSafeDataBuffer& buffer) { encoder.u8(static_cast<uint8_t>(KeyKind::Binary)); encoder << buffer; },
        [&](const IDBKeyData::Min&) { encoder.u8(static_cast<uint8_t>(KeyKind::Min)); },
        [&](const IDBKeyData::Max&) { encoder.u8(static_cast<uint8_t>(KeyKind::Max)); });
}

static std::optional<IDBKeyData> decodeKey(Decoder& decoder, unsigned depth)
{
    auto placeholder = decoder.boolean();
    auto kind = placeholder ? decoder.u8() : std::nullopt;
    if (!kind)
        return std::nullopt;
    auto key = [&](IDBKeyData::ValueVariant&& value) -> std::optional<IDBKeyData> {
        if (decoder.failed())
            return std::nullopt;
        return IDBKeyData { *placeholder, WTF::move(value) };
    };
    switch (static_cast<KeyKind>(*kind)) {
    case KeyKind::Null:
        return key(nullptr);
    case KeyKind::Invalid:
        return key(IDBKeyData::Invalid { });
    case KeyKind::Array: {
        auto count = depth < maxKeyDepth ? decoder.count(2) : std::nullopt;
        if (!count) {
            decoder.fail();
            return std::nullopt;
        }
        Vector<IDBKeyData> array;
        array.reserveInitialCapacity(*count);
        for (uint32_t i = 0; i < *count; ++i) {
            auto item = decodeKey(decoder, depth + 1);
            if (!item)
                return std::nullopt;
            array.append(WTF::move(*item));
        }
        return key(WTF::move(array));
    }
    case KeyKind::String: {
        auto string = decoder.string();
        if (!string)
            return std::nullopt;
        return key(WTF::move(*string));
    }
    case KeyKind::Number: {
        auto number = decoder.f64();
        if (!number)
            return std::nullopt;
        return key(*number);
    }
    case KeyKind::Date: {
        auto date = decoder.f64();
        if (!date)
            return std::nullopt;
        return key(IDBKeyData::Date { *date });
    }
    case KeyKind::Binary: {
        auto buffer = decoder.decode<ThreadSafeDataBuffer>();
        if (!buffer)
            return std::nullopt;
        return key(WTF::move(*buffer));
    }
    case KeyKind::Min:
        return key(IDBKeyData::Min { });
    case KeyKind::Max:
        return key(IDBKeyData::Max { });
    }
    decoder.fail();
    return std::nullopt;
}

void Coder<IDBKeyData>::encode(Encoder& encoder, const IDBKeyData& key)
{
    encodeKey(encoder, key);
}

std::optional<IDBKeyData> Coder<IDBKeyData>::decode(Decoder& decoder)
{
    return decodeKey(decoder, 0);
}

void Coder<IDBKeyRangeData>::encode(Encoder& encoder, const IDBKeyRangeData& range)
{
    encoder << range.lowerKey << range.upperKey << range.lowerOpen << range.upperOpen;
}

std::optional<IDBKeyRangeData> Coder<IDBKeyRangeData>::decode(Decoder& decoder)
{
    auto lower = decoder.decode<IDBKeyData>();
    auto upper = lower ? decoder.decode<IDBKeyData>() : std::nullopt;
    auto lowerOpen = upper ? decoder.boolean() : std::nullopt;
    auto upperOpen = lowerOpen ? decoder.boolean() : std::nullopt;
    if (!upperOpen)
        return std::nullopt;
    return IDBKeyRangeData { WTF::move(*lower), WTF::move(*upper), *lowerOpen, *upperOpen };
}

void Coder<IDBValue>::encode(Encoder& encoder, const IDBValue& value)
{
    encoder << value.data() << value.blobURLs() << value.blobFilePaths();
}

std::optional<IDBValue> Coder<IDBValue>::decode(Decoder& decoder)
{
    auto data = decoder.decode<ThreadSafeDataBuffer>();
    auto urls = data ? decoder.decode<Vector<String>>() : std::nullopt;
    auto paths = urls ? decoder.decode<Vector<String>>() : std::nullopt;
    if (!paths)
        return std::nullopt;
    return IDBValue { *data, WTF::move(*urls), WTF::move(*paths) };
}

void Coder<IndexKey>::encode(Encoder& encoder, const IndexKey& key)
{
    WTF::switchOn(key.data(),
        [&](std::nullptr_t) { encoder.u8(0); },
        [&](const IDBKeyData& one) { encoder.u8(1); encoder << one; },
        [&](const Vector<IDBKeyData>& many) { encoder.u8(2); encoder << many; });
}

std::optional<IndexKey> Coder<IndexKey>::decode(Decoder& decoder)
{
    auto kind = decoder.u8();
    if (!kind)
        return std::nullopt;
    switch (*kind) {
    case 0:
        return IndexKey { nullptr };
    case 1:
        if (auto one = decoder.decode<IDBKeyData>())
            return IndexKey { WTF::move(*one) };
        return std::nullopt;
    case 2:
        if (auto many = decoder.decode<Vector<IDBKeyData>>())
            return IndexKey { WTF::move(*many) };
        return std::nullopt;
    }
    decoder.fail();
    return std::nullopt;
}

void Coder<IDBError>::encode(Encoder& encoder, const IDBError& error)
{
    encoder << error.code() << error.messageForSerialization();
}

std::optional<IDBError> Coder<IDBError>::decode(Decoder& decoder)
{
    auto code = decoder.decode<std::optional<ExceptionCode>>();
    auto message = code ? decoder.string() : std::nullopt;
    if (!message)
        return std::nullopt;
    return IDBError { *code, *message };
}

void Coder<IDBDatabaseIdentifier>::encode(Encoder& encoder, const IDBDatabaseIdentifier& identifier)
{
    encoder << identifier.databaseName() << identifier.origin() << identifier.isTransient();
}

std::optional<IDBDatabaseIdentifier> Coder<IDBDatabaseIdentifier>::decode(Decoder& decoder)
{
    auto name = decoder.string();
    auto origin = name ? decoder.decode<ClientOrigin>() : std::nullopt;
    auto transient = origin ? decoder.boolean() : std::nullopt;
    if (!transient)
        return std::nullopt;
    return IDBDatabaseIdentifier { *name, WTF::move(origin->clientOrigin), WTF::move(origin->topOrigin), *transient };
}

void Coder<IDBIndexInfo>::encode(Encoder& encoder, const IDBIndexInfo& info)
{
    encoder << info.identifier() << info.objectStoreIdentifier() << info.name() << info.keyPath() << info.unique() << info.multiEntry();
}

std::optional<IDBIndexInfo> Coder<IDBIndexInfo>::decode(Decoder& decoder)
{
    auto identifier = decoder.decode<IDBIndexIdentifier>();
    auto store = decoder.decode<IDBObjectStoreIdentifier>();
    auto name = decoder.string();
    auto keyPath = name ? decoder.decode<IDBKeyPath>() : std::nullopt;
    auto unique = keyPath ? decoder.boolean() : std::nullopt;
    auto multiEntry = unique ? decoder.boolean() : std::nullopt;
    if (!multiEntry)
        return std::nullopt;
    return IDBIndexInfo { *identifier, *store, *name, WTF::move(*keyPath), *unique, *multiEntry };
}

void Coder<IDBObjectStoreInfo>::encode(Encoder& encoder, const IDBObjectStoreInfo& info)
{
    encoder << info.identifier() << info.name() << info.keyPath() << info.autoIncrement();
    encoder.u32(info.indexMap().size());
    for (auto& index : info.indexMap().values())
        encoder << index;
}

std::optional<IDBObjectStoreInfo> Coder<IDBObjectStoreInfo>::decode(Decoder& decoder)
{
    auto identifier = decoder.decode<IDBObjectStoreIdentifier>();
    auto name = decoder.string();
    auto keyPath = name ? decoder.decode<std::optional<IDBKeyPath>>() : std::nullopt;
    auto autoIncrement = keyPath ? decoder.boolean() : std::nullopt;
    auto count = autoIncrement ? decoder.count(8) : std::nullopt;
    if (!count)
        return std::nullopt;
    HashMap<IDBIndexIdentifier, IDBIndexInfo> indexes;
    for (uint32_t i = 0; i < *count; ++i) {
        auto index = decoder.decode<IDBIndexInfo>();
        if (!index)
            return std::nullopt;
        auto key = index->identifier();
        indexes.set(key, WTF::move(*index));
    }
    return IDBObjectStoreInfo { *identifier, *name, WTF::move(*keyPath), *autoIncrement, WTF::move(indexes) };
}

void Coder<IDBTransactionInfo>::encode(Encoder& encoder, const IDBTransactionInfo& info)
{
    encoder << info.identifier() << info.mode() << info.durability() << info.newVersion() << info.objectStores();
    encodePointee(encoder, info.originalDatabaseInfo().get());
}

std::optional<IDBTransactionInfo> Coder<IDBTransactionInfo>::decode(Decoder& decoder)
{
    auto identifier = decoder.decode<IDBResourceIdentifier>();
    auto mode = decoder.decode<IDBTransactionMode>();
    auto durability = decoder.decode<IDBTransactionDurability>();
    auto version = decoder.u64();
    auto stores = version ? decoder.decode<Vector<String>>() : std::nullopt;
    auto original = stores ? decoder.decode<std::optional<IDBDatabaseInfo>>() : std::nullopt;
    if (!original)
        return std::nullopt;
    return IDBTransactionInfo { *identifier, *mode, *durability, *version, WTF::move(*stores), *original ? makeUnique<IDBDatabaseInfo>(WTF::move(**original)) : nullptr };
}

void Coder<IDBGetRecordData>::encode(Encoder& encoder, const IDBGetRecordData& data)
{
    encoder << data.keyRangeData << data.type;
}

std::optional<IDBGetRecordData> Coder<IDBGetRecordData>::decode(Decoder& decoder)
{
    auto range = decoder.decode<IDBKeyRangeData>();
    auto type = range ? decoder.decode<IDBGetRecordDataType>() : std::nullopt;
    if (!type)
        return std::nullopt;
    return IDBGetRecordData { WTF::move(*range), *type };
}

void Coder<IDBGetAllRecordsData>::encode(Encoder& encoder, const IDBGetAllRecordsData& data)
{
    encoder << data.keyRangeData << data.getAllType << data.count << data.objectStoreIdentifier << data.indexIdentifier;
}

std::optional<IDBGetAllRecordsData> Coder<IDBGetAllRecordsData>::decode(Decoder& decoder)
{
    auto range = decoder.decode<IDBKeyRangeData>();
    auto type = range ? decoder.decode<IndexedDB::GetAllType>() : std::nullopt;
    auto count = type ? decoder.decode<std::optional<uint32_t>>() : std::nullopt;
    auto store = count ? decoder.decode<IDBObjectStoreIdentifier>() : std::nullopt;
    auto index = store ? decoder.decode<std::optional<IDBIndexIdentifier>>() : std::nullopt;
    if (!index)
        return std::nullopt;
    return IDBGetAllRecordsData { WTF::move(*range), *type, *count, *store, *index };
}

void Coder<IDBIterateCursorData>::encode(Encoder& encoder, const IDBIterateCursorData& data)
{
    encoder << data.keyData << data.primaryKeyData << data.count << data.option;
}

std::optional<IDBIterateCursorData> Coder<IDBIterateCursorData>::decode(Decoder& decoder)
{
    auto key = decoder.decode<IDBKeyData>();
    auto primaryKey = key ? decoder.decode<IDBKeyData>() : std::nullopt;
    auto count = primaryKey ? decoder.decode<unsigned>() : std::nullopt;
    auto option = count ? decoder.decode<IndexedDB::CursorIterateOption>() : std::nullopt;
    if (!option)
        return std::nullopt;
    return IDBIterateCursorData { WTF::move(*key), WTF::move(*primaryKey), *count, *option };
}

void Coder<IDBCursorRecord>::encode(Encoder& encoder, const IDBCursorRecord& record)
{
    encoder << record.key << record.primaryKey << record.value;
}

std::optional<IDBCursorRecord> Coder<IDBCursorRecord>::decode(Decoder& decoder)
{
    auto key = decoder.decode<IDBKeyData>();
    auto primaryKey = key ? decoder.decode<IDBKeyData>() : std::nullopt;
    auto value = primaryKey ? decoder.decode<IDBValue>() : std::nullopt;
    if (!value)
        return std::nullopt;
    return IDBCursorRecord { WTF::move(*key), WTF::move(*primaryKey), WTF::move(*value) };
}

void Coder<IDBGetResult>::encode(Encoder& encoder, const IDBGetResult& result)
{
    encoder << result.keyData() << result.primaryKeyData() << result.value() << result.keyPath() << result.prefetchedRecords() << result.isDefined();
}

std::optional<IDBGetResult> Coder<IDBGetResult>::decode(Decoder& decoder)
{
    auto key = decoder.decode<IDBKeyData>();
    auto primaryKey = key ? decoder.decode<IDBKeyData>() : std::nullopt;
    auto value = primaryKey ? decoder.decode<IDBValue>() : std::nullopt;
    auto keyPath = value ? decoder.decode<std::optional<IDBKeyPath>>() : std::nullopt;
    auto records = keyPath ? decoder.decode<Vector<IDBCursorRecord>>() : std::nullopt;
    auto defined = records ? decoder.boolean() : std::nullopt;
    if (!defined)
        return std::nullopt;
    return IDBGetResult { *key, *primaryKey, WTF::move(*value), *keyPath, WTF::move(*records), *defined };
}

void Coder<IDBDatabaseNameAndVersion>::encode(Encoder& encoder, const IDBDatabaseNameAndVersion& entry)
{
    encoder << entry.name << entry.version;
}

std::optional<IDBDatabaseNameAndVersion> Coder<IDBDatabaseNameAndVersion>::decode(Decoder& decoder)
{
    auto name = decoder.string();
    auto version = name ? decoder.u64() : std::nullopt;
    if (!version)
        return std::nullopt;
    return IDBDatabaseNameAndVersion { WTF::move(*name), *version };
}

} // namespace Inception
