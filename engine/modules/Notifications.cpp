#include "config.h"

#if ENABLE(NOTIFICATIONS)

#include "Notification.h"
#include "NotificationClient.h"
#include "NotificationData.h"
#include "NotificationResources.h"
#include "Page.h"
#include "ScriptExecutionContext.h"
#include "SecurityOrigin.h"
#include "bridge/Bridge.h"
#include "modules/Permissions.h"
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>

namespace Inception {
using namespace WebCore;

// The Notification API: permission per origin from the host's policy (kept for
// the session), and notifications the host shows its own way.
class NotificationClientImpl final : public NotificationClient {
public:
    bool show(ScriptExecutionContext&, NotificationData&& data, RefPtr<NotificationResources>&&, CompletionHandler<void()>&& completion) final
    {
        auto id = data.notificationID.toString();
        auto event = JSON::Object::create();
        event->setString("id"_s, id);
        event->setString("title"_s, data.title);
        event->setString("body"_s, data.body);
        event->setString("icon"_s, data.iconURL);
        event->setString("tag"_s, data.tag);
        event->setString("origin"_s, data.originString);
        m_shown.set(id, std::make_unique<NotificationData>(WTF::move(data)));
        emitEvent("notification.show"_s, WTF::move(event));
        completion();
        return true;
    }

    void cancel(NotificationData&& data) final
    {
        auto event = JSON::Object::create();
        event->setString("id"_s, data.notificationID.toString());
        emitEvent("notification.close"_s, WTF::move(event));
    }

    void notificationObjectDestroyed(NotificationData&& data) final
    {
        m_shown.remove(data.notificationID.toString());
    }

    void notificationControllerDestroyed() final { }

    void requestPermission(ScriptExecutionContext& context, PermissionHandler&& handler) final
    {
        auto origin = context.securityOrigin() ? context.securityOrigin()->toString() : String { };
        auto known = m_permissions.get(origin);
        if (known != Permission::Default)
            return handler(known);
        Permissions::request(Permissions::Kind::Notifications, origin, [this, origin, handler = WTF::move(handler)](bool granted) mutable {
            auto permission = granted ? Permission::Granted : Permission::Denied;
            m_permissions.set(origin, permission);
            handler(permission);
        });
    }

    Permission checkPermission(ScriptExecutionContext* context) final
    {
        if (!context || !context->securityOrigin())
            return Permission::Denied;
        return m_permissions.get(context->securityOrigin()->toString());
    }

    // The host reports what the person did with a notification.
    void dispatch(const String& id, bool clicked)
    {
        auto it = m_shown.find(id);
        if (it == m_shown.end())
            return;
        Notification::ensureOnNotificationThread(*it->value, [clicked](Notification* notification) {
            if (!notification)
                return;
            if (clicked)
                notification->dispatchClickEvent();
            else
                notification->dispatchCloseEvent();
        });
    }

private:
    HashMap<String, std::unique_ptr<NotificationData>> m_shown;
    HashMap<String, Permission> m_permissions;
};

static NotificationClientImpl& client()
{
    static NeverDestroyed<NotificationClientImpl> client;
    return client.get();
}

void provideNotifications(Page& page)
{
    WebCore::provideNotification(&page, &client());
}

void registerNotificationCommands()
{
    // {id}
    registerCommand("notification.click"_s, [](JSON::Object& args) {
        client().dispatch(args.getString("id"_s), true);
    });
    registerCommand("notification.closed"_s, [](JSON::Object& args) {
        client().dispatch(args.getString("id"_s), false);
    });
}

} // namespace Inception

#endif // ENABLE(NOTIFICATIONS)
