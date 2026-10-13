#include "config.h"
#include "net/RemoteLoad.h"

#include "CertificateInfo.h"
#include "CertificateSummary.h"
#include "DocumentPage.h"
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
