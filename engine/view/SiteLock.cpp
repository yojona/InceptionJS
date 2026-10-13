#include "config.h"
#include "view/SiteLock.h"

#include "FormData.h"
#include "HTTPHeaderNames.h"
#include "RegistrableDomain.h"
#include "ResourceRequest.h"
#include "bridge/Bridge.h"
#include "link/NetCoders.h"
#include <wtf/NeverDestroyed.h>
#include <wtf/text/Base64.h>

namespace Inception::SiteLock {
using namespace WebCore;

// A form posted to another site travels to the new engine with its body; past
// this it goes as a plain navigation to the address.
static constexpr size_t maxBody = 4 * 1024 * 1024;

static std::optional<String>& lock()
{
    static NeverDestroyed<std::optional<String>> value;
    return value;
}

void set(const String& site)
{
    lock() = site.convertToASCIILowercase();
}

bool active()
{
    return !!lock();
}

const String& site()
{
    return active() ? *lock() : emptyString();
}

bool keeps(const URL& url)
{
    if (!active() || !url.protocolIsInHTTPFamily())
        return true;
    if (site().isEmpty() || url.host().isEmpty())
        return false;
    RegistrableDomain domain { url };
    auto other = domain.isEmpty() ? url.host().convertToASCIILowercase() : domain.string();
    return other == site();
}

void reportCrossSite(unsigned tab, const ResourceRequest& request, const String& initiator, bool userGesture)
{
    auto data = JSON::Object::create();
    data->setInteger("tab"_s, tab);
    data->setString("url"_s, request.url().string());
    data->setString("method"_s, request.httpMethod());
    if (request.httpMethod() == "POST"_s && request.httpBody()) {
        ResourceRequest copy = request;
        flattenBody(copy);
        if (RefPtr body = copy.httpBody()) {
            auto bytes = body->flatten();
            if (bytes.size() <= maxBody) {
                data->setString("body"_s, base64EncodeToString(bytes.span()));
                auto type = request.httpContentType();
                if (!type.isEmpty())
                    data->setString("contentType"_s, type);
            }
        }
    }
    auto referrer = request.httpReferrer();
    if (!referrer.isEmpty())
        data->setString("referrer"_s, referrer);
    if (!initiator.isEmpty())
        data->setString("initiator"_s, initiator);
    data->setBoolean("userGesture"_s, userGesture);
    emitEvent("navigation.crossSite"_s, WTF::move(data));
}

} // namespace Inception::SiteLock
