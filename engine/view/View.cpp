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
#include "modules/Modules.h"
#include "net/Session.h"
#include "net/WebSocketChannel.h"
#include "storage/IndexedDB.h"
#include "storage/WebStorage.h"
#include "view/BackForward.h"
#include "view/Clients.h"
#include "view/Navigation.h"
#include "view/Preferences.h"
#include <emscripten/em_macros.h>
#include <pal/SessionID.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>
#include <wtf/text/MakeString.h>

extern "C" {
void inception_gfx_request_frame();
}

namespace Inception {
using namespace WebCore;

static Vector<View*>& views()
{
    static NeverDestroyed<Vector<View*>> list;
    return list;
}

static View* s_active;

static void emitTab(const String& name, View& view)
{
    auto data = JSON::Object::create();
    data->setInteger("tab"_s, view.id());
    emitEvent(name, WTF::move(data));
}

View& View::create(IntSize cssSize, float deviceScaleFactor)
{
    RELEASE_ASSERT(views().isEmpty());
    auto* view = new View(cssSize, deviceScaleFactor);
    views().append(view);
    s_active = view;
    view->setVisible(true);
    return *view;
}

View* View::singleton()
{
    return s_active;
}

const Vector<View*>& View::all()
{
    return views();
}

View* View::byID(unsigned id)
{
    for (auto* view : views()) {
        if (view->id() == id)
            return view;
    }
    return nullptr;
}

View& View::createTab(unsigned openerID)
{
    RELEASE_ASSERT(s_active);
    auto* view = new View(s_active->cssSize(), s_active->deviceScaleFactor());
    views().append(view);
    view->setUserAgent(s_active->userAgent());
    applyPagePreferences(view->page());
    view->setVisible(false);
    auto data = JSON::Object::create();
    data->setInteger("tab"_s, view->id());
    if (openerID)
        data->setInteger("opener"_s, openerID);
    emitEvent("tab.created"_s, WTF::move(data));
    return *view;
}

void View::activate(unsigned id)
{
    auto* view = byID(id);
    if (!view || view == s_active)
        return;
    auto* previous = s_active;
    s_active = view;
    previous->setVisible(false);
    // Hidden tabs keep the size they had; take the view's current one.
    view->m_cssSize = previous->m_cssSize;
    view->m_deviceScaleFactor = previous->m_deviceScaleFactor;
    view->m_page->setDeviceScaleFactor(view->m_deviceScaleFactor);
    if (RefPtr frame = view->mainFrame()) {
        if (RefPtr frameView = frame->view())
            frameView->resize(view->m_cssSize);
    }
    view->setVisible(true);
    emitTab("tab.activated"_s, *view);
    emitNavigationState();
    view->setNeedsPaint();
}

void View::close(unsigned id)
{
    auto* view = byID(id);
    if (!view || views().size() == 1)
        return;
    // Script may be running in the tab that asked to close (window.close()).
    RunLoop::mainSingleton().dispatch([id] {
        auto* view = byID(id);
        if (!view || views().size() == 1)
            return;
        if (view == s_active) {
            auto index = views().find(view);
            activate(views()[index ? index - 1 : 1]->id());
        }
        views().removeFirst(view);
        delete view;
        auto data = JSON::Object::create();
        data->setInteger("tab"_s, id);
        emitEvent("tab.closed"_s, WTF::move(data));
    });
}

View::View(IntSize cssSize, float deviceScaleFactor)
    : m_cssSize(cssSize)
    , m_deviceScaleFactor(deviceScaleFactor)
{
    static unsigned lastID;
    m_id = ++lastID;

    // A page without an identifier gets no media session manager, and without
    // one WebCore never lets a media element start playing.
    auto configuration = pageConfigurationWithEmptyClients(PageIdentifier::generate(), PAL::SessionID::defaultSessionID());
    configuration.chromeClient = makeUniqueRef<ChromeClientImpl>(*this);
    configuration.cookieJar = createCookieJar();
    configuration.socketProvider = createSocketProvider();
    configuration.databaseProvider = createDatabaseProvider();
    configuration.storageNamespaceProvider = createStorageNamespaceProvider();
    configuration.editorClient = makeUniqueRef<EditorClientImpl>();
    configuration.backForwardClient = BackForwardList::create([this] {
        if (isActive())
            emitNavigationState();
    });
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
    installModules(*m_page);

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
#if ENABLE(WEB_AUDIO)
    settings.setWebAudioEnabled(true);
#endif
#if ENABLE(OFFSCREEN_CANVAS)
    settings.setOffscreenCanvasEnabled(true);
#endif
    // Present and answered as a browser that declined: share() rejects until
    // the embedder provides a share sheet, and caches.open() rejects until
    // the profile stores them.
    settings.setWebShareEnabled(true);
    settings.setCacheAPIEnabled(true);
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
}

View::~View()
{
    if (RefPtr frame = mainFrame())
        frame->loader().detachFromParent();
    m_page->destroyRenderTrees();
    m_page = nullptr;
}

// Hidden tabs keep running, as background tabs do: timers are throttled and
// rendering stops until they are shown again.
void View::setVisible(bool visible)
{
    if (visible)
        m_page->setActivityState({ ActivityState::WindowIsActive, ActivityState::IsFocused, ActivityState::IsVisible, ActivityState::IsVisibleOrOccluded, ActivityState::IsInWindow });
    else
        m_page->setActivityState({ ActivityState::IsInWindow });
    m_page->setIsVisible(visible);
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
    if (!isActive())
        return;
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
    if (isActive())
        requestFrame();
}

void View::requestFrame()
{
    inception_gfx_request_frame();
}

void View::frame()
{
    if (!isActive())
        return;
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

// js/gfx.js: the engine's WebGL context was restored; the next frame rebuilds
// Skia's context and repaints everything.
extern "C" EMSCRIPTEN_KEEPALIVE void inception_gfx_context_restored()
{
    if (auto* view = Inception::View::singleton())
        view->setNeedsPaint();
}

extern "C" EMSCRIPTEN_KEEPALIVE void inception_gfx_frame()
{
    if (auto* view = Inception::View::singleton())
        view->frame();
}
