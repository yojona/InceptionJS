#include "config.h"

#include "DOMWrapperWorld.h"
#include "JSDOMGlobalObject.h"
#include "LocalFrame.h"
#include "ScriptController.h"
#include "bridge/Bridge.h"
#include "net/NetworkLoad.h"
#include "view/View.h"
#include <JavaScriptCore/JSCJSValueInlines.h>

namespace Inception {
using namespace WebCore;

// {source, id}: evaluates script in the main frame and answers with a
// "debug.result" event carrying its string value. Development aid only; the
// host exposes it on the debug page, never through the public API.
void registerDebugCommands()
{
    // {enabled}: report network requests as console debug events.
    registerCommand("debug.netlog"_s, [](JSON::Object& args) {
        NetworkLoad::setLogging(args.getBoolean("enabled"_s).value_or(false));
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
}

} // namespace Inception
