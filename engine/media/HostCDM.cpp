#include "config.h"
#include "media/HostCDM.h"

#if ENABLE(ENCRYPTED_MEDIA)

#include "CDMFactory.h"
#include "CDMInstanceSession.h"
#include "CDMKeySystemConfiguration.h"
#include "CDMPrivate.h"
#include "MediaKeySystemClient.h"
#include "MediaKeySystemRequest.h"
#include "Page.h"
#include "SharedBuffer.h"
#include "bridge/Bridge.h"
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/text/Base64.h>

namespace Inception::Media {
using namespace WebCore;

// License messages are a few KB; anything far larger is not a license.
static constexpr size_t maxMessageSize = 1024 * 1024;

using Reply = CompletionHandler<void(JSON::Object&)>;

static HashMap<unsigned, Reply>& pendingReplies()
{
    static NeverDestroyed<HashMap<unsigned, Reply>> replies;
    return replies;
}

// Sends an "eme.*" event and calls `reply` with the host's "eme.reply".
static void ask(const String& event, Ref<JSON::Object>&& data, Reply&& reply)
{
    static unsigned lastRequest;
    unsigned request = ++lastRequest;
    pendingReplies().add(request, WTF::move(reply));
    data->setInteger("req"_s, request);
    emitEvent(event, WTF::move(data));
}

static String encode(const SharedBuffer& buffer)
{
    return base64EncodeToString(buffer.span());
}

static RefPtr<SharedBuffer> decode(const String& base64)
{
    if (base64.length() > maxMessageSize * 4 / 3 + 4)
        return nullptr;
    auto bytes = base64Decode(base64);
    if (!bytes)
        return nullptr;
    return SharedBuffer::create(WTF::move(*bytes));
}

static ASCIILiteral requirementName(CDMRequirement requirement)
{
    switch (requirement) {
    case CDMRequirement::Required:
        return "required"_s;
    case CDMRequirement::NotAllowed:
        return "not-allowed"_s;
    case CDMRequirement::Optional:
        break;
    }
    return "optional"_s;
}

static CDMRequirement requirementFrom(const String& name)
{
    if (name == "required"_s)
        return CDMRequirement::Required;
    if (name == "not-allowed"_s)
        return CDMRequirement::NotAllowed;
    return CDMRequirement::Optional;
}

static ASCIILiteral sessionTypeName(CDMSessionType type)
{
    switch (type) {
    case CDMSessionType::PersistentLicense:
        return "persistent-license"_s;
    case CDMSessionType::PersistentUsageRecord:
        return "persistent-usage-record"_s;
    case CDMSessionType::Temporary:
        break;
    }
    return "temporary"_s;
}

static Ref<JSON::Object> toJSON(const CDMKeySystemConfiguration& configuration)
{
    auto json = JSON::Object::create();
    json->setString("label"_s, configuration.label);
    auto initDataTypes = JSON::Array::create();
    for (auto& type : configuration.initDataTypes)
        initDataTypes->pushString(type);
    json->setArray("initDataTypes"_s, WTF::move(initDataTypes));
    auto capabilities = [](const Vector<CDMMediaCapability>& list) {
        auto array = JSON::Array::create();
        for (auto& capability : list) {
            auto entry = JSON::Object::create();
            entry->setString("contentType"_s, capability.contentType);
            entry->setString("robustness"_s, capability.robustness);
            array->pushObject(WTF::move(entry));
        }
        return array;
    };
    json->setArray("audioCapabilities"_s, capabilities(configuration.audioCapabilities));
    json->setArray("videoCapabilities"_s, capabilities(configuration.videoCapabilities));
    json->setString("distinctiveIdentifier"_s, requirementName(configuration.distinctiveIdentifier));
    json->setString("persistentState"_s, requirementName(configuration.persistentState));
    // An absent list means "temporary"; an empty one would mean none at all.
    if (!configuration.sessionTypes.isEmpty()) {
        auto sessionTypes = JSON::Array::create();
        for (auto type : configuration.sessionTypes)
            sessionTypes->pushString(sessionTypeName(type));
        json->setArray("sessionTypes"_s, WTF::move(sessionTypes));
    }
    return json;
}

static CDMKeySystemConfiguration configurationFrom(JSON::Object& json)
{
    CDMKeySystemConfiguration configuration;
    configuration.label = json.getString("label"_s);
    if (auto list = json.getArray("initDataTypes"_s)) {
        for (auto& type : *list)
            configuration.initDataTypes.append(AtomString { type->asString() });
    }
    auto capabilities = [&](ASCIILiteral key) {
        Vector<CDMMediaCapability> result;
        if (auto list = json.getArray(key)) {
            for (auto& value : *list) {
                if (auto entry = value->asObject())
                    result.append({ entry->getString("contentType"_s), entry->getString("robustness"_s), std::nullopt });
            }
        }
        return result;
    };
    configuration.audioCapabilities = capabilities("audioCapabilities"_s);
    configuration.videoCapabilities = capabilities("videoCapabilities"_s);
    configuration.distinctiveIdentifier = requirementFrom(json.getString("distinctiveIdentifier"_s));
    configuration.persistentState = requirementFrom(json.getString("persistentState"_s));
    if (auto list = json.getArray("sessionTypes"_s)) {
        for (auto& type : *list) {
            auto name = type->asString();
            configuration.sessionTypes.append(name == "persistent-license"_s ? CDMSessionType::PersistentLicense : name == "persistent-usage-record"_s ? CDMSessionType::PersistentUsageRecord : CDMSessionType::Temporary);
        }
    }
    return configuration;
}

static CDMKeyStatus keyStatusFrom(const String& name)
{
    if (name == "usable"_s)
        return CDMKeyStatus::Usable;
    if (name == "expired"_s)
        return CDMKeyStatus::Expired;
    if (name == "released"_s)
        return CDMKeyStatus::Released;
    if (name == "output-restricted"_s)
        return CDMKeyStatus::OutputRestricted;
    if (name == "output-downscaled"_s)
        return CDMKeyStatus::OutputDownscaled;
    if (name == "status-pending"_s)
        return CDMKeyStatus::StatusPending;
    return CDMKeyStatus::InternalError;
}

static std::optional<CDMInstanceSessionClient::KeyStatusVector> keyStatusesFrom(JSON::Object& json)
{
    auto list = json.getArray("statuses"_s);
    if (!list)
        return std::nullopt;
    CDMInstanceSessionClient::KeyStatusVector statuses;
    for (auto& value : *list) {
        auto pair = value->asArray();
        if (!pair || pair->length() != 2)
            continue;
        if (auto keyID = decode(pair->get(0)->asString()))
            statuses.append({ keyID.releaseNonNull(), keyStatusFrom(pair->get(1)->asString()) });
    }
    return statuses;
}

static CDMMessageType messageTypeFrom(const String& name)
{
    if (name == "license-renewal"_s)
        return CDMMessageType::LicenseRenewal;
    if (name == "license-release"_s)
        return CDMMessageType::LicenseRelease;
    if (name == "individualization-request"_s)
        return CDMMessageType::IndividualizationRequest;
    return CDMMessageType::LicenseRequest;
}

static std::optional<double> expirationFrom(JSON::Object& json)
{
    auto value = json.getDouble("expiration"_s);
    if (!value || std::isnan(*value))
        return std::nullopt;
    return value;
}

class HostCDMSession;

static HashMap<unsigned, HostCDMSession*>& sessions()
{
    static NeverDestroyed<HashMap<unsigned, HostCDMSession*>> map;
    return map;
}

class HostCDMSession final : public CDMInstanceSession {
public:
    static Ref<HostCDMSession> create(unsigned mediaKeys) { return adoptRef(*new HostCDMSession(mediaKeys)); }

