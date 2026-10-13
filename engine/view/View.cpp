#include "config.h"
#include "view/View.h"
#include "view/Window.h"

#include "CookieJar.h"
#include "SocketProvider.h"
#include "DatabaseProvider.h"
#include "DocumentView.h"
#include "EmptyClients.h"
#include "FloatSize.h"
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
void inception_gfx_request_frame(unsigned window);
}

namespace Inception {
using namespace WebCore;

static Vector<View*>& views()
{
    static NeverDestroyed<Vector<View*>> list;
    return list;
}

static void emitTab(const String& name, View& view)
{
    auto data = JSON::Object::create();
    data->setInteger("tab"_s, view.id());
    emitEvent(name, WTF::move(data));
}

View& View::create(IntSize cssSize, float deviceScaleFactor)
{
    RELEASE_ASSERT(views().isEmpty());
    auto& window = Window::create(cssSize, deviceScaleFactor);
    auto& view = createFirst(window);
    window.setVisible(true);
    return view;
}

View& View::createFirst(Window& window)
{
    auto* view = new View(window, window.cssSize(), window.deviceScaleFactor());
    views().append(view);
    window.setActiveTab(view);
    if (auto* other = Window::byID(1); other && other->activeTab() && other->activeTab() != view)
        view->setUserAgent(other->activeTab()->userAgent());
    applyPagePreferences(view->page());
    view->setVisible(window.isVisible());
    return *view;
}

bool View::isActive() const
{
    return m_window->activeTab() == this;
}

View* View::singleton()
{
    auto* window = Window::current();
    if (!window)
        window = Window::focused();
    if (!window)
        window = Window::byID(1);
    return window ? window->activeTab() : nullptr;
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

View* View::fromPage(const Page* page)
{
    if (!page)
        return nullptr;
    for (auto* view : views()) {
        if (view->m_page.get() == page)
            return view;
    }
    return nullptr;
}

View& View::createTab(unsigned openerID)
{
    auto* opener = openerID ? byID(openerID) : nullptr;
    auto* window = opener ? &opener->window() : Window::current();
    if (!window)
        window = Window::byID(1);
    RELEASE_ASSERT(window);
    return createTab(*window, openerID);
}

View& View::createTab(Window& window, unsigned openerID)
{
    auto* model = window.activeTab() ? window.activeTab() : singleton();
    auto* view = new View(window, window.cssSize(), window.deviceScaleFactor());
    views().append(view);
    if (model)
        view->setUserAgent(model->userAgent());
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
    if (!view)
        return;
    auto& window = view->window();
    auto* previous = window.activeTab();
    if (view == previous)
        return;
    WindowScope scope(window.id());
    window.setActiveTab(view);
    if (previous)
        previous->setVisible(false);
    // Hidden tabs keep the size they had; take the window's current one.
    view->m_cssSize = window.cssSize();
    view->m_deviceScaleFactor = window.deviceScaleFactor();
    view->m_page->setDeviceScaleFactor(view->m_deviceScaleFactor);
    if (RefPtr frame = view->mainFrame()) {
        if (RefPtr frameView = frame->view())
            frameView->resize(view->m_cssSize);
    }
    view->setVisible(window.isVisible());
    emitTab("tab.activated"_s, *view);
    emitNavigationState();
    view->setNeedsPaint();
}

void View::close(unsigned id)
{
    auto* view = byID(id);
    if (!view || view->window().tabs().size() == 1)
        return;
    // Script may be running in the tab that asked to close (window.close()).
    RunLoop::mainSingleton().dispatch([id] {
        auto* view = byID(id);
        if (!view)
            return;
        auto tabs = view->window().tabs();
        if (tabs.size() == 1)
            return;
        if (view->isActive()) {
            auto index = tabs.find(view);
            activate(tabs[index ? index - 1 : 1]->id());
        }
        destroy(*view);
    });
}

void View::destroy(View& view)
{
    unsigned id = view.id();
    unsigned windowID = view.window().id();
    if (view.isActive())
        view.window().setActiveTab(nullptr);
    views().removeFirst(&view);
    delete &view;
    auto data = JSON::Object::create();
    data->setInteger("tab"_s, id);
    data->setInteger("window"_s, windowID);
    emitEvent("tab.closed"_s, WTF::move(data));
}

View::View(Window& window, IntSize cssSize, float deviceScaleFactor)
    : m_window(&window)
    , m_cssSize(cssSize)
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
        if (isActive()) {
            WindowScope scope(*this);
            emitNavigationState();
        }
    });
    configuration.mainFrameCreationParameters = PageConfiguration::LocalMainFrameCreationParameters {
        CompletionHandler<UniqueRef<LocalFrameLoaderClient>(LocalFrame&, FrameLoader&)> { [this](auto& frame, auto& frameLoader) {
            return makeUniqueRefWithoutRefCountedCheck<FrameLoaderClientImpl>(frameLoader, frame, *this);
        } },
        { },
        ReferrerPolicy::EmptyString
    };

    m_page = Page::create(WTF::move(configuration));
    // Every page in one group: storage events reach the profile's other tabs
    // and windows, as in a browser.
    m_page->setGroupName("inception"_s);
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
    m_window->setSize(cssSize, deviceScaleFactor);
    m_cssSize = cssSize;
    if (deviceScaleFactor != m_deviceScaleFactor) {
        m_deviceScaleFactor = deviceScaleFactor;
        m_page->setDeviceScaleFactor(deviceScaleFactor);
    }
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
    if (isActive() && m_window->isVisible())
        inception_gfx_request_frame(m_window->id());
}

void View::frame()
{
    if (!isActive() || !m_window->isVisible())
        return;
    WindowScope scope(*this);
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

    Renderer::singleton().paintFrame(m_window->id(), expandedIntSize(FloatSize(m_cssSize) * m_deviceScaleFactor), [&](GraphicsContext& context) {
        context.scale(m_deviceScaleFactor);
        frameView->paint(context, IntRect({ }, m_cssSize));
    });
    Media::endFrame(m_window->id());
}

} // namespace Inception

// js/gfx.js: the engine's WebGL context was restored; the next frame of
// every window rebuilds Skia's context and repaints everything.
extern "C" EMSCRIPTEN_KEEPALIVE void inception_gfx_context_restored()
{
    for (auto* window : Inception::Window::all()) {
        if (auto* view = window->activeTab())
            view->setNeedsPaint();
    }
}

// The host's animation frame for one window (0, from an older host: window 1).
extern "C" EMSCRIPTEN_KEEPALIVE void inception_gfx_frame(unsigned windowID)
{
    auto* window = Inception::Window::byID(windowID ? windowID : 1);
    if (auto* view = window ? window->activeTab() : nullptr)
        view->frame();
}
