#include "config.h"
#include "net/ServiceLoad.h"

#include "CertificateInfo.h"
#include "CurlRequest.h"
#include "CurlRequestClient.h"
#include "CurlResponse.h"
#include "FetchOptionsMode.h"
#include "HTTPHeaderNames.h"
#include "HTTPParsers.h"
#include "MIMETypeRegistry.h"
#include "NetworkLoadMetrics.h"
#include "ResourceError.h"
#include "ResourceRequest.h"
#include "ResourceResponse.h"
#include "SharedBuffer.h"
#include "bridge/Bridge.h"
#include "link/Link.h"
#include "link/NetCoders.h"
#include "net/LinkPolicy.h"
#include "net/NetworkLoad.h"
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

// What the filter of responses from other sites does with one (see
// ServiceLoad::filterResponse).
enum class Verdict : uint8_t { Allow, Block, Sniff };

// A content engine's load, fetched here. The request the content engine sent
// never carries cookies: they are added to each hop's copy for curl, from the
// profile's own store, so a redirect never takes one host's cookies to
// another.
class ServiceLoad final : public RefCounted<ServiceLoad>, public CurlRequestClient {
public:
    using Key = std::pair<unsigned, uint64_t>;

    static Ref<ServiceLoad> create(Link& link, uint64_t id, FetchOptionsMode mode) { return adoptRef(*new ServiceLoad(link, id, mode)); }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    void start(ResourceRequest&&);
    void cancel() { stopCurl(); }
    void continueAfterRedirect(std::optional<ResourceRequest>&&);
    void continueAfterResponse();

private:
    ServiceLoad(Link& link, uint64_t id, FetchOptionsMode mode)
        : m_link(&link)
        , m_id(id)
        , m_mode(mode)
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
    void sendResponse(const ResourceResponse&);
    Verdict filterResponse(const ResourceResponse&) const;
    void decide(Verdict);
    void flushHeld();
    Encoder header() const
    {
        Encoder encoder;
        encoder.u64(m_id);
        return encoder;
    }

    RefPtr<Link> m_link;
    uint64_t m_id;
    FetchOptionsMode m_mode;
    ResourceRequest m_request;
    RefPtr<CurlRequest> m_curl;
    RefPtr<CurlRequest> m_waitingResponse;
    MonotonicTime m_started;
    unsigned m_redirects { 0 };
    bool m_waitingRedirect { false };
    bool m_sentCookies { false };
    // A response held until the first bytes of its body tell what it is;
    // the body that arrives meanwhile, and its end, wait with it.
    std::optional<ResourceResponse> m_heldResponse;
    Vector<Ref<SharedBuffer>> m_heldData;
    std::optional<NetworkLoadMetrics> m_heldFinish;
    // The response went out; held data waits for WebCore to take it.
    bool m_responseSent { false };
    bool m_responseTaken { false };
    // Blocked: the content engine gets an empty response and no bytes.
    bool m_blocked { false };
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
    // Every hop: a redirect may not lead where the window may not go.
    if (!LinkPolicy::allows(m_link->id(), m_request.url())) {
        fail(ResourceError(errorDomainWebKitInternal, 0, m_request.url(), "Blocked by the embedder's policy"_s));
        return;
    }
    if (!m_started)
        m_started = MonotonicTime::now();
    ResourceRequest wire = m_request;
    wire.removeHTTPHeaderField(HTTPHeaderName::Cookie);
    LinkPolicy::restrict(m_link->id(), wire);
    // Response cookies follow the same rule as the request's.
    m_request.setAllowCookies(wire.allowCookies());
    m_request.setFirstPartyForCookies(wire.firstPartyForCookies());
    addCookieHeader(wire);
    m_sentCookies = wire.hasHTTPHeaderField(HTTPHeaderName::Cookie);
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
    auto verdict = filterResponse(response);
    if (verdict == Verdict::Sniff) {
        // The body decides: take it now, show nothing yet.
        m_heldResponse = WTF::move(response);
        m_waitingResponse = nullptr;
        curl.completeDidReceiveResponse();
        return;
    }
    if (verdict == Verdict::Block) {
        // None of the body is wanted: the load ends once WebCore took the
        // empty response.
        m_blocked = true;
        stopCurl();
        m_heldFinish = NetworkLoadMetrics { };
    }
    sendResponse(response);
}

