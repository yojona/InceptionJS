#pragma once

#include <wtf/Ref.h>
#include <wtf/URL.h>

namespace WebCore {
class CookieJar;
}

namespace Inception {

// Cookies of a profile with a service: the service's store is the only real
// one. A content engine keeps the cookies of the hosts its pages asked about
// (not the HttpOnly ones), fetched once with a waiting call and kept current
// by the service, which sends a host's new list whenever it changes.
Ref<WebCore::CookieJar> createProxyCookieJar();
void installCookieProxy();
void installCookieService();
// The service's store changed for `url` (a response, a page's script).
void cookiesChanged(const URL&);

} // namespace Inception
