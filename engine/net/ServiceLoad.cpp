#include "config.h"
#include "net/ServiceLoad.h"

#include "CertificateInfo.h"
#include "CurlRequest.h"
#include "CurlRequestClient.h"
#include "CurlResponse.h"
#include "HTTPHeaderNames.h"
#include "NetworkLoadMetrics.h"
#include "ResourceError.h"
#include "ResourceRequest.h"
#include "ResourceResponse.h"
#include "SharedBuffer.h"
#include "bridge/Bridge.h"
#include "link/Link.h"
#include "link/NetCoders.h"
#include "net/PingLoad.h"
#include "net/Session.h"
#include "view/Preferences.h"
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>
#include <wtf/text/MakeString.h>

namespace Inception {
using namespace WebCore;

// Same limit as NetworkLoad.
static constexpr unsigned maxRedirects = 20;

// A content engine's load, fetched here. The request the content engine sent
// never carries cookies: they are added to each hop's copy for curl, from the
// profile's own store, so a redirect never takes one host's cookies to
// another.
class ServiceLoad final : public RefCounted<ServiceLoad>, public CurlRequestClient {
public:
    using Key = std::pair<unsigned, uint64_t>;

    static Ref<ServiceLoad> create(Link& link, uint64_t id) { return adoptRef(*new ServiceLoad(link, id)); }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    void start(ResourceRequest&&);
    void cancel() { stopCurl(); }
    void continueAfterRedirect(std::optional<ResourceRequest>&&);
    void continueAfterResponse();

private:
    ServiceLoad(Link& link, uint64_t id)
        : m_link(&link)
        , m_id(id)
    {
    }

    void curlDidSendData(CurlRequest&, unsigned long long bytesSent, unsigned long long totalBytesToBeSent) final;
    void curlDidReceiveResponse(CurlRequest&, CurlResponse&&) final;
    void curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&&) final;
    void curlDidComplete(CurlRequest&, NetworkLoadMetrics&&) final;
    void curlDidFailWithError(CurlRequest&, ResourceError&&, CertificateInfo&&) final;

    void fail(const ResourceError&, const std::optional<CertificateInfo>& = std::nullopt);
    void stopCurl();
    void done();
    Encoder header() const
    {
        Encoder encoder;
        encoder.u64(m_id);
        return encoder;
    }

    RefPtr<Link> m_link;
    uint64_t m_id;
    ResourceRequest m_request;
    RefPtr<CurlRequest> m_curl;
    RefPtr<CurlRequest> m_waitingResponse;
    MonotonicTime m_started;
    unsigned m_redirects { 0 };
    bool m_waitingRedirect { false };
};

static HashMap<ServiceLoad::Key, Ref<ServiceLoad>>& serviceLoads()
{
    static NeverDestroyed<HashMap<ServiceLoad::Key, Ref<ServiceLoad>>> map;
    return map;
}

void ServiceLoad::start(ResourceRequest&& request)
{
    m_request = WTF::move(request);
    if (!m_request.url().protocolIsInHTTPFamily()) {
        fail(ResourceError(errorDomainWebKitInternal, 0, m_request.url(), "Only http and https loads are allowed"_s));
        return;
    }
    if (!m_started)
        m_started = MonotonicTime::now();
    ResourceRequest wire = m_request;
    wire.removeHTTPHeaderField(HTTPHeaderName::Cookie);
    addCookieHeader(wire);
    if (!acceptLanguage().isEmpty() && !wire.hasHTTPHeaderField(HTTPHeaderName::AcceptLanguage))
        wire.setHTTPHeaderField(HTTPHeaderName::AcceptLanguage, acceptLanguage());
    m_curl = CurlRequest::create(wire, *this);
    m_curl->resume();
}

void ServiceLoad::stopCurl()
{
    m_waitingResponse = nullptr;
    if (RefPtr curl = std::exchange(m_curl, nullptr)) {
        curl->invalidateClient();
        curl->cancel();
    }
}

void ServiceLoad::done()
{
    stopCurl();
    // Last: the map may hold the final reference.
    if (m_link)
        serviceLoads().remove({ m_link->id(), m_id });
}

void ServiceLoad::fail(const ResourceError& error, const std::optional<CertificateInfo>& certificate)
{
    Ref protectedThis { *this };
    if (m_link) {
        auto encoder = header();
        encoder << error << certificate;
        m_link->send(Message::LoadFail, WTF::move(encoder));
    }
    done();
}

void ServiceLoad::curlDidSendData(CurlRequest&, unsigned long long bytesSent, unsigned long long totalBytesToBeSent)
{
    auto encoder = header();
    encoder.u64(bytesSent);
    encoder.u64(totalBytesToBeSent);
    m_link->send(Message::LoadSent, WTF::move(encoder));
}

