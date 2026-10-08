#include "config.h"
#include "modules/Permissions.h"

#include "bridge/Bridge.h"
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>

namespace Inception::Permissions {

static HashMap<uint64_t, CompletionHandler<void(bool)>>& pending()
{
    static NeverDestroyed<HashMap<uint64_t, CompletionHandler<void(bool)>>> requests;
    return requests;
}

static ASCIILiteral name(Kind kind)
{
    switch (kind) {
    case Kind::Geolocation:
        return "geolocation"_s;
    case Kind::Notifications:
        return "notifications"_s;
    }
    return ""_s;
}

void request(Kind kind, const String& origin, CompletionHandler<void(bool)>&& completion)
{
    static uint64_t nextID;
    auto id = ++nextID;
    pending().add(id, WTF::move(completion));
    auto data = JSON::Object::create();
    data->setDouble("id"_s, id);
    data->setString("kind"_s, name(kind));
    data->setString("origin"_s, origin);
    emitEvent("permission.request"_s, WTF::move(data));
}

void install()
{
    // {id, granted}
    registerCommand("permission.reply"_s, [](JSON::Object& args) {
        auto id = static_cast<uint64_t>(args.getDouble("id"_s).value_or(0));
        if (auto completion = pending().take(id))
            completion(args.getBoolean("granted"_s).value_or(false));
    });
}

} // namespace Inception::Permissions
