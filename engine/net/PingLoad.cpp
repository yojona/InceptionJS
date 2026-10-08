#include "config.h"
#include "net/PingLoad.h"

#include "CertificateInfo.h"
#include "CurlRequest.h"
#include "CurlResponse.h"
#include "HTTPHeaderNames.h"
#include "NetworkLoadMetrics.h"
#include "net/Session.h"
#include "view/Preferences.h"

namespace Inception {
using namespace WebCore;

void PingLoad::start(const ResourceRequest& request, Completion&& completion)
{
    Ref load = adoptRef(*new PingLoad(request, WTF::move(completion)));
    load->m_self = load.ptr();
    load->begin();
}

PingLoad::PingLoad(const ResourceRequest& request, Completion&& completion)
    : m_request(request)
    , m_completion(WTF::move(completion))
{
}

void PingLoad::begin()
{
    addCookieHeader(m_request);
    if (!acceptLanguage().isEmpty() && !m_request.hasHTTPHeaderField(HTTPHeaderName::AcceptLanguage))
        m_request.setHTTPHeaderField(HTTPHeaderName::AcceptLanguage, acceptLanguage());
    m_curl = CurlRequest::create(m_request, *this);
    m_curl->resume();
}

void PingLoad::curlDidReceiveResponse(CurlRequest& curl, CurlResponse&& curlResponse)
{
    storeResponseCookies(m_request, curlResponse);
    m_response = ResourceResponse(curlResponse);
    curl.completeDidReceiveResponse();
}

void PingLoad::curlDidComplete(CurlRequest&, NetworkLoadMetrics&&)
{
    finish({ });
}

void PingLoad::curlDidFailWithError(CurlRequest&, ResourceError&& error, CertificateInfo&&)
{
    finish(error);
}

void PingLoad::finish(const ResourceError& error)
{
    if (RefPtr curl = std::exchange(m_curl, nullptr))
        curl->invalidateClient();
    if (m_completion)
        m_completion(error, m_response);
    // Last: this may be the final reference.
    m_self = nullptr;
}

} // namespace Inception
