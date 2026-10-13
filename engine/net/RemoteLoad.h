#pragma once

#include "ResourceRequest.h"
#include <wtf/MonotonicTime.h>
#include <wtf/RefCounted.h>
#include <wtf/RefPtr.h>

namespace WebCore {
class ResourceError;
class ResourceLoader;
}

namespace Inception {

class Link;

// A content engine's load: the profile service fetches it (cookies, TLS, the
// relay) and streams the response here, where it drives the ResourceLoader
// as NetworkLoad does in a standalone engine. Redirects and the response
// wait for WebCore's answer before the service goes on.
class RemoteLoad final : public RefCounted<RemoteLoad> {
public:
    static Ref<RemoteLoad> create(WebCore::ResourceLoader& loader) { return adoptRef(*new RemoteLoad(loader)); }
    ~RemoteLoad();

    static unsigned inFlight();
    static void install();

    void start(const WebCore::ResourceRequest&);
    void cancel();

private:
    explicit RemoteLoad(WebCore::ResourceLoader&);

    static RemoteLoad* byID(uint64_t);
    void fail(const WebCore::ResourceError&);
    void finished();

    uint64_t m_id;
    RefPtr<WebCore::ResourceLoader> m_loader;
    RefPtr<Link> m_link;
    WebCore::ResourceRequest m_request;
    MonotonicTime m_started;
};

} // namespace Inception
