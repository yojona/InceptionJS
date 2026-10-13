#include "config.h"
#include "net/LinkPolicy.h"

#include "RegistrableDomain.h"
#include "ResourceRequest.h"
#include "bridge/Bridge.h"
#include "link/Link.h"
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringHash.h>

namespace Inception::LinkPolicy {
using namespace WebCore;

struct Rules {
    std::optional<Vector<String>> allow;
    Vector<String> block;
    std::optional<String> site;
    bool thirdParty { true };
};

static HashMap<unsigned, Rules>& rules()
{
    static NeverDestroyed<HashMap<unsigned, Rules>> map;
    return map;
}

static const Rules* rulesOf(unsigned link)
{
    auto it = rules().find(link);
    return it == rules().end() ? nullptr : &it->value;
}

static bool matches(const String& host, const String& pattern)
{
    if (host == pattern)
        return true;
    return host.length() > pattern.length() && host.endsWith(pattern) && host[host.length() - pattern.length() - 1] == '.';
}

static Vector<String> hostList(JSON::Object& args, ASCIILiteral name)
{
    Vector<String> hosts;
    if (auto list = args.getArray(name)) {
        for (auto& value : *list) {
            auto host = value->asString().convertToASCIILowercase();
            if (!host.isEmpty() && host.length() <= 253)
                hosts.append(host);
        }
    }
    return hosts;
}

// The site of a URL: its registrable domain, or its host where there is none
// (an IP address, localhost). Empty for URLs without a host.
static String siteOf(const URL& url)
{
    if (url.host().isEmpty())
        return { };
    RegistrableDomain domain { url };
    return domain.isEmpty() ? url.host().convertToASCIILowercase() : domain.string();
}

bool allows(unsigned link, const URL& url)
{
    auto* entry = rulesOf(link);
    if (!entry)
        return true;
    auto host = url.host().convertToASCIILowercase();
    for (auto& pattern : entry->block) {
        if (matches(host, pattern))
            return false;
    }
    if (!entry->allow)
        return true;
    for (auto& pattern : *entry->allow) {
        if (matches(host, pattern))
            return true;
    }
    return false;
}

std::optional<String> site(unsigned link)
{
    auto* entry = rulesOf(link);
    return entry ? entry->site : std::nullopt;
}

bool isLinkSite(unsigned link, const URL& url)
{
    auto* entry = rulesOf(link);
    if (!entry || !entry->site)
        return true;
    auto other = siteOf(url);
    return !entry->site->isEmpty() && other == *entry->site;
}

bool allowsSiteData(unsigned link, const URL& url)
{
    auto* entry = rulesOf(link);
    if (!entry || !entry->site || entry->thirdParty)
        return true;
    return isLinkSite(link, url);
}

void restrict(unsigned link, ResourceRequest& request)
{
    auto* entry = rulesOf(link);
    if (!entry || !entry->site)
        return;
    if (!allowsSiteData(link, request.url()))
        request.setAllowCookies(false);
    // The content engine's word on whose page made the request is not taken:
    // the first party is the link's site.
    URL firstParty { makeString("https://"_s, *entry->site, '/') };
    if (entry->site->isEmpty() || siteOf(request.firstPartyForCookies()) != *entry->site)
        request.setFirstPartyForCookies(entry->site->isEmpty() ? URL { } : firstParty);
    if (!isLinkSite(link, request.url()))
        request.setIsSameSite(false);
}

void registerCommands()
{
    registerCommand("link.policy"_s, [](JSON::Object& args) {
        auto link = args.getInteger("link"_s).value_or(0);
        if (link <= 0)
            return;
        Rules entry;
        if (args.getArray("allow"_s))
            entry.allow = hostList(args, "allow"_s);
        entry.block = hostList(args, "block"_s);
        if (auto value = args.getValue("site"_s); value && value->type() == JSON::Value::Type::String) {
            auto site = value->asString().convertToASCIILowercase();
            entry.site = site.length() <= 253 ? site : emptyString();
        }
        auto thirdParty = args.getString("thirdParty"_s);
        entry.thirdParty = thirdParty.isEmpty() ? !entry.site : thirdParty == "allow"_s;
        rules().set(link, WTF::move(entry));
    });
    registerCommand("site.of"_s, [](JSON::Object& args) {
        auto data = JSON::Object::create();
        data->setDouble("id"_s, args.getDouble("id"_s).value_or(0));
        URL url { args.getString("url"_s) };
        data->setString("site"_s, url.protocolIsInHTTPFamily() ? siteOf(url) : emptyString());
        emitEvent("site.result"_s, WTF::move(data));
    });
    Link::addCloseObserver([](Link& link) {
        if (link.isServiceEnd())
            rules().remove(link.id());
    });
}

} // namespace Inception::LinkPolicy