void ServiceLoad::curlDidReceiveResponse(CurlRequest& curl, CurlResponse&& curlResponse)
{
    storeResponseCookies(m_request, curlResponse);
    ResourceResponse response(curlResponse);
    if (response.isRedirection() && !response.httpHeaderField(HTTPHeaderName::Location).isEmpty()) {
        stopCurl();
        if (++m_redirects > maxRedirects) {
            fail(ResourceError(errorDomainWebKitInternal, 0, m_request.url(), "Too many redirects"_s));
            return;
        }
        m_waitingRedirect = true;
        auto encoder = header();
        encoder << m_request.redirectedRequest(response, true) << response;
        m_link->send(Message::LoadRedirect, WTF::move(encoder));
        return;
    }
    m_waitingResponse = &curl;
    auto encoder = header();
    encoder << response;
    m_link->send(Message::LoadResponse, WTF::move(encoder));
}

void ServiceLoad::continueAfterRedirect(std::optional<ResourceRequest>&& request)
{
    if (!std::exchange(m_waitingRedirect, false))
        return;
    if (!request) {
        done();
        return;
    }
    start(WTF::move(*request));
}

void ServiceLoad::continueAfterResponse()
{
    if (RefPtr curl = std::exchange(m_waitingResponse, nullptr); curl && curl == m_curl)
        curl->completeDidReceiveResponse();
}

void ServiceLoad::curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&& buffer)
{
    auto encoder = header();
    encoder.bytes(buffer->span());
    m_link->send(Message::LoadData, WTF::move(encoder));
}

void ServiceLoad::curlDidComplete(CurlRequest&, NetworkLoadMetrics&& metrics)
{
    Ref protectedThis { *this };
    m_curl = nullptr;
    auto encoder = header();
    encodeMetrics(encoder, metrics, m_started);
    m_link->send(Message::LoadFinish, WTF::move(encoder));
    done();
}

void ServiceLoad::curlDidFailWithError(CurlRequest&, ResourceError&& error, CertificateInfo&& certificate)
{
    m_curl = nullptr;
    fail(error, error.isCertificationVerificationError() ? std::optional<CertificateInfo> { WTF::move(certificate) } : std::nullopt);
}

static RefPtr<ServiceLoad> loadFor(Link& link, Decoder& decoder)
{
    auto id = decoder.u64();
    if (!id)
        return nullptr;
    auto it = serviceLoads().find({ link.id(), *id });
    return it == serviceLoads().end() ? nullptr : it->value.ptr();
}

void installServiceLoads()
{
    // {id, request}
    Link::handle(Message::LoadStart, [](Link& link, Decoder& decoder) {
        auto id = decoder.u64();
        auto request = id ? decoder.decode<ResourceRequest>() : std::nullopt;
        if (!request || !*id || serviceLoads().contains({ link.id(), *id }))
            return;
        Ref load = ServiceLoad::create(link, *id);
        serviceLoads().add({ link.id(), *id }, load);
        load->start(WTF::move(*request));
    });

    // {id}
    Link::handle(Message::LoadCancel, [](Link& link, Decoder& decoder) {
        auto id = decoder.u64();
        if (!id)
            return;
        if (auto load = serviceLoads().take({ link.id(), *id }))
            load->cancel();
    });

    // {id, request?}: where to go after a redirect, or nowhere.
    Link::handle(Message::LoadRedirectReply, [](Link& link, Decoder& decoder) {
        RefPtr load = loadFor(link, decoder);
        auto request = load ? decoder.decode<std::optional<ResourceRequest>>() : std::nullopt;
        if (request)
            load->continueAfterRedirect(WTF::move(*request));
    });

    // {id}: WebCore took the response; the body may come.
    Link::handle(Message::LoadResponseReply, [](Link& link, Decoder& decoder) {
        if (RefPtr load = loadFor(link, decoder))
            load->continueAfterResponse();
    });

    // {request} -> {error, response}: a ping or beacon.
    Link::handleCall(Message::PingLoad, [](Link&, Decoder& decoder, Reply&& reply) {
        auto request = decoder.decode<ResourceRequest>();
        if (!request || !request->url().protocolIsInHTTPFamily())
            return;
        PingLoad::start(*request, [reply = WTF::move(reply)](const ResourceError& error, const ResourceResponse& response) mutable {
            Encoder encoder;
            encoder << error << response;
            reply.send(WTF::move(encoder));
        });
    });

    // A content engine went away: its loads stop.
    Link::addCloseObserver([](Link& link) {
        if (!link.isServiceEnd())
            return;
        Vector<Ref<ServiceLoad>> loads;
        serviceLoads().removeIf([&](auto& entry) {
            if (entry.key.first != link.id())
                return false;
            loads.append(entry.value);
            return true;
        });
        for (auto& load : loads)
            load->cancel();
    });
}

} // namespace Inception