    ~HostCDMSession()
    {
        sessions().remove(m_id);
        auto data = JSON::Object::create();
        data->setInteger("session"_s, m_id);
        emitEvent("eme.dropSession"_s, WTF::move(data));
    }

    // The host session spoke on its own: a renewal, or new key statuses.
    void hostMessage(JSON::Object& args)
    {
        RefPtr client = m_client.get();
        auto message = decode(args.getString("message"_s));
        if (client && message && message->size() <= maxMessageSize)
            client->sendMessage(messageTypeFrom(args.getString("messageType"_s)), message.releaseNonNull());
    }

    void hostKeyStatuses(JSON::Object& args)
    {
        RefPtr client = m_client.get();
        auto statuses = keyStatusesFrom(args);
        if (client && statuses)
            client->updateKeyStatuses(WTF::move(*statuses));
    }

private:
    explicit HostCDMSession(unsigned mediaKeys)
        : m_mediaKeys(mediaKeys)
    {
        static unsigned lastID;
        m_id = ++lastID;
        sessions().add(m_id, this);
    }

    Ref<JSON::Object> request()
    {
        auto data = JSON::Object::create();
        data->setInteger("keys"_s, m_mediaKeys);
        data->setInteger("session"_s, m_id);
        return data;
    }

    void setClient(WeakPtr<CDMInstanceSessionClient>&& client) final { m_client = WTF::move(client); }
    void clearClient() final { m_client = nullptr; }

