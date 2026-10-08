#include "config.h"

#if ENABLE(GEOLOCATION)

#include "Document.h"
#include "Geolocation.h"
#include "GeolocationClient.h"
#include "GeolocationController.h"
#include "GeolocationError.h"
#include "GeolocationPositionData.h"
#include "Page.h"
#include "SecurityOrigin.h"
#include "bridge/Bridge.h"
#include "modules/Permissions.h"
#include "view/View.h"
#include <wtf/NeverDestroyed.h>
#include <wtf/RefCounted.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/WallTime.h>

namespace Inception {
using namespace WebCore;

// navigator.geolocation: permission comes from the host's policy, positions
// from the host's provider (its own navigator.geolocation, or the embedder's).
class GeolocationClientImpl final : public GeolocationClient, public RefCounted<GeolocationClientImpl> {
    WTF_MAKE_TZONE_ALLOCATED(GeolocationClientImpl);
public:
    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    void geolocationDestroyed() final { }

    void startUpdating(const String&, bool needsHighAccuracy) final
    {
        m_highAccuracy = needsHighAccuracy;
        auto data = JSON::Object::create();
        data->setBoolean("highAccuracy"_s, needsHighAccuracy);
        emitEvent("geolocation.start"_s, WTF::move(data));
    }

    void stopUpdating() final
    {
        emitEvent("geolocation.stop"_s);
    }

    void setEnableHighAccuracy(bool enable) final
    {
        if (enable == m_highAccuracy)
            return;
        startUpdating({ }, enable);
    }

    std::optional<GeolocationPositionData> lastPosition() final { return m_lastPosition; }

    void requestPermission(Geolocation& geolocation) final
    {
        RefPtr document = geolocation.document();
        auto origin = document ? document->securityOrigin().toString() : String { };
        Permissions::request(Permissions::Kind::Geolocation, origin, [geolocation = Ref { geolocation }](bool granted) {
            geolocation->setIsAllowed(granted, { });
        });
    }

    void cancelPermissionRequest(Geolocation&) final { }

    void positionChanged(GeolocationPositionData&& position)
    {
        m_lastPosition = position;
        if (auto* view = View::singleton()) {
            if (auto* controller = GeolocationController::from(&view->page()))
                controller->positionChanged(m_lastPosition);
        }
    }

    void errorOccurred(GeolocationError::ErrorCode code, const String& message)
    {
        if (auto* view = View::singleton()) {
            if (auto* controller = GeolocationController::from(&view->page())) {
                auto error = GeolocationError::create(code, message);
                controller->errorOccurred(error.get());
            }
        }
    }

private:
    std::optional<GeolocationPositionData> m_lastPosition;
    bool m_highAccuracy { false };
};

WTF_MAKE_TZONE_ALLOCATED_IMPL(GeolocationClientImpl);

static GeolocationClientImpl& client()
{
    static NeverDestroyed<Ref<GeolocationClientImpl>> client { adoptRef(*new GeolocationClientImpl) };
    return client.get();
}

void provideGeolocation(Page& page)
{
    WebCore::provideGeolocationTo(&page, client());
}

void registerGeolocationCommands()
{
    // {latitude, longitude, accuracy, timestamp?, altitude?, altitudeAccuracy?, heading?, speed?}
    registerCommand("geolocation.position"_s, [](JSON::Object& args) {
        auto optional = [&](ASCIILiteral name) { return args.getDouble(name); };
        GeolocationPositionData position {
            args.getDouble("timestamp"_s).value_or(WallTime::now().secondsSinceEpoch().value()),
            args.getDouble("latitude"_s).value_or(0),
            args.getDouble("longitude"_s).value_or(0),
            args.getDouble("accuracy"_s).value_or(0),
            optional("altitude"_s), optional("altitudeAccuracy"_s), optional("heading"_s), optional("speed"_s), std::nullopt
        };
        client().positionChanged(WTF::move(position));
    });

    // {denied: bool, message}
    registerCommand("geolocation.error"_s, [](JSON::Object& args) {
        auto code = args.getBoolean("denied"_s).value_or(false) ? GeolocationError::PermissionDenied : GeolocationError::PositionUnavailable;
        client().errorOccurred(code, args.getString("message"_s));
    });
}

} // namespace Inception

#endif // ENABLE(GEOLOCATION)
