#pragma once

#include "CurlRequest.h"
#include "CurlRequestClient.h"
#include "ResourceRequest.h"
#include <wtf/RefCounted.h>
#include <wtf/text/WTFString.h>

namespace Inception {

// A file the page downloads: fetched by the engine (cookies, TLS, the relay,
// like any load) and streamed to the host, which saves it where the embedder
// decides. Events: download.started {id, url, filename, mime, size},
// download.progress {id, received, size}, download.finished {id, error?}; the
// bytes travel next to them as transferable chunks.
class Download final : public RefCounted<Download>, public WebCore::CurlRequestClient {
public:
    static void start(const WebCore::ResourceRequest&, const String& suggestedFilename);
    static void registerCommands();

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    Download(const WebCore::ResourceRequest&, const String& suggestedFilename);
    void begin();
    void cancel();

    void curlDidSendData(WebCore::CurlRequest&, unsigned long long, unsigned long long) final { }
    void curlDidReceiveResponse(WebCore::CurlRequest&, WebCore::CurlResponse&&) final;
    void curlDidReceiveData(WebCore::CurlRequest&, Ref<WebCore::SharedBuffer>&&) final;
    void curlDidComplete(WebCore::CurlRequest&, WebCore::NetworkLoadMetrics&&) final;
    void curlDidFailWithError(WebCore::CurlRequest&, WebCore::ResourceError&&, WebCore::CertificateInfo&&) final;

    void finish(const String& error);

    uint64_t m_id;
    WebCore::ResourceRequest m_request;
    String m_suggestedFilename;
    RefPtr<WebCore::CurlRequest> m_curl;
    unsigned m_redirects { 0 };
    uint64_t m_received { 0 };
    uint64_t m_size { 0 };
    uint64_t m_reported { 0 };
    bool m_started { false };
};

} // namespace Inception