    void requestLicense(LicenseType type, KeyGroupingStrategy, const String& initDataType, Ref<SharedBuffer>&& initData, LicenseCallback&& callback) final
    {
        auto data = request();
        data->setString("sessionType"_s, sessionTypeName(type));
        data->setString("initDataType"_s, initDataType);
        data->setString("initData"_s, encode(initData));
        ask("eme.generateRequest"_s, WTF::move(data), [callback = WTF::move(callback)](JSON::Object& reply) mutable {
            auto message = decode(reply.getString("message"_s));
            if (!reply.getBoolean("ok"_s).value_or(false) || !message)
                return callback(SharedBuffer::create(), emptyString(), false, Failed);
            callback(message.releaseNonNull(), reply.getString("sessionId"_s), false, Succeeded);
        });
    }

    void updateLicense(const String&, LicenseType, Ref<SharedBuffer>&& response, LicenseUpdateCallback&& callback) final
    {
        auto data = request();
        data->setString("response"_s, encode(response));
        ask("eme.update"_s, WTF::move(data), [callback = WTF::move(callback)](JSON::Object& reply) mutable {
            bool ok = reply.getBoolean("ok"_s).value_or(false);
            callback(reply.getBoolean("closed"_s).value_or(false), keyStatusesFrom(reply), expirationFrom(reply), std::nullopt, ok ? Succeeded : Failed);
        });
    }

    void loadSession(LicenseType type, const String& sessionId, const String&, LoadSessionCallback&& callback) final
    {
        auto data = request();
        data->setString("sessionType"_s, sessionTypeName(type));
        data->setString("sessionId"_s, sessionId);
        ask("eme.load"_s, WTF::move(data), [callback = WTF::move(callback)](JSON::Object& reply) mutable {
            if (!reply.getBoolean("ok"_s).value_or(false))
                return callback(std::nullopt, std::nullopt, std::nullopt, Failed, SessionLoadFailure::Other);
            if (!reply.getBoolean("found"_s).value_or(false))
                return callback(std::nullopt, std::nullopt, std::nullopt, Failed, SessionLoadFailure::NoSessionData);
            callback(keyStatusesFrom(reply), expirationFrom(reply), std::nullopt, Succeeded, SessionLoadFailure::None);
        });
    }

    void closeSession(const String&, CloseSessionCallback&& callback) final
    {
        ask("eme.close"_s, request(), [callback = WTF::move(callback)](JSON::Object&) mutable {
            callback();
        });
    }

