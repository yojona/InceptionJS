#include "config.h"

#include "FloatSize.h"
#include "NavigatorBase.h"
#include "UserAgent.h"
#include "IntSize.h"
#include "agent/Agent.h"
#include "bridge/Bridge.h"
#include "gfx/Renderer.h"
#include "input/Input.h"
#include "link/Link.h"
#include "media/MediaBridge.h"
#include "modules/Modules.h"
#include "net/Download.h"
#include "net/LinkPolicy.h"
#include "net/RemoteLoad.h"
#include "net/ServiceLoad.h"
#include "net/SharedCookies.h"
#include "net/Sockets.h"
#include "net/WebSocketChannel.h"
#include "storage/Disk.h"
#include "storage/History.h"
#include "storage/IndexedDB.h"
#include "storage/Profile.h"
#include "storage/WebStorage.h"
#include "wasm/GuestWasm.h"
#include "platform/Strategies.h"
#include "view/Clients.h"
#include "view/Preferences.h"
#include "view/Navigation.h"
#include "view/View.h"
#include "view/Window.h"
#include "CurlContext.h"
#include "CurlRequestScheduler.h"
#include "CurlStreamScheduler.h"
#include "CommonVM.h"
#include "ProcessIdentifier.h"
#include <JavaScriptCore/InitializeThreading.h>
#include <JavaScriptCore/JSLock.h>
#include <JavaScriptCore/Options.h>
#include <JavaScriptCore/VM.h>
#include <cstdlib>
#include <emscripten.h>
#include <emscripten/em_js.h>
#include <wtf/MainThread.h>
#include <wtf/CryptographicallyRandomNumber.h>
#include <wtf/RunLoop.h>

extern "C" {
void inception_loop_schedule(double delayMs);
int inception_gfx_page_context_cap();
}

// How many interpreter entries may nest on this thread, 0 for the default (see
// the recursion patch): the thread's native stack is the host browser's, and WebKit's
// worker stacks are smaller than Chromium's and Firefox's.
EM_JS(int, inception_host_recursion_depth, (), {
    const agent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    return /AppleWebKit/.test(agent) && !/Chrome|Chromium|Edg/.test(agent) ? 40 : 0;
});

