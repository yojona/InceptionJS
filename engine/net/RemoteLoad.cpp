#include "config.h"
#include "net/RemoteLoad.h"

#include "CertificateInfo.h"
#include "CertificateSummary.h"
#include "DocumentPage.h"
#include "HTTPHeaderNames.h"
#include "LocalFrame.h"
#include "NetworkLoadMetrics.h"
#include "ResourceError.h"
#include "ResourceLoader.h"
#include "ResourceResponse.h"
#include "SharedBuffer.h"
#include "bridge/Bridge.h"
#include "link/Link.h"
#include "link/NetCoders.h"
#include "view/View.h"
#include "view/Window.h"
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>

namespace Inception {
using namespace WebCore;

static HashMap<uint64_t, RemoteLoad*>& loads()
{
    static NeverDestroyed<HashMap<uint64_t, RemoteLoad*>> map;
    return map;
}

static unsigned s_inFlight;

unsigned RemoteLoad::inFlight()
{
    return s_inFlight;
}

RemoteLoad* RemoteLoad::byID(uint64_t id)
{
    return id ? loads().get(id) : nullptr;
}

RemoteLoad::RemoteLoad(ResourceLoader& loader)
    : m_loader(&loader)
{
    static uint64_t lastID;
    m_id = ++lastID;
    ++s_inFlight;
}

RemoteLoad::~RemoteLoad()
{
    --s_inFlight;
    loads().remove(m_id);
}

// Development aid (the engine's debug commands only): loads made straight on
// the link, past WebCore and its CORS checks, as a subverted content engine
// would make them, to see what the service hands over.
struct RawLoad {
    double id { 0 };
    int status { 0 };
    Vector<uint8_t> body;
};

static HashMap<uint64_t, RawLoad>& rawLoads()
{
    static NeverDestroyed<HashMap<uint64_t, RawLoad>> map;
    return map;
}

static void finishRaw(uint64_t id, const String& error)
{
    auto raw = rawLoads().take(id);
    auto data = JSON::Object::create();
    data->setDouble("id"_s, raw.id);
    data->setInteger("status"_s, raw.status);
    data->setInteger("length"_s, raw.body.size());
    data->setString("text"_s, String { byteCast<Latin1Character>(raw.body.span().first(std::min<size_t>(raw.body.size(), 2000))) });
    if (!error.isNull())
        data->setString("error"_s, error);
    emitEvent("debug.rawLoad.result"_s, WTF::move(data));
}

// {id, url, mode ("cors", "no-cors", "navigate"), origin?, firstParty?}:
// a GET with the engine's user agent and cookies allowed (the service decides).
void RemoteLoad::registerDebugCommands()
{
    registerCommand("debug.rawLoad"_s, [](JSON::Object& args) {
        RefPtr link = Link::service();
        if (!link)
            return;
        static uint64_t lastID = 1ull << 52;
        auto id = ++lastID;
        ResourceRequest request { URL { args.getString("url"_s) } };
        request.setAllowCookies(true);
        // What a page's request carries anyway (some servers refuse requests
        // without a user agent).
        request.setHTTPUserAgent(View::singleton() && !View::singleton()->userAgent().isEmpty() ? View::singleton()->userAgent() : "Mozilla/5.0"_s);
        auto origin = args.getString("origin"_s);
        if (!origin.isEmpty())
            request.setHTTPHeaderField(HTTPHeaderName::Origin, origin);
        auto firstParty = args.getString("firstParty"_s);
        request.setFirstPartyForCookies(URL { firstParty.isEmpty() ? request.url().string() : firstParty });
        auto mode = args.getString("mode"_s);
        rawLoads().set(id, RawLoad { args.getDouble("id"_s).value_or(0), 0, { } });
        Encoder encoder;
        encoder.u64(id);
        encoder << request;
        encoder.u8(static_cast<uint8_t>(mode == "cors"_s ? FetchOptions::Mode::Cors : mode == "navigate"_s ? FetchOptions::Mode::Navigate : FetchOptions::Mode::NoCors));
        link->send(Message::LoadStart, WTF::move(encoder));
    });
}

// Whether a frame of a load belongs to a debug raw load; if so, it is handled.
static bool handleRaw(Link& link, Message message, uint64_t id, Decoder& decoder)
{
    auto it = rawLoads().find(id);
    if (it == rawLoads().end())
        return false;
    switch (message) {
    case Message::LoadRedirect: {
        auto request = decoder.decode<ResourceRequest>();
        Encoder encoder;
        encoder.u64(id);
        std::optional<ResourceRequest> next;
        if (request)
            next = WTF::move(*request);
        encoder << next;
        link.send(Message::LoadRedirectReply, WTF::move(encoder));
        break;
    }
    case Message::LoadResponse: {
        if (auto response = decoder.decode<ResourceResponse>())
            it->value.status = response->httpStatusCode();
        Encoder encoder;
        encoder.u64(id);
        link.send(Message::LoadResponseReply, WTF::move(encoder));
        break;
    }
    case Message::LoadData:
        if (auto bytes = decoder.view())
            it->value.body.append(*bytes);
        break;
    case Message::LoadFinish:
        finishRaw(id, String { });
        break;
    case Message::LoadFail: {
        auto error = decoder.decode<ResourceError>();
        finishRaw(id, error ? error->localizedDescription() : "failed"_s);
        break;
    }
    default:
        break;
    }
    return true;
}

static ResourceError lostService(const URL& url)
{
    return ResourceError(errorDomainWebKitInternal, 0, url, "The profile service is not available"_s);
}

void RemoteLoad::start(const ResourceRequest& request)
{
    // As in NetworkLoad: the network is for the web's own schemes only.
    if (!request.url().protocolIsInHTTPFamily()) {
        RunLoop::mainSingleton().dispatch([protectedThis = Ref { *this }, url = request.url()] {
            protectedThis->fail(ResourceError(errorDomainWebKitInternal, 0, url, "Only http and https loads are allowed"_s));
        });
        return;
    }
    m_link = Link::service();
    if (!m_link) {
        RunLoop::mainSingleton().dispatch([protectedThis = Ref { *this }, url = request.url()] {
            protectedThis->fail(lostService(url));
        });
        return;
    }
    m_request = request;
    flattenBody(m_request);
    if (!m_started)
        m_started = MonotonicTime::now();
    loads().set(m_id, this);
    Encoder encoder;
    encoder.u64(m_id);
    encoder << m_request;
    // The fetch mode: a service that locks this engine to a site filters
    // responses of other sites by it (net/ServiceLoad.cpp).
    encoder.u8(static_cast<uint8_t>(m_loader ? m_loader->options().mode : FetchOptions::Mode::NoCors));
    m_link->send(Message::LoadStart, WTF::move(encoder));
}

void RemoteLoad::cancel()
{
    m_loader = nullptr;
    if (loads().remove(m_id) && m_link) {
        Encoder encoder;
        encoder.u64(m_id);
        m_link->send(Message::LoadCancel, WTF::move(encoder));
    }
    m_link = nullptr;
}

void RemoteLoad::finished()
{
    loads().remove(m_id);
    m_link = nullptr;
}

void RemoteLoad::fail(const ResourceError& error)
{
    finished();
    if (RefPtr loader = std::exchange(m_loader, nullptr))
        loader->didFail(error);
}

// Same details NetworkLoad reports for a certificate the engine refused.
static void reportCertificateError(ResourceLoader* loader, const URL& url, const CertificateInfo& certificate)
{
    auto data = JSON::Object::create();
    data->setString("url"_s, url.string());
    data->setInteger("verificationError"_s, certificate.verificationError());
    data->setString("description"_s, certificate.verificationErrorDescription());
    if (auto summary = certificate.summary()) {
        data->setString("subject"_s, summary->subject);
        data->setDouble("validFrom"_s, summary->validFrom.milliseconds());
        data->setDouble("validUntil"_s, summary->validUntil.milliseconds());
    }
    RefPtr frame = loader ? loader->frame() : nullptr;
    auto* view = View::fromPage(frame ? frame->page() : nullptr);
    WindowScope scope(view ? view->window().id() : 0);
    emitEvent("security.certificateError"_s, WTF::move(data));
}

void RemoteLoad::install()
{
    // {id, request, response}: the service stopped at a redirect; WebCore
    // decides whether and where to go on.
    Link::handle(Message::LoadRedirect, [](Link& link, Decoder& decoder) {
        auto id = decoder.u64();
        if (id && handleRaw(link, Message::LoadRedirect, *id, decoder))
            return;
        auto request = decoder.decode<ResourceRequest>();
        auto response = decoder.decode<ResourceResponse>();
        RefPtr load = id ? byID(*id) : nullptr;
        if (!response || !load || load->m_link != &link)
            return;
        RefPtr loader = load->m_loader;
        if (!loader)
            return;
        loader->willSendRequest(WTF::move(*request), *response, [load, id = *id](ResourceRequest&& newRequest) {
            if (!load->m_loader || !load->m_link || byID(id) != load.get())
                return;
            std::optional<ResourceRequest> next;
            if (!newRequest.isNull()) {
                if (!newRequest.url().protocolIsInHTTPFamily()) {
                    load->fail(ResourceError(errorDomainWebKitInternal, 0, newRequest.url(), "Only http and https loads are allowed"_s));
                    return;
                }
                load->m_request = newRequest;
                flattenBody(load->m_request);
                next = load->m_request;
            }
            Encoder encoder;
            encoder.u64(id);
            encoder << next;
            load->m_link->send(Message::LoadRedirectReply, WTF::move(encoder));
        });
    });

    // {id, response}: WebCore takes it; the service holds the body until it has.
    Link::handle(Message::LoadResponse, [](Link& link, Decoder& decoder) {
        auto id = decoder.u64();
        if (id && handleRaw(link, Message::LoadResponse, *id, decoder))
            return;
        auto response = decoder.decode<ResourceResponse>();
        RefPtr load = response ? byID(*id) : nullptr;
        if (!load || load->m_link != &link)
            return;
        RefPtr loader = load->m_loader;
        if (!loader)
            return;
        loader->didReceiveResponse(WTF::move(*response), [load, id = *id] {
            if (!load->m_link || byID(id) != load.get())
                return;
            Encoder encoder;
            encoder.u64(id);
            load->m_link->send(Message::LoadResponseReply, WTF::move(encoder));
        });
    });

    // {id, bytes}
    Link::handle(Message::LoadData, [](Link& link, Decoder& decoder) {
        auto id = decoder.u64();
        if (id && handleRaw(link, Message::LoadData, *id, decoder))
            return;
        auto bytes = id ? decoder.view() : std::nullopt;
        RefPtr load = bytes ? byID(*id) : nullptr;
        if (!load || load->m_link != &link)
            return;
        if (RefPtr loader = load->m_loader)
            loader->didReceiveData(SharedBuffer::create(*bytes), bytes->size(), DataPayloadBytes);
    });

    // {id, sent, total}: upload progress.
    Link::handle(Message::LoadSent, [](Link& link, Decoder& decoder) {
        auto id = decoder.u64();
        auto sent = decoder.u64();
        auto total = decoder.u64();
        RefPtr load = total ? byID(*id) : nullptr;
        if (!load || load->m_link != &link)
            return;
        if (RefPtr loader = load->m_loader)
            loader->didSendData(*sent, *total);
    });

    // {id, metrics}
    Link::handle(Message::LoadFinish, [](Link& link, Decoder& decoder) {
        auto id = decoder.u64();
        if (id && handleRaw(link, Message::LoadFinish, *id, decoder))
            return;
        RefPtr load = id ? byID(*id) : nullptr;
        if (!load || load->m_link != &link)
            return;
        auto metrics = decodeMetrics(decoder, load->m_started);
        load->finished();
        if (RefPtr loader = std::exchange(load->m_loader, nullptr))
            loader->didFinishLoading(metrics ? *metrics : NetworkLoadMetrics { });
    });

    // {id, error, certificate?}
    Link::handle(Message::LoadFail, [](Link& link, Decoder& decoder) {
        auto id = decoder.u64();
        if (id && handleRaw(link, Message::LoadFail, *id, decoder))
            return;
        auto error = decoder.decode<ResourceError>();
        auto certificate = error ? decoder.decode<std::optional<CertificateInfo>>() : std::nullopt;
        RefPtr load = certificate ? byID(*id) : nullptr;
        if (!load || load->m_link != &link)
            return;
        if (error->isCertificationVerificationError() && *certificate)
            reportCertificateError(load->m_loader.get(), load->m_request.url(), **certificate);
        load->fail(*error);
    });

    // The service is gone: every load it carried fails, as a dropped
    // connection would.
    Link::addCloseObserver([](Link& link) {
        if (link.isServiceEnd())
            return;
        Vector<Ref<RemoteLoad>> lost;
        for (auto* load : loads().values()) {
            if (load->m_link == &link)
                lost.append(*load);
        }
        for (auto& load : lost)
            load->fail(lostService(load->m_request.url()));
    });
}

} // namespace Inception
