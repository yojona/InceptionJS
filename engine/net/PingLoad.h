#pragma once

#include "CurlRequest.h"
#include "CurlRequestClient.h"
#include "ResourceError.h"
#include "ResourceRequest.h"
#include "ResourceResponse.h"
#include <wtf/CompletionHandler.h>
#include <wtf/RefCounted.h>

namespace Inception {

// A fire-and-forget request the page does not wait on (navigator.sendBeacon,
// <a ping>, CSP reports). It carries cookies like any load and keeps itself
// alive until curl is done, even if the page goes away first.
class PingLoad final : public RefCounted<PingLoad>, public WebCore::CurlRequestClient {
public:
    using Completion = CompletionHandler<void(const WebCore::ResourceError&, const WebCore::ResourceResponse&)>;
    static void start(const WebCore::ResourceRequest&, Completion&&);

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    PingLoad(const WebCore::ResourceRequest&, Completion&&);
    void begin();

    void curlDidSendData(WebCore::CurlRequest&, unsigned long long, unsigned long long) final { }
    void curlDidReceiveResponse(WebCore::CurlRequest&, WebCore::CurlResponse&&) final;
    void curlDidReceiveData(WebCore::CurlRequest&, Ref<WebCore::SharedBuffer>&&) final { }
    void curlDidComplete(WebCore::CurlRequest&, WebCore::NetworkLoadMetrics&&) final;
    void curlDidFailWithError(WebCore::CurlRequest&, WebCore::ResourceError&&, WebCore::CertificateInfo&&) final;

    void finish(const WebCore::ResourceError&);

    WebCore::ResourceRequest m_request;
    WebCore::ResourceResponse m_response;
    RefPtr<WebCore::CurlRequest> m_curl;
    Completion m_completion;
    RefPtr<PingLoad> m_self;
};

} // namespace Inception
