#include "config.h"

#include "GraphicsLayer.h"

namespace WebCore {

// Until the layer compositor exists, accelerated compositing is off and
// nothing should ask for layers. A few features still create them on demand
// (view transitions, for one); they get layers that hold state but never draw,
// instead of aborting the engine.
class DetachedGraphicsLayer final : public GraphicsLayer {
public:
    DetachedGraphicsLayer(Type type, GraphicsLayerClient& client)
        : GraphicsLayer(type, client)
    {
    }

private:
    void setNeedsDisplay() final { }
    void setNeedsDisplayInRect(const FloatRect&, ShouldClipToLayer) final { }
};

Ref<GraphicsLayer> GraphicsLayer::create(GraphicsLayerFactory*, GraphicsLayerClient& client, Type type)
{
    return adoptRef(*new DetachedGraphicsLayer(type, client));
}

} // namespace WebCore