void ServiceLoad::sendResponse(const ResourceResponse& response)
{
    m_responseSent = true;
    auto encoder = header();
    if (m_blocked) {
        // What a page may know of a response it may not read: that there was
        // one, with nothing in it.
        ResourceResponse empty { response.url(), String { }, 0, String { } };
        empty.setHTTPStatusCode(response.httpStatusCode());
        encoder << empty;
        if (NetworkLoad::loggingEnabled())
            report("debug"_s, makeString("net   filtered (another site, not opened by CORS): "_s, response.url().string().left(200)));
    } else
        encoder << response;
    m_link->send(Message::LoadResponse, WTF::move(encoder));
}

// isolation 'site': what a content engine gets of a response from a site
// other than its own. CORS requests get it only if the server opened it to the
// requesting origin; other requests (images, scripts, styles, media, fonts:
// what pages embed from anywhere) get it unless it is a kind of document no
// embedding needs and a page could only want to read (HTML, JSON, XML, ...),
// which arrives empty. Navigations are the page's own frames and pass: there
// are no out-of-process frames, so another site's frame lives in this engine;
// without the profile's cookies for that site (thirdParty 'block'), it holds
// nothing the site keeps for the person.
Verdict ServiceLoad::filterResponse(const ResourceResponse& response) const
{
    if (!LinkPolicy::site(m_link->id()) || LinkPolicy::isLinkSite(m_link->id(), m_request.url()))
        return Verdict::Allow;
    if (m_mode == FetchOptionsMode::Navigate)
        return Verdict::Allow;
    if (m_mode == FetchOptionsMode::Cors) {
        auto origin = m_request.httpOrigin();
        // Without an Origin the request is its document's own origin's (a frame
        // of that site asking its server); it is never credentialed here
        // unless the embedder let other sites have their cookies.
        if (origin.isEmpty())
            return Verdict::Allow;
        auto allowOrigin = response.httpHeaderField(HTTPHeaderName::AccessControlAllowOrigin).trim(isASCIIWhitespace<char16_t>);
        if (allowOrigin == "*"_s && !m_sentCookies)
            return Verdict::Allow;
        if (allowOrigin != origin)
            return Verdict::Block;
        if (m_sentCookies && response.httpHeaderField(HTTPHeaderName::AccessControlAllowCredentials).trim(isASCIIWhitespace<char16_t>) != "true"_s)
            return Verdict::Block;
        return Verdict::Allow;
    }
    auto mime = extractMIMETypeFromMediaType(response.httpHeaderField(HTTPHeaderName::ContentType)).convertToASCIILowercase();
    if (mime.startsWith("image/"_s) || mime.startsWith("audio/"_s) || mime.startsWith("video/"_s) || mime.startsWith("font/"_s)
        || mime == "text/css"_s || mime == "text/vtt"_s || MIMETypeRegistry::isSupportedJavaScriptMIMEType(mime))
        return Verdict::Allow;
    if (mime == "image/svg+xml"_s)
        return Verdict::Allow;
    if (MIMETypeRegistry::isSupportedJSONMIMEType(mime) || mime == "text/json"_s || MIMETypeRegistry::isXMLMIMEType(mime)
        || mime == "application/pdf"_s || mime == "application/zip"_s || mime == "application/msword"_s)
        return Verdict::Block;
    bool noSniff = equalLettersIgnoringASCIICase(response.httpHeaderField(HTTPHeaderName::XContentTypeOptions).trim(isASCIIWhitespace<char16_t>), "nosniff"_s);
    if (mime == "text/html"_s || mime == "text/plain"_s || mime.isEmpty())
        return noSniff && !mime.isEmpty() ? Verdict::Block : Verdict::Sniff;
    return Verdict::Allow;
}

