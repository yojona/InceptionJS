#include "config.h"

#include "FloatSize.h"
#include "IntSize.h"
#include "bridge/Bridge.h"
#include "gfx/Renderer.h"
#include "input/Input.h"
#include "media/MediaBridge.h"
#include "platform/Strategies.h"
#include "view/View.h"
#include "CurlContext.h"
#include "CurlRequestScheduler.h"
#include "CurlStreamScheduler.h"
#include <JavaScriptCore/InitializeThreading.h>
#include <cstdlib>
#include <emscripten.h>
#include <wtf/MainThread.h>
#include <wtf/RunLoop.h>

extern "C" {
void inception_loop_schedule(double delayMs);
}

namespace Inception {
using namespace WebCore;

static IntSize sizeFrom(JSON::Object& args)
{
    return { args.getInteger("width"_s).value_or(800), args.getInteger("height"_s).value_or(600) };
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
        auto mode = Renderer::singleton().initialize(expandedIntSize(FloatSize(cssSize) * scale), preferGPU);
        View::create(cssSize, scale);

        auto ready = JSON::Object::create();
        ready->setInteger("version"_s, bridgeVersion);
        ready->setString("renderer"_s, mode == Renderer::Mode::GPU ? "gpu"_s : "cpu"_s);
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

// Socket data arrived (posted by js/wisp.js from the page's main thread).
extern "C" EMSCRIPTEN_KEEPALIVE void inception_net_pump()
{
    auto& context = WebCore::CurlContext::singleton();
    context.scheduler().pumpNow();
    context.streamScheduler().pumpNow();
}

extern "C" EMSCRIPTEN_KEEPALIVE void inception_loop_iterate()
{
    WTF::RunLoop::cycle();
}

int main()
{
    // ICU reads its data archive from the engine file system.
    setenv("ICU_DATA", "/usr/share/icu", 1);

    JSC::initialize();
    WTF::initializeMainThread();
    Inception::installPlatformStrategies();

    WTF::RunLoop::setWakeUpCallback([] {
        inception_loop_schedule(0);
    });
    WTF::RunLoop::setNextTimerCallback([](Seconds delay) {
        inception_loop_schedule(delay.milliseconds());
    });

    Inception::registerCommands();
    Inception::registerInputCommands();
    Inception::Media::install();

    // The host listens on every worker it creates and recognizes the engine's
    // by this event; "hello" repeats it on request.
    auto started = JSON::Object::create();
    started->setInteger("version"_s, Inception::bridgeVersion);
    Inception::emitEvent("started"_s, WTF::move(started));

    // The engine lives on in this worker's event loop.
    emscripten_exit_with_live_runtime();
    return 0;
}
