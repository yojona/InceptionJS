#pragma once

#include "IDBCursorInfo.h"
#include "IDBDatabaseIdentifier.h"
#include "IDBDatabaseInfo.h"
#include "IDBDatabaseNameAndVersion.h"
#include "IDBError.h"
#include "IDBGetAllRecordsData.h"
#include "IDBGetRecordData.h"
#include "IDBIndexInfo.h"
#include "IDBIterateCursorData.h"
#include "IDBKeyData.h"
#include "IDBKeyRangeData.h"
#include "IDBObjectStoreInfo.h"
#include "IDBOpenRequestData.h"
#include "IDBRequestData.h"
#include "IDBResourceIdentifier.h"
#include "IDBResultData.h"
#include "IDBTransactionInfo.h"
#include "IDBValue.h"
#include "IndexKey.h"
#include "link/Codec.h"
#include <wtf/ObjectIdentifier.h>

// What IndexedDB carries between a content engine (its IDB client) and the
// profile service (its IDB server). Some of these types build their members
// only through IPC::ArgumentCoder<T>, which they name as a friend; the
// specializations for those are ours, defined in IDBCoders.cpp, and speak
// our codec. Everything else goes through Coder<T>.

namespace Inception {

// Object identifiers: their raw value, refused when it is not a valid one.
template<typename T, typename ThreadSafety>
struct Coder<WTF::ObjectIdentifierGeneric<T, ThreadSafety, uint64_t>> {
    using Identifier = WTF::ObjectIdentifierGeneric<T, ThreadSafety, uint64_t>;
    static void encode(Encoder& encoder, const Identifier& identifier) { encoder.u64(identifier.toRawValue()); }
    static std::optional<Identifier> decode(Decoder& decoder)
    {
        auto raw = decoder.u64();
        if (!raw)
            return std::nullopt;
        if (!Identifier::isValidIdentifier(*raw)) {
            decoder.fail();
            return std::nullopt;
        }
        return Identifier { *raw };
    }
};

#define INCEPTION_DECLARE_CODER(Type) \
    template<> struct Coder<Type> { \
        static void encode(Encoder&, const Type&); \
        static std::optional<Type> decode(Decoder&); \
    };

INCEPTION_DECLARE_CODER(WebCore::SecurityOriginData)
INCEPTION_DECLARE_CODER(WebCore::ClientOrigin)
INCEPTION_DECLARE_CODER(WebCore::IDBKeyPath)
INCEPTION_DECLARE_CODER(WebCore::ThreadSafeDataBuffer)
INCEPTION_DECLARE_CODER(WebCore::IDBKeyData)
INCEPTION_DECLARE_CODER(WebCore::IDBKeyRangeData)
INCEPTION_DECLARE_CODER(WebCore::IDBValue)
INCEPTION_DECLARE_CODER(WebCore::IndexKey)
INCEPTION_DECLARE_CODER(WebCore::IDBError)
INCEPTION_DECLARE_CODER(WebCore::IDBResourceIdentifier)
INCEPTION_DECLARE_CODER(WebCore::IDBDatabaseIdentifier)
INCEPTION_DECLARE_CODER(WebCore::IDBOpenRequestData)
INCEPTION_DECLARE_CODER(WebCore::IDBRequestData)
INCEPTION_DECLARE_CODER(WebCore::IDBIndexInfo)
INCEPTION_DECLARE_CODER(WebCore::IDBObjectStoreInfo)
INCEPTION_DECLARE_CODER(WebCore::IDBDatabaseInfo)
INCEPTION_DECLARE_CODER(WebCore::IDBTransactionInfo)
INCEPTION_DECLARE_CODER(WebCore::IDBGetRecordData)
INCEPTION_DECLARE_CODER(WebCore::IDBGetAllRecordsData)
INCEPTION_DECLARE_CODER(WebCore::IDBCursorInfo)
INCEPTION_DECLARE_CODER(WebCore::IDBIterateCursorData)
INCEPTION_DECLARE_CODER(WebCore::IDBCursorRecord)
INCEPTION_DECLARE_CODER(WebCore::IDBGetResult)
INCEPTION_DECLARE_CODER(WebCore::IDBGetAllResult)
INCEPTION_DECLARE_CODER(WebCore::IDBResultData)
INCEPTION_DECLARE_CODER(WebCore::IDBDatabaseNameAndVersion)

#undef INCEPTION_DECLARE_CODER

// What a result carries, if anything (its own accessors assert it does).
const WebCore::IDBGetResult* getResultOf(const WebCore::IDBResultData&);
const WebCore::IDBGetAllResult* getAllResultOf(const WebCore::IDBResultData&);

} // namespace Inception