// Whether the start of a body is something only a reader would want: HTML,
// XML or JSON (with or without the prefixes servers put before JSON to stop
// it from running as a script).
static bool looksLikeDocument(std::span<const uint8_t> bytes)
{
    size_t i = 0;
    if (bytes.size() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
        i = 3;
    while (i < bytes.size() && isASCIIWhitespace(bytes[i]))
        ++i;
    auto rest = bytes.subspan(i);
    auto startsWith = [&](ASCIILiteral prefix, bool ignoreCase) {
        if (rest.size() < prefix.length())
            return false;
        for (size_t j = 0; j < prefix.length(); ++j) {
            char a = rest[j];
            char b = prefix[j];
            if (ignoreCase ? toASCIILower(a) != toASCIILower(b) : a != b)
                return false;
        }
        return true;
    };
    for (auto prefix : { ")]}'"_s, "{}&&"_s, "for(;;);"_s, "while(1);"_s })
        if (startsWith(prefix, false))
            return true;
    for (auto tag : { "<!doctype html"_s, "<html"_s, "<head"_s, "<body"_s, "<script"_s, "<iframe"_s, "<title"_s, "<table"_s, "<div"_s, "<?xml"_s })
        if (startsWith(tag, true))
            return true;
    // A JSON object: "{" then a quoted key.
    if (!rest.empty() && rest[0] == '{') {
        size_t j = 1;
        while (j < rest.size() && isASCIIWhitespace(rest[j]))
            ++j;
        return j < rest.size() && rest[j] == '"';
    }
    return false;
}

void ServiceLoad::decide(Verdict verdict)
{
    auto response = std::exchange(m_heldResponse, std::nullopt);
    if (!response)
        return;
    m_blocked = verdict == Verdict::Block;
    if (m_blocked) {
        m_heldData.clear();
        // Nothing of the body follows; the end is sent once WebCore took the
        // empty response.
        if (RefPtr curl = std::exchange(m_curl, nullptr)) {
            curl->invalidateClient();
            curl->cancel();
            m_heldFinish = NetworkLoadMetrics { };
        }
    }
    sendResponse(*response);
}

// WebCore took the response: what waited for it goes now.
void ServiceLoad::flushHeld()
{
    Ref protectedThis { *this };
    for (auto& buffer : std::exchange(m_heldData, { })) {
        auto encoder = header();
        encoder.bytes(buffer->span());
        m_link->send(Message::LoadData, WTF::move(encoder));
    }
    if (auto metrics = std::exchange(m_heldFinish, std::nullopt)) {
        auto encoder = header();
        encodeMetrics(encoder, *metrics, m_started);
        m_link->send(Message::LoadFinish, WTF::move(encoder));
        done();
    }
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
    if (!m_responseSent || m_responseTaken)
        return;
    m_responseTaken = true;
    if (RefPtr curl = std::exchange(m_waitingResponse, nullptr); curl && curl == m_curl)
        curl->completeDidReceiveResponse();
    flushHeld();
}

void ServiceLoad::curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&& buffer)
{
    if (m_heldResponse) {
        bool document = looksLikeDocument(buffer->span());
        m_heldData.append(WTF::move(buffer));
        decide(document ? Verdict::Block : Verdict::Allow);
        return;
    }
    if (m_blocked)
        return;
    if (!m_responseTaken) {
        m_heldData.append(WTF::move(buffer));
        return;
    }
    auto encoder = header();
    encoder.bytes(buffer->span());
    m_link->send(Message::LoadData, WTF::move(encoder));
}

void ServiceLoad::curlDidComplete(CurlRequest&, NetworkLoadMetrics&& metrics)
{
    Ref protectedThis { *this };
    m_curl = nullptr;
    // An empty body tells nothing: it may pass.
    if (m_heldResponse)
        decide(Verdict::Allow);
    if (!m_responseTaken) {
        m_heldFinish = WTF::move(metrics);
        return;
    }
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
    // {id, request, mode}
    Link::handle(Message::LoadStart, [](Link& link, Decoder& decoder) {
        auto id = decoder.u64();
        auto request = id ? decoder.decode<ResourceRequest>() : std::nullopt;
        auto mode = request ? decoder.u8() : std::nullopt;
        if (!mode || *mode > static_cast<uint8_t>(FetchOptionsMode::Cors) || !*id || serviceLoads().contains({ link.id(), *id }))
            return;
        Ref load = ServiceLoad::create(link, *id, static_cast<FetchOptionsMode>(*mode));
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
    Link::handleCall(Message::PingLoad, [](Link& link, Decoder& decoder, Reply&& reply) {
        auto request = decoder.decode<ResourceRequest>();
        if (!request || !request->url().protocolIsInHTTPFamily() || !LinkPolicy::allows(link.id(), request->url()))
            return;
        request->removeHTTPHeaderField(HTTPHeaderName::Cookie);
        LinkPolicy::restrict(link.id(), *request);
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