    void removeSessionData(const String&, LicenseType, RemoveSessionDataCallback&& callback) final
    {
        ask("eme.remove"_s, request(), [callback = WTF::move(callback)](JSON::Object& reply) mutable {
            auto statuses = keyStatusesFrom(reply);
            callback(statuses ? WTF::move(*statuses) : KeyStatusVector { }, nullptr, reply.getBoolean("ok"_s).value_or(false) ? Succeeded : Failed);
        });
    }

    void storeRecordOfKeyUsage(const String&) final { }

    unsigned m_id;
    unsigned m_mediaKeys;
    WeakPtr<CDMInstanceSessionClient> m_client;
};

class HostCDMInstance final : public CDMInstance {
public:
    static Ref<HostCDMInstance> create(const String& keySystem) { return adoptRef(*new HostCDMInstance(keySystem)); }

    unsigned mediaKeys() const { return m_id; }

    ~HostCDMInstance()
    {
        instances().remove(this);
        auto data = JSON::Object::create();
        data->setInteger("keys"_s, m_id);
        emitEvent("eme.dropKeys"_s, WTF::move(data));
    }

    static HashMap<const CDMInstance*, unsigned>& instances()
    {
        static NeverDestroyed<HashMap<const CDMInstance*, unsigned>> map;
        return map;
    }

private:
    explicit HostCDMInstance(const String& keySystem)
        : m_keySystem(keySystem)
    {
        static unsigned lastID;
        m_id = ++lastID;
        instances().add(this, m_id);
    }

    ImplementationType implementationType() const final { return ImplementationType::Mock; }

    void initializeWithConfiguration(const CDMKeySystemConfiguration& configuration, AllowDistinctiveIdentifiers, AllowPersistentState, SuccessCallback&& callback) final
    {
        auto data = JSON::Object::create();
        data->setInteger("keys"_s, m_id);
        data->setString("keySystem"_s, m_keySystem);
        data->setObject("configuration"_s, toJSON(configuration));
        ask("eme.createKeys"_s, WTF::move(data), [callback = WTF::move(callback)](JSON::Object& reply) mutable {
            callback(reply.getBoolean("ok"_s).value_or(false) ? SuccessValue::Succeeded : SuccessValue::Failed);
        });
    }

    void setServerCertificate(Ref<SharedBuffer>&& certificate, SuccessCallback&& callback) final
    {
        auto data = JSON::Object::create();
        data->setInteger("keys"_s, m_id);
        data->setString("certificate"_s, encode(certificate));
        ask("eme.serverCertificate"_s, WTF::move(data), [callback = WTF::move(callback)](JSON::Object& reply) mutable {
            callback(reply.getBoolean("ok"_s).value_or(false) ? SuccessValue::Succeeded : SuccessValue::Failed);
        });
    }

    void setStorageDirectory(const String&) final { }
    const String& keySystem() const final { return m_keySystem; }
    RefPtr<CDMInstanceSession> createSession() final { return HostCDMSession::create(m_id); }

    String m_keySystem;
    unsigned m_id;
};

class HostCDMPrivate final : public CDMPrivate {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(HostCDMPrivate);
public:
    explicit HostCDMPrivate(const String& keySystem)
        : m_keySystem(keySystem)
    {
    }

private:
    // The host runs the whole selection algorithm with its own CDM, and
    // answers with the configuration it would grant a page.
    void getSupportedConfiguration(CDMKeySystemConfiguration&& candidate, LocalStorageAccess, SupportedConfigurationCallback&& callback) final
    {
        auto data = JSON::Object::create();
        data->setString("keySystem"_s, m_keySystem);
        data->setObject("configuration"_s, toJSON(candidate));
        ask("eme.access"_s, WTF::move(data), [callback = WTF::move(callback)](JSON::Object& reply) mutable {
            auto configuration = reply.getObject("configuration"_s);
            if (!reply.getBoolean("ok"_s).value_or(false) || !configuration)
                return callback(std::nullopt);
            callback(configurationFrom(*configuration));
        });
    }

