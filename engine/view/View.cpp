#include "config.h"
#include "view/View.h"
#include "view/Window.h"

#include "CookieJar.h"
#include "SocketProvider.h"
#include "DatabaseProvider.h"
#include "DocumentView.h"
#include "EmptyClients.h"
#include "FloatRect.h"
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
#include <algorithm>
#include <cmath>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>
#include <wtf/SetForScope.h>
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
    configuration.backForwardClient = BackForwardList::create([this](bool added) {
        if (isActive()) {
            WindowScope scope(*this);
            emitNavigationState(added);
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
    // Pop-ups without a user gesture are refused in ChromeClientImpl::createWindow,
    // which reports them; WebCore's own blocker would drop them silently.
    settings.setJavaScriptCanOpenWindowsAutomatically(true);
    settings.setLoadsImagesAutomatically(true);
    settings.setRequestIdleCallbackEnabled(true);
    settings.setLocalStorageEnabled(true);
    settings.setSessionStorageEnabled(true);
    settings.setDataTransferItemsEnabled(true);
    // <a download>: off by default in WebCore, on in every browser.
    settings.setDownloadAttributeEnabled(true);
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

void View::load(ResourceRequest&& request)
{
    RefPtr frame = mainFrame();
    if (!frame)
        return;
    frame->loader().load(FrameLoadRequest(*frame, WTF::move(request)));
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

// Painting behavior ("perf.configure") and the timings "debug.frames" reports.
struct FramePerformance {
    bool paintOnInput { true };
    bool damage { true };
    // Milliseconds per painted frame: rendering update (style, layout, page
    // animation frames), then paint and present; and the share of the
    // viewport repainted.
    Vector<double> update;
    Vector<double> paint;
    Vector<double> area;
    // Scrolls whose pixels were moved, and those repainted instead.
    unsigned movedScrolls { 0 };
    unsigned repaintedScrolls { 0 };
};

static FramePerformance& framePerformance()
{
    static NeverDestroyed<FramePerformance> performance;
    return performance;
}

void View::configurePerformance(JSON::Object& args)
{
    auto& performance = framePerformance();
    performance.paintOnInput = args.getBoolean("paintOnInput"_s).value_or(performance.paintOnInput);
    performance.damage = args.getBoolean("damage"_s).value_or(performance.damage);
    for (auto* view : all())
        view->setNeedsPaint();
}

static Ref<JSON::Object> summary(Vector<double>& values)
{
    auto result = JSON::Object::create();
    if (values.isEmpty())
        return result;
    std::sort(values.begin(), values.end());
    double total = 0;
    for (double value : values)
        total += value;
    result->setDouble("avg"_s, total / values.size());
    result->setDouble("p50"_s, values[values.size() / 2]);
    result->setDouble("p95"_s, values[std::min(values.size() - 1, values.size() * 95 / 100)]);
    result->setDouble("max"_s, values.last());
    values.clear();
    return result;
}

Ref<JSON::Object> View::takeFrameStats()
{
    auto& performance = framePerformance();
    auto result = JSON::Object::create();
    result->setInteger("frames"_s, static_cast<int>(performance.paint.size()));
    result->setBoolean("paintOnInput"_s, performance.paintOnInput);
    result->setBoolean("damage"_s, performance.damage);
    result->setObject("update"_s, summary(performance.update));
    result->setObject("paint"_s, summary(performance.paint));
    result->setObject("area"_s, summary(performance.area));
    result->setInteger("movedScrolls"_s, std::exchange(performance.movedScrolls, 0));
    result->setInteger("repaintedScrolls"_s, std::exchange(performance.repaintedScrolls, 0));
    // Why WebCore would not report scrolls to be moved (slow scrolling).
    if (auto* view = singleton()) {
        if (RefPtr frame = view->mainFrame()) {
            if (RefPtr frameView = frame->view()) {
                result->setBoolean("canBlitOnScroll"_s, frameView->canBlitOnScroll());
                result->setBoolean("hasSlowRepaintObjects"_s, frameView->hasSlowRepaintObjects());
            }
        }
    }
    return result;
}

void View::setNeedsPaint()
{
    m_needsPaint = true;
    m_fullDamage = true;
    m_scroll = std::nullopt;
    if (isActive())
        requestFrame();
}

void View::setNeedsPaint(const IntRect& rect)
{
    m_needsPaint = true;
    m_damage.unite(Region(intersection(rect, IntRect({ }, m_cssSize))));
    if (isActive())
        requestFrame();
}

void View::scrolled(const IntSize& offset, const IntRect& scrolledRect)
{
    auto rect = intersection(scrolledRect, IntRect({ }, m_cssSize));
    // Moved pixels must land on whole device pixels, and one rect at a time.
    float scale = m_deviceScaleFactor;
    bool movable = framePerformance().damage && !m_fullDamage && scale == std::round(scale)
        && std::abs(offset.width()) < rect.width() && std::abs(offset.height()) < rect.height()
        && (!m_scroll || m_scroll->first == rect);
    if (!movable) {
        framePerformance().repaintedScrolls++;
        setNeedsPaint(rect);
        if (m_scroll)
            setNeedsPaint(m_scroll->first);
        return;
    }
    // What was already to be repainted inside the rect moved with it.
    Region inside = m_damage;
    inside.intersect(Region(rect));
    if (!inside.isEmpty()) {
        inside.translate(offset);
        inside.intersect(Region(rect));
        m_damage.unite(inside);
    }
    // The strips the content left uncovered.
    if (offset.height() > 0)
        m_damage.unite(Region({ rect.x(), rect.y(), rect.width(), offset.height() }));
    else if (offset.height() < 0)
        m_damage.unite(Region({ rect.x(), rect.maxY() + offset.height(), rect.width(), -offset.height() }));
    if (offset.width() > 0)
        m_damage.unite(Region({ rect.x(), rect.y(), offset.width(), rect.height() }));
    else if (offset.width() < 0)
        m_damage.unite(Region({ rect.maxX() + offset.width(), rect.y(), -offset.width(), rect.height() }));
    framePerformance().movedScrolls++;
    m_scroll = { rect, m_scroll ? m_scroll->second + offset : offset };
    m_needsPaint = true;
    if (isActive())
        requestFrame();
}

void View::slowScrolled(const IntRect& rect)
{
    framePerformance().repaintedScrolls++;
    setNeedsPaint(rect);
}

bool& View::isPaintingOverscanFlag()
{
    static bool painting = false;
    return painting;
}

void View::frameForInput()
{
    // At most one frame per display refresh: the host's tick still comes,
    // and finds nothing left to paint.
    if (!framePerformance().paintOnInput || !m_needsPaint || MonotonicTime::now() - m_lastPaint < 12_ms)
        return;
    frame();
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
    auto start = MonotonicTime::now();
    // WebCore moves a scroll's pixels only over opaque content, which it
    // learns from painting a root background; a page without one never
    // counts, though the base background is painted under it. Nothing shows
    // through the main frame here: its pixels can always move.
    if (RefPtr frame = mainFrame()) {
        if (RefPtr frameView = frame->view(); frameView && !frameView->isTransparent())
            frameView->setContentIsOpaque(true);
    }
    m_page->updateRendering();
    m_page->finalizeRenderingUpdate({ });

    if (!m_needsPaint)
        return;
    m_needsPaint = false;
    auto painting = MonotonicTime::now();
    m_lastPaint = painting;

    RefPtr frame = mainFrame();
    RefPtr frameView = frame ? frame->view() : nullptr;
    if (!frameView)
        return;

    if (m_paintedFrames++ < 3)
        report("debug"_s, makeString("frame "_s, m_paintedFrames, ' ', m_cssSize.width(), 'x', m_cssSize.height(), " @"_s, m_deviceScaleFactor));

    // The target holds the viewport and, with overscan, that many CSS pixels
    // of the page above and below it; rects below are in its CSS pixels.
    int overscan = m_window->overscan();
    IntSize targetSize { m_cssSize.width(), m_cssSize.height() + 2 * overscan };
    auto pixelSize = expandedIntSize(FloatSize(targetSize) * m_deviceScaleFactor);
    auto& performance = framePerformance();
    // What changed, in device pixels, rounded out a pixel more so that
    // antialiased edges of a fractional scale are repainted too. Past a few
    // rects, their bounds paint faster than each of them.
    std::optional<Renderer::Damage> damage;
    if (performance.damage && !m_fullDamage) {
        auto rects = m_damage.rects();
        if (rects.size() > 8)
            rects = { m_damage.bounds() };
        // A scroll of the whole viewport moves the margins too, and uncovers
        // a strip at the target's edge as well as at the viewport's.
        bool mainScroll = m_scroll && m_scroll->first.y() == 0 && m_scroll->first.height() == m_cssSize.height();
        for (auto& rect : rects)
            rect.move(0, overscan);
        if (overscan && mainScroll) {
            auto& [scrolledRect, offset] = *m_scroll;
            if (offset.height() > 0)
                rects.append({ scrolledRect.x(), 0, scrolledRect.width(), offset.height() });
            else if (offset.height() < 0)
                rects.append({ scrolledRect.x(), targetSize.height() + offset.height(), scrolledRect.width(), -offset.height() });
            if (offset.width())
                rects.append({ offset.width() > 0 ? scrolledRect.x() : scrolledRect.maxX() + offset.width(), 0, std::abs(offset.width()), targetSize.height() });
        }
        Renderer::Damage region;
        for (auto& rect : rects) {
            FloatRect scaled(rect);
            scaled.scale(m_deviceScaleFactor);
            auto device = enclosingIntRect(scaled);
            device.inflate(1);
            device.intersect(IntRect({ }, pixelSize));
            if (!device.isEmpty())
                region.append(device);
        }
        damage = WTF::move(region);
    }
    std::optional<Renderer::Scroll> scroll;
    if (damage && m_scroll) {
        IntRect rect = m_scroll->first;
        if (rect.y() == 0 && rect.height() == m_cssSize.height())
            rect.setHeight(targetSize.height());
        else
            rect.move(0, overscan);
        rect.scale(m_deviceScaleFactor);
        auto offset = m_scroll->second;
        offset.scale(m_deviceScaleFactor);
        scroll = Renderer::Scroll { rect, offset };
    }
    m_fullDamage = false;
    m_damage = { };
    m_scroll = std::nullopt;

    auto scrollPosition = frameView->scrollPosition();
    Renderer::FrameInfo info { scrollPosition.x(), scrollPosition.y(), overscan };
    double painted = 0;
    Region repainted;
    Renderer::singleton().paintFrame(m_window->id(), pixelSize, damage, scroll, info, [&](GraphicsContext& context, const IntRect& region) {
        painted += static_cast<double>(region.area().value()) / std::max(1u, pixelSize.area().value());
        context.scale(m_deviceScaleFactor);
        FloatRect css(region);
        css.scale(1 / m_deviceScaleFactor);
        auto cssRect = intersection(enclosingIntRect(css), IntRect({ }, targetSize));
        // The viewport, as the page shows it (scrollbars and fixed elements
        // included).
        auto viewport = intersection(cssRect, { 0, overscan, m_cssSize.width(), m_cssSize.height() });
        if (!viewport.isEmpty()) {
            viewport.move(0, -overscan);
            repainted.unite(Region(viewport));
            GraphicsContextStateSaver saver(context);
            context.translate(0, overscan);
            frameView->paint(context, viewport);
        }
        // The margins: the page's content just above and below the viewport.
        for (IntRect margin : { IntRect { 0, 0, m_cssSize.width(), overscan }, IntRect { 0, overscan + m_cssSize.height(), m_cssSize.width(), overscan } }) {
            margin.intersect(cssRect);
            if (margin.isEmpty())
                continue;
            margin.move(scrollPosition.x(), scrollPosition.y() - overscan);
            GraphicsContextStateSaver saver(context);
            SetForScope paintingOverscan(isPaintingOverscanFlag(), true);
            context.translate(-scrollPosition.x(), overscan - scrollPosition.y());
            context.clip(margin);
            frameView->paintContents(context, margin);
        }
    });
    // Videos outside what this frame painted kept their place.
    Media::endFrame(m_window->id(), repainted);

    auto end = MonotonicTime::now();
    // The last 600 frames at most, for "debug.frames".
    if (performance.paint.size() < 600) {
        performance.update.append((painting - start).milliseconds());
        performance.paint.append((end - painting).milliseconds());
        performance.area.append(painted);
    }
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
