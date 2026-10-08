#include "config.h"

#include "FloatSize.h"
#include "NavigatorBase.h"
#include "UserAgent.h"
#include "IntSize.h"
#include "bridge/Bridge.h"
#include "gfx/Renderer.h"
#include "input/Input.h"
#include "media/MediaBridge.h"
#include "modules/Modules.h"
#include "net/Download.h"
#include "net/Sockets.h"
#include "storage/Disk.h"
#include "storage/History.h"
#include "storage/Profile.h"
#include "wasm/GuestWasm.h"
#include "platform/Strategies.h"
#include "view/Preferences.h"
#include "view/Navigation.h"
#include "view/View.h"
#include "CurlContext.h"
#include "CurlRequestScheduler.h"
#include "CurlStreamScheduler.h"
#include "CommonVM.h"
#include <JavaScriptCore/InitializeThreading.h>
#include <JavaScriptCore/JSLock.h>
#include <JavaScriptCore/Options.h>
#include <JavaScriptCore/VM.h>
#include <cstdlib>
#include <emscripten.h>
#include <wtf/MainThread.h>
#include <wtf/RunLoop.h>

extern "C" {
void inception_loop_schedule(double delayMs);
int inception_gfx_page_context_cap();
}

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

static void registerCommands()
{
    // The host finds the engine's worker and greets it; the reply carries the
    // bridge version the host must speak.
    registerCommand("hello"_s, [](JSON::Object&) {
        auto started = JSON::Object::create();
        started->setInteger("version"_s, bridgeVersion);
        emitEvent("started"_s, WTF::move(started));
    });

    // {width, height, deviceScaleFactor, gpu: bool, url?} -> "ready" {version, renderer}
    registerCommand("init"_s, [](JSON::Object& args) {
        if (View::singleton())
            return;
        auto cssSize = sizeFrom(args);
        float scale = args.getDouble("deviceScaleFactor"_s).value_or(1);
        bool preferGPU = args.getBoolean("gpu"_s).value_or(true);
        if (auto media = args.getObject("media"_s))
            Media::setCapabilities(*media);
        GuestWasm::setPolyfill(args.getString("wasmPolyfill"_s));
        setPageShims(args.getString("pageShims"_s));
        Sockets::configure(args.getString("wispUrl"_s));
        // Before the page exists: storage opens its files on first use.
        bool persistent = Disk::mount();
        Profile::select(args.getString("profile"_s), args.getBoolean("freshProfile"_s).value_or(false));
        auto mode = Renderer::singleton().initialize(expandedIntSize(FloatSize(cssSize) * scale), preferGPU, args.getInteger("webglContexts"_s).value_or(0));
        View::create(cssSize, scale);
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
        emitEvent("ready"_s, WTF::move(ready));

        auto url = args.getString("url"_s);
        if (!url.isEmpty())
            View::singleton()->load(URL { url });
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
    Inception::registerPreferenceCommands();
    Inception::Media::install();
    Inception::registerDebugCommands();
    Inception::registerModuleCommands();
    Inception::registerNavigationCommands();
    Inception::History::registerCommands();
    Inception::Download::registerCommands();

    // The host listens on every worker it creates and recognizes the engine's
    // by this event; "hello" repeats it on request.
    auto started = JSON::Object::create();
    started->setInteger("version"_s, Inception::bridgeVersion);
    Inception::emitEvent("started"_s, WTF::move(started));

    // The engine lives on in this worker's event loop.
    emscripten_exit_with_live_runtime();
    return 0;
}
