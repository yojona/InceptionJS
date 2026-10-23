#pragma once

#include "CurlRequest.h"
#include "CurlRequestClient.h"
#include "ResourceRequest.h"
#include <wtf/RefCounted.h>
#include <wtf/text/WTFString.h>

namespace Inception {

// A file the page downloads: fetched by the engine (cookies, TLS, the relay,
// like any load) and streamed to the host, which saves it where the embedder
// decides. Events: download.started {id, url, filename, mime, size,
// userGesture, initiator},
// download.progress {id, received, size}, download.paused/resumed {id, received},
// download.restarted {id}, download.finished {id, error?}; the
// bytes travel next to them as transferable chunks.
class Download final : public RefCounted<Download>, public WebCore::CurlRequestClient {
public:
    // `userGesture`: input started it (a click on the link), so the host may
    // require one before saving. `initiator`: "person", "agent" (it acted while
    // in control) or "page" (the page's own script).
    static void start(const WebCore::ResourceRequest&, const String& suggestedFilename, bool userGesture, const String& initiator);
    // The same fetch for a media element's own src: events are media.fetch.*
    // with the element's player id, and the host plays the bytes instead of
    // saving them. Returns the fetch's id.
    static uint64_t startForMedia(const WebCore::ResourceRequest&, unsigned mediaID);
    static void cancelMedia(uint64_t id);
    static void registerCommands();
    // A profile service fetches downloads and media for its content engines:
    // their events and bytes carry the content engine's link.
    static void installService();

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    Download(const WebCore::ResourceRequest&, const String& suggestedFilename);
    static void startForLink(const WebCore::ResourceRequest&, const String& suggestedFilename, bool userGesture, const String& initiator, unsigned link);
    void begin();
    void cancel();
    void pause();
    void resume();

    void curlDidSendData(WebCore::CurlRequest&, unsigned long long, unsigned long long) final { }
    void curlDidReceiveResponse(WebCore::CurlRequest&, WebCore::CurlResponse&&) final;
    void curlDidReceiveData(WebCore::CurlRequest&, Ref<WebCore::SharedBuffer>&&) final;
    void curlDidComplete(WebCore::CurlRequest&, WebCore::NetworkLoadMetrics&&) final;
    void curlDidFailWithError(WebCore::CurlRequest&, WebCore::ResourceError&&, WebCore::CertificateInfo&&) final;

    void finish(const String& error);
    String eventName(ASCIILiteral what) const;
    Ref<JSON::Object> eventData() const;

    uint64_t m_id;
    WebCore::ResourceRequest m_request;
    String m_suggestedFilename;
    RefPtr<WebCore::CurlRequest> m_curl;
    unsigned m_redirects { 0 };
    uint64_t m_received { 0 };
    uint64_t m_size { 0 };
    uint64_t m_reported { 0 };
    bool m_started { false };
    unsigned m_mediaID { 0 };
    bool m_paused { false };
    bool m_resuming { false };
    bool m_userGesture { false };
    String m_initiator;
    // The content engine it is for (0: this engine's own), and the id that
    // engine knows a media fetch by.
    unsigned m_link { 0 };
    uint64_t m_outwardID { 0 };
};

} // namespace Inception
