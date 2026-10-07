#include "config.h"
#include "view/View.h"

#include "CookieJar.h"
#include "SocketProvider.h"
#include "DatabaseProvider.h"
#include "DocumentView.h"
#include "EmptyClients.h"
#include "FrameLoadRequest.h"
#include "FrameLoader.h"
#include "GraphicsContext.h"
#include "LocalFrameInlines.h"
#include "LocalFrameView.h"
#include "MemoryCache.h"
#include "Page.h"
#include "PageIdentifier.h"
#include "PageConfiguration.h"
#include "ResourceRequest.h"
#include "Settings.h"
#include "StorageNamespaceProvider.h"
#include "bridge/Bridge.h"
#include "gfx/Renderer.h"
#include "input/EditingClient.h"
#include "media/HostCDM.h"
#include "media/MediaBridge.h"
#include "net/Session.h"
#include "net/WebSocketChannel.h"
#include "storage/IndexedDB.h"
#include "storage/WebStorage.h"
#include "view/Clients.h"
#include <emscripten/em_macros.h>
#include <pal/SessionID.h>
#include <wtf/text/MakeString.h>

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
    // A page without an identifier gets no media session manager, and without
    // one WebCore never lets a media element start playing.
    auto configuration = pageConfigurationWithEmptyClients(PageIdentifier::generate(), PAL::SessionID::defaultSessionID());
    configuration.chromeClient = makeUniqueRef<ChromeClientImpl>(*this);
    configuration.cookieJar = createCookieJar();
    configuration.socketProvider = createSocketProvider();
    configuration.databaseProvider = createDatabaseProvider();
    configuration.storageNamespaceProvider = createStorageNamespaceProvider();
    configuration.editorClient = makeUniqueRef<EditorClientImpl>();
    configuration.mainFrameCreationParameters = PageConfiguration::LocalMainFrameCreationParameters {
        CompletionHandler<UniqueRef<LocalFrameLoaderClient>(LocalFrame&, FrameLoader&)> { [this](auto& frame, auto& frameLoader) {
            return makeUniqueRefWithoutRefCountedCheck<FrameLoaderClientImpl>(frameLoader, frame, *this);
        } },
        { },
        ReferrerPolicy::EmptyString
    };

    m_page = Page::create(WTF::move(configuration));
#if ENABLE(ENCRYPTED_MEDIA)
    Media::provideMediaKeySystem(*m_page);
#endif

    // Raw WebCore defaults are off for most of what a browser turns on; each of
    // these is a feature pages expect.
    auto& settings = m_page->settings();
    settings.setScriptEnabled(true);
    settings.setLoadsImagesAutomatically(true);
    settings.setRequestIdleCallbackEnabled(true);
    settings.setLocalStorageEnabled(true);
    settings.setSessionStorageEnabled(true);
    settings.setDataTransferItemsEnabled(true);
    // Features shipping browsers have on; raw WebCore defaults them off.
    settings.setBeaconAPIEnabled(true);
    settings.setCompressionStreamEnabled(true);
    settings.setCrossOriginEmbedderPolicyEnabled(true);
    settings.setCrossOriginOpenerPolicyEnabled(true);
    settings.setLazyIframeLoadingEnabled(true);
    settings.setLazyImageLoadingEnabled(true);
    settings.setMediaCapabilitiesEnabled(true);
    settings.setMediaCapabilitiesExtensionsEnabled(true);
    settings.setUserActivationAPIEnabled(true);
    settings.setVisualViewportAPIEnabled(true);
    settings.setAsyncClipboardAPIEnabled(true);
    settings.setPermissionsAPIEnabled(true);
    settings.setFullScreenEnabled(true);
#if ENABLE(WEBGL)
    settings.setWebGLEnabled(true);
#endif
#if ENABLE(ENCRYPTED_MEDIA)
    settings.setEncryptedMediaAPIEnabled(true);
#endif
    settings.setMinimumLogicalFontSize(9);
    settings.setStandardFontFamily("serif"_s);
    settings.setSerifFontFamily("serif"_s);
    settings.setSansSerifFontFamily("sans-serif"_s);
    settings.setFixedFontFamily("monospace"_s);
    // Players treat ManagedMediaSource as a different streaming client; the
    // host mirror implements plain MediaSource.
    settings.setManagedMediaSourceEnabled(false);
    settings.setCanvasUsesAcceleratedDrawing(Renderer::singleton().mode() == Renderer::Mode::GPU);
    // Until the layer compositor lands, everything paints into one surface.
    settings.setAcceleratedCompositingEnabled(false);

    // The default memory cache (8 MB) holds less than one modern page.
    MemoryCache::singleton().setCapacities(0, 16 * 1024 * 1024, 64 * 1024 * 1024);

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

    if (m_paintedFrames++ < 3)
        report("debug"_s, makeString("frame "_s, m_paintedFrames, ' ', m_cssSize.width(), 'x', m_cssSize.height(), " @"_s, m_deviceScaleFactor));

    Renderer::singleton().paintFrame([&](GraphicsContext& context) {
        context.scale(m_deviceScaleFactor);
        frameView->paint(context, IntRect({ }, m_cssSize));
    });
    Media::endFrame();
}

} // namespace Inception

extern "C" EMSCRIPTEN_KEEPALIVE void inception_gfx_frame()
{
    if (auto* view = Inception::View::singleton())
        view->frame();
}
