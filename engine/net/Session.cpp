#include "config.h"
#include "net/Session.h"

#include "CookieJar.h"
#include "CurlResponse.h"
#include "HTTPHeaderNames.h"
#include "NetworkStorageSession.h"
#include "ResourceRequest.h"
#include "SameSiteInfo.h"
#include "StorageSessionProvider.h"
#include <pal/SessionID.h>
#include <wtf/NeverDestroyed.h>

namespace Inception {
using namespace WebCore;

NetworkStorageSession& networkSession()
{
    static NeverDestroyed<std::unique_ptr<NetworkStorageSession>> session = makeUnique<NetworkStorageSession>(PAL::SessionID::defaultSessionID());
    return *session.get();
}

class SessionProvider final : public StorageSessionProvider {
    NetworkStorageSession* storageSession() const final { return &networkSession(); }
};

Ref<CookieJar> createCookieJar()
{
    return CookieJar::create(adoptRef(*new SessionProvider));
}

void addCookieHeader(ResourceRequest& request)
{
    if (!request.allowCookies())
        return;
    auto [cookies, secure] = networkSession().cookieRequestHeaderFieldValue(request.firstPartyForCookies(), SameSiteInfo::create(request), request.url(),
        std::nullopt, std::nullopt, IncludeSecureCookies::Yes, ApplyTrackingPrevention::No, ShouldRelaxThirdPartyCookieBlocking::No, IsKnownCrossSiteTracker::No);
    UNUSED_VARIABLE(secure);
    if (!cookies.isEmpty())
        request.setHTTPHeaderField(HTTPHeaderName::Cookie, cookies);
}

// Set-Cookie values cannot be read back from the merged header map (dates
// contain commas), so they come from the raw header lines.
void storeResponseCookies(const ResourceRequest& request, const CurlResponse& response)
{
    if (!request.allowCookies())
        return;
    constexpr auto prefix = "set-cookie:"_s;
    for (auto& line : response.headers) {
        if (!line.startsWithIgnoringASCIICase(prefix))
            continue;
        auto value = line.substring(prefix.length()).trim(isASCIIWhitespace<char16_t>);
        networkSession().setCookiesFromHTTPResponse(request.firstPartyForCookies(), response.url, value);
    }
}

} // namespace Inception
