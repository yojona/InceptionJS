#pragma once

#include <wtf/Ref.h>

namespace WebCore {
class CookieJar;
class NetworkStorageSession;
class ResourceRequest;
class ResourceResponse;
class CurlResponse;
}

namespace Inception {

// The engine's one network session: the cookie store shared by HTTP loads and
// document.cookie.
WebCore::NetworkStorageSession& networkSession();
Ref<WebCore::CookieJar> createCookieJar();

void addCookieHeader(WebCore::ResourceRequest&);
void storeResponseCookies(const WebCore::ResourceRequest&, const WebCore::CurlResponse&);

} // namespace Inception