namespace Inception {
using namespace WebCore;

void registerDebugCommands();

static IntSize sizeFrom(JSON::Object& args)
{
    return { args.getInteger("width"_s).value_or(800), args.getInteger("height"_s).value_or(600) };
}

// navigator.platform as the browser the user agent names reports it.
static String platformForUserAgent(const String& userAgent)
{
    if (userAgent.contains("iPhone"_s))
        return "iPhone"_s;
    if (userAgent.contains("iPad"_s))
        return "iPad"_s;
    if (userAgent.contains("Macintosh"_s))
        return "MacIntel"_s;
    if (userAgent.contains("Windows"_s))
        return "Win32"_s;
    if (userAgent.contains("Android"_s))
        return "Linux armv81"_s;
    if (userAgent.contains("Linux"_s))
        return "Linux x86_64"_s;
    return emptyString();
}

// "started" {version, features}: what this engine speaks beyond the bridge
// version. "windows": commands and events carry window ids. "roles": "init"
// takes a role, and the engine can be a profile service or a content engine
// joined to one by a link (link/Link.h).
static Ref<JSON::Object> startedEvent()
{
    auto started = JSON::Object::create();
    started->setInteger("version"_s, bridgeVersion);
    auto features = JSON::Array::create();
    features->pushString("windows"_s);
    features->pushString("roles"_s);
    started->setArray("features"_s, WTF::move(features));
    return started;
}

// The host numbers each content engine of a document; without a number, a
// random one.
static void setContentIdentifier(int number)
{
    uint64_t raw = number > 0 ? static_cast<uint64_t>(number) : cryptographicallyRandomNumber<uint64_t>();
    if (!ProcessIdentifier::isValidIdentifier(raw))
        raw = 1;
    Process::setIdentifier(ProcessIdentifier { raw });
}

// "init" with role "profile": the profile's files, cookies, storage and
// network, and no page. {profile, freshProfile, ephemeral?, wispUrl,
// preferences?} -> "ready" {version, role, persistent}.
static void startProfileService(JSON::Object& args)
{
    setRole(Role::Profile);
    bool ephemeral = args.getBoolean("ephemeral"_s).value_or(false);
    // `opfs` false: the host found the origin-private file system unusable
    // (a private window, say), so the profile stays in memory.
    bool usable = args.getBoolean("opfs"_s).value_or(true);
    bool persistent = Disk::mount(ephemeral || !usable ? Disk::Storage::Memory : Disk::Storage::Persistent);
    Profile::select(args.getString("profile"_s), args.getBoolean("freshProfile"_s).value_or(false));
    Sockets::configure(args.getString("wispUrl"_s));
    if (auto preferences = args.getObject("preferences"_s))
        applyPreferences(*preferences);
    installServiceLoads();
    installServiceWebSockets();
    installCookieService();
    LinkPolicy::registerCommands();
    installStorageService();
    installIDBService();
    Download::installService();
    History::installService();

    auto ready = JSON::Object::create();
    ready->setInteger("version"_s, bridgeVersion);
    ready->setString("role"_s, "profile"_s);
    ready->setBoolean("persistent"_s, persistent);
    emitEvent("ready"_s, WTF::move(ready));
}

static void registerCommands()
{
    // The host finds the engine's worker and greets it; the reply carries the
    // bridge version the host must speak.
    registerCommand("hello"_s, [](JSON::Object&) {
        emitEvent("started"_s, startedEvent());
    });

    // {width, height, deviceScaleFactor, gpu: bool, url?, role?} -> "ready"
    // {version, renderer, role}. `role`: "profile" or "content" (see
    // link/Link.h); without it the engine is standalone, as before roles.
    registerCommand("init"_s, [](JSON::Object& args) {
        static bool initialized;
        if (initialized)
            return;
        initialized = true;
        // The debug commands run script in the page and inject it into every
        // window: they exist only when the embedder turned debugging on.
        if (args.getBoolean("debug"_s).value_or(false)) {
            registerDebugCommands();
            registerLinkDebugCommands();
        }
        auto roleName = args.getString("role"_s);
        if (roleName == "profile"_s) {
            startProfileService(args);
            return;
        }
        bool content = roleName == "content"_s;
        if (content) {
            setRole(Role::Content);
            RemoteLoad::install();
            installRemoteWebSockets();
            installCookieProxy();
            installStorageProxy();
            installIDBProxy();
            // Its IDB connection is known to the service by this process
            // identifier: unique among the service's engines.
            setContentIdentifier(args.getInteger("engine"_s).value_or(0));
        }
        auto cssSize = sizeFrom(args);
        float scale = args.getDouble("deviceScaleFactor"_s).value_or(1);
        bool preferGPU = args.getBoolean("gpu"_s).value_or(true);
        if (auto media = args.getObject("media"_s))
            Media::setCapabilities(*media);
        GuestWasm::setPolyfill(args.getString("wasmPolyfill"_s));
        setPageShims(args.getString("pageShims"_s));
        // A content engine has no network and no files of its own: what needs
        // them goes to its profile service.
        if (!content)
            Sockets::configure(args.getString("wispUrl"_s));
        // Before the page exists: storage opens its files on first use.
        bool persistent = Disk::mount(content || !args.getBoolean("opfs"_s).value_or(true) ? Disk::Storage::Memory : Disk::Storage::Persistent);
        Profile::select(args.getString("profile"_s), args.getBoolean("freshProfile"_s).value_or(false));
        auto mode = Renderer::singleton().initialize(expandedIntSize(FloatSize(cssSize) * scale), preferGPU, args.getInteger("webglContexts"_s).value_or(0));
        View::create(cssSize, scale);
        setPopupsOpenWindows(args.getString("popups"_s) == "window"_s);
        auto userAgent = args.getString("userAgent"_s);
        View::singleton()->setUserAgent(userAgent);
        if (auto preferences = args.getObject("preferences"_s))
            applyPreferences(*preferences);
        NavigatorBase::setPlatformName(platformForUserAgent(userAgent.isEmpty() ? standardUserAgent() : userAgent));

        auto ready = JSON::Object::create();
        ready->setInteger("version"_s, bridgeVersion);
        ready->setString("renderer"_s, mode == Renderer::Mode::GPU ? "gpu"_s : "cpu"_s);
        ready->setBoolean("persistent"_s, persistent);
        ready->setInteger("webglContexts"_s, inception_gfx_page_context_cap());
        ready->setInteger("tab"_s, View::singleton()->id());
        ready->setInteger("window"_s, View::singleton()->window().id());
        ready->setString("role"_s, content ? "content"_s : "standalone"_s);

        emitEvent("ready"_s, WTF::move(ready));

        auto url = args.getString("url"_s);
        if (!url.isEmpty())
            View::singleton()->load(URL { url });
    });

    // {width, height, deviceScaleFactor, url?, opener?, visible?} ->
    // "window.created" {window, tab, opener?}. A window starts hidden until
    // a display shows it ("window.visibility").
    registerCommand("window.create"_s, [](JSON::Object& args) {
        if (!View::singleton())
            return;
        auto* model = Window::current();
        auto cssSize = sizeFrom(args);
        float scale = args.getDouble("deviceScaleFactor"_s).value_or(model ? model->deviceScaleFactor() : 1);
        auto& window = Window::create(cssSize, scale);
        WindowScope scope(window.id());
        auto& tab = View::createFirst(window);
        auto data = JSON::Object::create();
        data->setInteger("window"_s, window.id());
        data->setInteger("tab"_s, tab.id());
        auto opener = args.getInteger("opener"_s).value_or(0);
        if (opener > 0 && View::byID(opener))
            data->setInteger("opener"_s, opener);
        emitEvent("window.created"_s, WTF::move(data));
        window.setVisible(args.getBoolean("visible"_s).value_or(false));
        auto url = args.getString("url"_s);
        if (!url.isEmpty())
            tab.load(URL { url });
    });
    // {window} -> "window.closed" {window}, with "tab.closed" for each tab.
    // Window 1 lives as long as the engine.
    registerCommand("window.close"_s, [](JSON::Object&) {
        auto* window = Window::current();
        if (!window)
            return;
        if (window->id() == 1) {
            auto data = JSON::Object::create();
            data->setString("reason"_s, "window 1 cannot be closed"_s);
            emitEvent("bad-command"_s, WTF::move(data));
            return;
        }
        Window::close(window->id());
    });
    // {window, visible}: a hidden window does not paint; its pages keep
    // loading and running, as hidden tabs do.
    registerCommand("window.visibility"_s, [](JSON::Object& args) {
        if (auto* window = Window::current())
            window->setVisible(args.getBoolean("visible"_s).value_or(true));
    });

    registerCommand("load"_s, [](JSON::Object& args) {
        if (auto* view = View::singleton())
            view->load(URL { args.getString("url"_s) });
    });

    registerCommand("resize"_s, [](JSON::Object& args) {
        if (auto* view = View::singleton())
            view->resize(sizeFrom(args), args.getDouble("deviceScaleFactor"_s).value_or(view->deviceScaleFactor()));
    });
}

} // namespace Inception

