#include "config.h"
#include "net/NetworkLoad.h"

#include "CertificateInfo.h"
#include "CertificateSummary.h"
#include "CurlRequest.h"
#include "CurlResponse.h"
#include "HTTPHeaderNames.h"
#include "NetworkLoadMetrics.h"
#include "ResourceError.h"
#include "ResourceLoader.h"
#include "ResourceResponse.h"
#include "SharedBuffer.h"
#include "bridge/Bridge.h"
#include "net/Session.h"
#include "view/Preferences.h"
#include <wtf/text/MakeString.h>

namespace Inception {
using namespace WebCore;

// Same limit as other engines; beyond it the load fails as a redirect loop.
static constexpr unsigned maxRedirects = 20;

static bool s_logging;
static unsigned s_inFlight;

void NetworkLoad::setLogging(bool enabled)
{
    s_logging = enabled;
}

unsigned NetworkLoad::inFlight()
{
    return s_inFlight;
}

NetworkLoad::NetworkLoad(ResourceLoader& loader)
    : m_loader(&loader)
{
    ++s_inFlight;
}

NetworkLoad::~NetworkLoad()
{
    --s_inFlight;
    stopCurl();
}

void NetworkLoad::start(const ResourceRequest& request)
{
    m_request = request;
    addCookieHeader(m_request);
    if (!acceptLanguage().isEmpty() && !m_request.hasHTTPHeaderField(HTTPHeaderName::AcceptLanguage))
        m_request.setHTTPHeaderField(HTTPHeaderName::AcceptLanguage, acceptLanguage());
    if (s_logging) {
        report("debug"_s, makeString("net "_s, m_request.httpMethod(), ' ', m_request.url().string().left(4000)));
        // CORS: what a preflight asks for, and the origin of every cross-origin request.
        if (m_request.httpMethod() == "OPTIONS"_s)
            report("debug"_s, makeString("net   preflight method="_s, m_request.httpHeaderField(HTTPHeaderName::AccessControlRequestMethod), " headers="_s, m_request.httpHeaderField(HTTPHeaderName::AccessControlRequestHeaders)));
        if (auto origin = m_request.httpHeaderField(HTTPHeaderName::Origin); !origin.isEmpty())
            report("debug"_s, makeString("net   origin="_s, origin));
    }
    m_curl = CurlRequest::create(m_request, *this);
    m_curl->resume();
}

void NetworkLoad::cancel()
{
    m_loader = nullptr;
    stopCurl();
}

void NetworkLoad::stopCurl()
{
    if (RefPtr curl = std::exchange(m_curl, nullptr)) {
        curl->invalidateClient();
        curl->cancel();
    }
}

void NetworkLoad::curlDidSendData(CurlRequest&, unsigned long long bytesSent, unsigned long long totalBytesToBeSent)
{
    if (RefPtr loader = m_loader)
        loader->didSendData(bytesSent, totalBytesToBeSent);
}

void NetworkLoad::curlDidReceiveResponse(CurlRequest& curl, CurlResponse&& curlResponse)
{
    RefPtr loader = m_loader;
    if (!loader)
        return;

    storeResponseCookies(m_request, curlResponse);
    ResourceResponse response(curlResponse);
    if (s_logging) {
        report("debug"_s, makeString("net "_s, response.httpStatusCode(), ' ', m_request.url().string().left(200)));
        if (auto allowOrigin = response.httpHeaderField(HTTPHeaderName::AccessControlAllowOrigin); !allowOrigin.isEmpty() || m_request.httpMethod() == "OPTIONS"_s)
            report("debug"_s, makeString("net   allow-origin="_s, allowOrigin, " allow-credentials="_s, response.httpHeaderField(HTTPHeaderName::AccessControlAllowCredentials), " allow-headers="_s, response.httpHeaderField(HTTPHeaderName::AccessControlAllowHeaders)));
    }
    if (response.isRedirection() && !response.httpHeaderField(HTTPHeaderName::Location).isEmpty()) {
        followRedirect(WTF::move(response));
        return;
    }

    loader->didReceiveResponse(WTF::move(response), [protectedThis = Ref { *this }, curl = Ref { curl }] {
        if (protectedThis->m_curl.get() == curl.ptr())
            curl->completeDidReceiveResponse();
    });
}

void NetworkLoad::followRedirect(ResourceResponse&& response)
{
    stopCurl();
    RefPtr loader = m_loader;
    if (++m_redirectCount > maxRedirects) {
        loader->didFail(ResourceError(errorDomainWebKitInternal, 0, m_request.url(), "Too many redirects"_s));
        return;
    }

    auto request = m_request.redirectedRequest(response, true);
    loader->willSendRequest(WTF::move(request), response, [protectedThis = Ref { *this }](ResourceRequest&& newRequest) {
        if (!protectedThis->m_loader || newRequest.isNull())
            return;
        protectedThis->start(newRequest);
    });
}

void NetworkLoad::curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&& buffer)
{
    if (RefPtr loader = m_loader)
        loader->didReceiveData(buffer.get(), buffer->size(), DataPayloadBytes);
}

void NetworkLoad::curlDidComplete(CurlRequest&, NetworkLoadMetrics&& metrics)
{
    m_curl = nullptr;
    if (RefPtr loader = std::exchange(m_loader, nullptr))
        loader->didFinishLoading(metrics);
}

void NetworkLoad::curlDidFailWithError(CurlRequest&, ResourceError&& error, CertificateInfo&& certificate)
{
    report("debug"_s, makeString("load failed "_s, m_request.url().string(), ": "_s, error.localizedDescription()));
    // What the host needs to explain a certificate error in its own UI.
    if (error.isCertificationVerificationError()) {
        auto data = JSON::Object::create();
        data->setString("url"_s, m_request.url().string());
        data->setInteger("verificationError"_s, certificate.verificationError());
        data->setString("description"_s, certificate.verificationErrorDescription());
        if (auto summary = certificate.summary()) {
            data->setString("subject"_s, summary->subject);
            data->setDouble("validFrom"_s, summary->validFrom.milliseconds());
            data->setDouble("validUntil"_s, summary->validUntil.milliseconds());
        }
        emitEvent("security.certificateError"_s, WTF::move(data));
    }
    m_curl = nullptr;
    if (RefPtr loader = std::exchange(m_loader, nullptr))
        loader->didFail(error);
}

} // namespace Inception
