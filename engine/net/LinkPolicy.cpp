#include "config.h"
#include "net/LinkPolicy.h"

#include "bridge/Bridge.h"
#include "link/Link.h"
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/StringHash.h>

namespace Inception::LinkPolicy {

struct Rules {
    std::optional<Vector<String>> allow;
    Vector<String> block;
};

static HashMap<unsigned, Rules>& rules()
{
    static NeverDestroyed<HashMap<unsigned, Rules>> map;
    return map;
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

bool allows(unsigned link, const URL& url)
{
    auto it = rules().find(link);
    if (it == rules().end())
        return true;
    auto host = url.host().convertToASCIILowercase();
    for (auto& pattern : it->value.block) {
        if (matches(host, pattern))
            return false;
    }
    if (!it->value.allow)
        return true;
    for (auto& pattern : *it->value.allow) {
        if (matches(host, pattern))
            return true;
    }
    return false;
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
        rules().set(link, WTF::move(entry));
    });
    Link::addCloseObserver([](Link& link) {
        if (link.isServiceEnd())
            rules().remove(link.id());
    });
}

} // namespace Inception::LinkPolicy
