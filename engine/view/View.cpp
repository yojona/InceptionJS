#include "config.h"
#include "view/View.h"

#include "CookieJar.h"
#include "DocumentView.h"
#include "EmptyClients.h"
#include "FrameLoadRequest.h"
#include "FrameLoader.h"
#include "GraphicsContext.h"
#include "LocalFrameInlines.h"
#include "LocalFrameView.h"
#include "Page.h"
#include "PageConfiguration.h"
#include "ResourceRequest.h"
#include "Settings.h"
#include "gfx/Renderer.h"
#include "net/Session.h"
#include "view/Clients.h"
#include <emscripten/em_macros.h>
#include <pal/SessionID.h>

extern "C" {
void inception_gfx_request_frame();
}

namespace Inception {
using namespace WebCore;

static View* s_view;

View& View::create(IntSize cssSize, float deviceScaleFactor)
{
    RELEASE_ASSERT(!s_view);
    s_view = new View(cssSize, deviceScaleFactor);
    return *s_view;
}

View* View::singleton()
{
    return s_view;
}

View::View(IntSize cssSize, float deviceScaleFactor)
    : m_cssSize(cssSize)
    , m_deviceScaleFactor(deviceScaleFactor)
{
    auto configuration = pageConfigurationWithEmptyClients(std::nullopt, PAL::SessionID::defaultSessionID());
    configuration.chromeClient = makeUniqueRef<ChromeClientImpl>(*this);
    configuration.cookieJar = createCookieJar();
    configuration.mainFrameCreationParameters = PageConfiguration::LocalMainFrameCreationParameters {
        CompletionHandler<UniqueRef<LocalFrameLoaderClient>(LocalFrame&, FrameLoader&)> { [this](auto& frame, auto& frameLoader) {
            return makeUniqueRefWithoutRefCountedCheck<FrameLoaderClientImpl>(frameLoader, frame, *this);
        } },
        { },
        ReferrerPolicy::EmptyString
    };

    m_page = Page::create(WTF::move(configuration));

    auto& settings = m_page->settings();
    settings.setScriptEnabled(true);
    // Until the layer compositor lands, everything paints into one surface.
    settings.setAcceleratedCompositingEnabled(false);

    // The main frame must exist before activity state reaches it.
    if (RefPtr frame = mainFrame())
        frame->init();

    m_page->setDeviceScaleFactor(m_deviceScaleFactor);
    m_page->setActivityState({ ActivityState::WindowIsActive, ActivityState::IsFocused, ActivityState::IsVisible, ActivityState::IsVisibleOrOccluded, ActivityState::IsInWindow });
    m_page->setIsVisible(true);
}

LocalFrame* View::mainFrame() const
{
    return dynamicDowncast<LocalFrame>(m_page->mainFrame());
}

void View::load(const URL& url)
{
    RefPtr frame = mainFrame();
    if (!frame)
        return;
    frame->loader().load(FrameLoadRequest(*frame, ResourceRequest(URL { url })));
}

void View::resize(IntSize cssSize, float deviceScaleFactor)
{
    m_cssSize = cssSize;
    if (deviceScaleFactor != m_deviceScaleFactor) {
        m_deviceScaleFactor = deviceScaleFactor;
        m_page->setDeviceScaleFactor(deviceScaleFactor);
    }
    Renderer::singleton().resize(expandedIntSize(FloatSize(cssSize) * deviceScaleFactor));
    if (RefPtr frame = mainFrame()) {
        if (RefPtr view = frame->view())
            view->resize(cssSize);
    }
    setNeedsPaint();
}

void View::setNeedsPaint()
{
    m_needsPaint = true;
    requestFrame();
}

void View::requestFrame()
{
    inception_gfx_request_frame();
}

void View::frame()
{
    m_page->updateRendering();
    m_page->finalizeRenderingUpdate({ });

    if (!m_needsPaint)
        return;
    m_needsPaint = false;

    RefPtr frame = mainFrame();
    RefPtr frameView = frame ? frame->view() : nullptr;
    if (!frameView)
        return;

    Renderer::singleton().paintFrame([&](GraphicsContext& context) {
        context.scale(m_deviceScaleFactor);
        frameView->paint(context, IntRect({ }, m_cssSize));
    });
}

} // namespace Inception

extern "C" EMSCRIPTEN_KEEPALIVE void inception_gfx_frame()
{
    if (auto* view = Inception::View::singleton())
        view->frame();
}
