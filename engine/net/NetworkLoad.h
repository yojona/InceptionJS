#pragma once

#include "CurlRequestClient.h"
#include "ResourceRequest.h"
#include <wtf/RefCounted.h>
#include <wtf/RefPtr.h>

namespace WebCore {
class CurlRequest;
class ResourceLoader;
}

namespace Inception {

// One HTTP(S) load for a WebCore ResourceLoader, carried by a CurlRequest.
// Redirects are followed here (curl is told not to), so WebCore sees each hop.
class NetworkLoad final : public RefCounted<NetworkLoad>, public WebCore::CurlRequestClient {
public:
    static Ref<NetworkLoad> create(WebCore::ResourceLoader& loader) { return adoptRef(*new NetworkLoad(loader)); }
    ~NetworkLoad();

    // Development aid: report every request and response.
    static void setLogging(bool);
    static bool loggingEnabled();
    // Loads not finished yet, for "network idle".
    static unsigned inFlight();

    void start(const WebCore::ResourceRequest&);
    void cancel();

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    explicit NetworkLoad(WebCore::ResourceLoader&);

    void curlDidSendData(WebCore::CurlRequest&, unsigned long long bytesSent, unsigned long long totalBytesToBeSent) final;
    void curlDidReceiveResponse(WebCore::CurlRequest&, WebCore::CurlResponse&&) final;
    void curlDidReceiveData(WebCore::CurlRequest&, Ref<WebCore::SharedBuffer>&&) final;
    void curlDidComplete(WebCore::CurlRequest&, WebCore::NetworkLoadMetrics&&) final;
    void curlDidFailWithError(WebCore::CurlRequest&, WebCore::ResourceError&&, WebCore::CertificateInfo&&) final;

    void followRedirect(WebCore::ResourceResponse&&);
    void stopCurl();

    RefPtr<WebCore::ResourceLoader> m_loader;
    RefPtr<WebCore::CurlRequest> m_curl;
    WebCore::ResourceRequest m_request;
    unsigned m_redirectCount { 0 };
};

} // namespace Inception