// Socket activity (js/tcp.js): run the network schedulers now.
extern "C" EMSCRIPTEN_KEEPALIVE void inception_net_pump()
{
    auto& context = WebCore::CurlContext::singleton();
    context.scheduler().pumpNow();
    context.streamScheduler().pumpNow();
}

extern "C" EMSCRIPTEN_KEEPALIVE void inception_loop_iterate()
{
    WTF::RunLoop::cycle();
    // Called from the worker's event loop, so no native frame below holds cells.
    if (auto* vm = WebCore::commonVMOrNull(); vm && vm->heap.hasDeferredCollections()) {
        JSC::JSLockHolder lock(*vm);
        vm->heap.runDeferredCollections();
    }
}

int main()
{
    // ICU reads its data archive from the engine file system.
    setenv("ICU_DATA", "/usr/share/icu", 1);

    // Collections must finish within one top-level turn (see
    // inception_loop_iterate); a concurrent one would resume mid-stack.
    setenv("JSC_useConcurrentGC", "false", 1);

    // The interpreter's JavaScript stack: about as deep as other browsers
    // allow (some ten thousand frames), and shallow enough that runaway
    // recursion fails fast.
    setenv("JSC_maxPerThreadStackUsage", "2097152", 1);

    // The count of nested entries starts above zero, which leaves `depth` of
    // the limit to the page.
    if (unsigned depth = inception_host_recursion_depth())
        JSC::cloopEntryDepth = JSC::maxCLoopEntryDepth - depth;

    JSC::initialize();
    WTF::initializeMainThread();
    Inception::installPlatformStrategies();
    if (JSC::Options::useConcurrentGC())
        Inception::report("error"_s, "concurrent GC is on; collections may resume mid-stack"_s);
    WebCore::commonVM().heap.deferCollectionsToTopLevel([] {
        inception_loop_schedule(0);
    });

    WTF::RunLoop::setWakeUpCallback([] {
        inception_loop_schedule(0);
    });
    WTF::RunLoop::setNextTimerCallback([](Seconds delay) {
        inception_loop_schedule(delay.milliseconds());
    });

    Inception::registerCommands();
    Inception::registerInputCommands();
    Inception::ChromeClientImpl::registerCommands();
    Inception::registerPreferenceCommands();
    Inception::Media::install();
    Inception::registerModuleCommands();
    Inception::registerNavigationCommands();
    Inception::History::registerCommands();
    Inception::Download::registerCommands();
    Inception::Agent::registerCommands();

    // The host listens on every worker it creates and recognizes the engine's
    // by this event; "hello" repeats it on request.
    Inception::emitEvent("started"_s, Inception::startedEvent());

    // The engine lives on in this worker's event loop.
    emscripten_exit_with_live_runtime();
    return 0;
}