    Vector<String> supportedInitDataTypes() const final { return { "cenc"_s, "keyids"_s, "webm"_s }; }
    bool supportsConfiguration(const CDMKeySystemConfiguration&) const final { return true; }
    bool supportsConfigurationWithRestrictions(const CDMKeySystemConfiguration&, const CDMRestrictions&) const final { return true; }
    bool supportsSessionTypeWithConfiguration(const CDMSessionType&, const CDMKeySystemConfiguration&) const final { return true; }
    Vector<String> supportedRobustnesses() const final { return { }; }
    CDMRequirement distinctiveIdentifiersRequirement(const CDMKeySystemConfiguration& configuration, const CDMRestrictions&) const final { return configuration.distinctiveIdentifier; }
    CDMRequirement persistentStateRequirement(const CDMKeySystemConfiguration& configuration, const CDMRestrictions&) const final { return configuration.persistentState; }
    bool distinctiveIdentifiersAreUniquePerOriginAndClearable(const CDMKeySystemConfiguration&) const final { return true; }
    RefPtr<CDMInstance> createInstance() final { return HostCDMInstance::create(m_keySystem); }
    void loadAndInitialize() final { }
    bool supportsServerCertificates() const final { return true; }
    bool supportsSessions() const final { return true; }
    bool supportsInitData(const String&, const SharedBuffer& data) const final { return data.size() <= maxMessageSize; }
    RefPtr<SharedBuffer> sanitizeResponse(const SharedBuffer& response) const final
    {
        if (response.size() > maxMessageSize)
            return nullptr;
        return SharedBuffer::create(response.span());
    }
    std::optional<String> sanitizeSessionId(const String& sessionId) const final { return sessionId; }

    String m_keySystem;
};

// Every key system: whether the host's browser offers it is only known when a
// page asks, and the host answers that.
class HostCDMFactory final : public CDMFactory {
public:
    // Lives for the whole engine.
    void ref() const final { }
    void deref() const final { }

    std::unique_ptr<CDMPrivate> createCDM(const String& keySystem, const String&, const CDMPrivateClient&) final
    {
        return makeUnique<HostCDMPrivate>(keySystem);
    }

    bool supportsKeySystem(const String& keySystem) final { return !keySystem.isEmpty() && keySystem.length() < 256; }
};

class MediaKeySystemPermission final : public MediaKeySystemClient, public RefCounted<MediaKeySystemPermission> {
public:
    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    // The salt keys per-origin identifiers inside a CDM; the host's CDM keeps
    // its own, so this one only has to be stable.
    void requestMediaKeySystem(MediaKeySystemRequest& request) final { request.allow("inception"_s); }
    void cancelMediaKeySystemRequest(MediaKeySystemRequest&) final { }
};

void provideMediaKeySystem(Page& page)
{
    provideMediaKeySystemTo(page, adoptRef(*new MediaKeySystemPermission));
}

unsigned hostMediaKeysID(CDMInstance& instance)
{
    return HostCDMInstance::instances().get(&instance);
}

void installHostCDM()
{
    static NeverDestroyed<HostCDMFactory> factory;
    CDMFactory::registerFactory(factory.get());

    // {req, ok, ...}: the answer to an "eme.*" request.
    registerCommand("eme.reply"_s, [](JSON::Object& args) {
        if (auto reply = pendingReplies().take(args.getInteger("req"_s).value_or(0)))
            reply(args);
    });
    // {session, messageType, message}
    registerCommand("eme.message"_s, [](JSON::Object& args) {
        if (auto* session = sessions().get(args.getInteger("session"_s).value_or(0)))
            session->hostMessage(args);
    });
    // {session, statuses: [[keyID, status], ...]}
    registerCommand("eme.keyStatuses"_s, [](JSON::Object& args) {
        if (auto* session = sessions().get(args.getInteger("session"_s).value_or(0)))
            session->hostKeyStatuses(args);
    });
}

} // namespace Inception::Media

#endif // ENABLE(ENCRYPTED_MEDIA)
