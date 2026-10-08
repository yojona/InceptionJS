#include "config.h"
#include "modules/Modules.h"

#include "DOMWrapperWorld.h"
#include "LocalFrame.h"
#include "Page.h"
#include "ScriptController.h"
#include "modules/Permissions.h"
#include <wtf/NeverDestroyed.h>

namespace Inception {
using namespace WebCore;

#if ENABLE(GEOLOCATION)
void provideGeolocation(Page&);
void registerGeolocationCommands();
#endif
#if ENABLE(NOTIFICATIONS)
void provideNotifications(Page&);
void registerNotificationCommands();
#endif

void installModules(Page& page)
{
#if ENABLE(GEOLOCATION)
    provideGeolocation(page);
#endif
#if ENABLE(NOTIFICATIONS)
    provideNotifications(page);
#endif
    UNUSED_PARAM(page);
}

void registerModuleCommands()
{
    Permissions::install();
#if ENABLE(GEOLOCATION)
    registerGeolocationCommands();
#endif
#if ENABLE(NOTIFICATIONS)
    registerNotificationCommands();
#endif
}

static String& pageShims()
{
    static NeverDestroyed<String> source;
    return source;
}

void setPageShims(String&& source)
{
    pageShims() = WTF::move(source);
}

void installPageShims(LocalFrame& frame, DOMWrapperWorld& world)
{
    if (pageShims().isEmpty() || !world.isNormal())
        return;
    frame.script().executeScriptIgnoringException(pageShims(), JSC::SourceTaintedOrigin::Untainted);
}

} // namespace Inception
