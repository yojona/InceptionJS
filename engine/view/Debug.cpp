#include "config.h"

#include "DOMWrapperWorld.h"
#include "JSDOMGlobalObject.h"
#include "LocalFrame.h"
#include "ScriptController.h"
#include "CommonVM.h"
#include "bridge/Bridge.h"
#include "net/NetworkLoad.h"
#include "view/View.h"
#include <JavaScriptCore/JSCJSValueInlines.h>
#include <JavaScriptCore/JSLock.h>
#include <emscripten/heap.h>
#include <wtf/NeverDestroyed.h>

namespace Inception {
using namespace WebCore;

static String& injectedScript()
{
    static NeverDestroyed<String> source;
    return source;
}

// Runs the script set with "debug.inject" in each new window, before the
// page's own scripts. Development aid for tracing what pages touch.
void runInjectedScript(LocalFrame& frame, DOMWrapperWorld& world)
{
    if (injectedScript().isEmpty() || !world.isNormal())
        return;
    frame.script().executeScriptIgnoringException(injectedScript(), JSC::SourceTaintedOrigin::Untainted);
}

// {source, id}: evaluates script in the main frame and answers with a
// "debug.result" event carrying its string value. Development aid only; the
// host exposes it on the debug page, never through the public API.
void registerDebugCommands()
{
    // {enabled}: report network requests as console debug events.
    registerCommand("debug.netlog"_s, [](JSON::Object& args) {
        NetworkLoad::setLogging(args.getBoolean("enabled"_s).value_or(false));
    });

    // {source}: see runInjectedScript; an empty source stops it.
    registerCommand("debug.inject"_s, [](JSON::Object& args) {
        injectedScript() = args.getString("source"_s);
    });

    registerCommand("debug.evaluate"_s, [](JSON::Object& args) {
        auto* view = View::singleton();
        RefPtr frame = view ? view->mainFrame() : nullptr;
        auto result = JSON::Object::create();
        result->setInteger("id"_s, args.getInteger("id"_s).value_or(0));
        if (frame) {
            auto& script = frame->script();
            auto value = script.executeScriptIgnoringException(args.getString("source"_s), JSC::SourceTaintedOrigin::Untainted);
            auto* globalObject = script.globalObject(mainThreadNormalWorldSingleton());
            result->setString("value"_s, value ? value.toWTFString(globalObject) : "undefined"_s);
        }
        emitEvent("debug.result"_s, WTF::move(result));
    });

    // {}: answers with a "debug.heap" event: JS heap and wasm memory sizes,
    // in bytes.
    registerCommand("debug.heap"_s, [](JSON::Object&) {
        auto& vm = commonVM();
        JSC::JSLockHolder lock(vm);
        auto result = JSON::Object::create();
        result->setDouble("heapSize"_s, vm.heap.size());
        result->setDouble("heapCapacity"_s, vm.heap.capacity());
        result->setDouble("memory"_s, emscripten_get_heap_size());
        emitEvent("debug.heap"_s, WTF::move(result));
    });
}

} // namespace Inception
