#include "config.h"
#include "wasm/GuestWasm.h"

#include "DOMWrapperWorld.h"
#include "JSDOMGlobalObject.h"
#include "LocalFrame.h"
#include "ScriptController.h"
#include "ScriptSourceCode.h"
#include <JavaScriptCore/Completion.h>
#include <JavaScriptCore/Error.h>
#include <JavaScriptCore/JSArrayBufferView.h>
#include <JavaScriptCore/JSCJSValueInlines.h>
#include <JavaScriptCore/JSFunction.h>
#include <JavaScriptCore/SourceCode.h>
#include <cstdlib>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

extern "C" {
// Blocks until the host has translated the module; returns a malloc'ed UTF-8
// string: "ok:" + JavaScript, or "error:" + message.
char* inception_wasm_translate(const uint8_t*, size_t);
}

namespace Inception::GuestWasm {
using namespace WebCore;

static String& polyfill()
{
    static NeverDestroyed<String> source;
    return source;
}

void setPolyfill(String&& source)
{
    polyfill() = WTF::move(source);
}

// translate(bytes: ArrayBufferView) -> factory(importObject) -> exports.
// The factory carries the module's import and export lists as __meta. It is
// created by evaluating the translation directly, not through eval(), so a
// page's Content Security Policy does not block it.
static JSC_DECLARE_HOST_FUNCTION(translateModule);
JSC_DEFINE_HOST_FUNCTION(translateModule, (JSC::JSGlobalObject* globalObject, JSC::CallFrame* callFrame))
{
    auto& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto* view = JSC::jsDynamicCast<JSC::JSArrayBufferView*>(callFrame->argument(0));
    if (!view || view->isDetached())
        return JSC::throwVMTypeError(globalObject, scope, "expected the module bytes"_s);

    auto bytes = view->span();
    char* reply = inception_wasm_translate(bytes.data(), bytes.size());
    auto text = String::fromUTF8(reply);
    free(reply);

    if (!text.startsWith("ok:"_s))
        return JSC::throwVMError(globalObject, scope, JSC::createError(globalObject, text.startsWith("error:"_s) ? text.substring(6) : "translation failed"_s));

    auto source = JSC::makeSource(text.substring(3), JSC::SourceOrigin { }, JSC::SourceTaintedOrigin::Untainted, "wasm"_s);
    NakedPtr<JSC::Exception> exception;
    auto factory = JSC::evaluate(globalObject, source, JSC::jsUndefined(), exception);
    if (exception) {
        scope.throwException(globalObject, exception.get());
        return { };
    }
    return JSC::JSValue::encode(factory);
}

void installInWindow(LocalFrame& frame, DOMWrapperWorld& world)
{
    if (polyfill().isEmpty() || !world.isNormal())
        return;
    auto& script = frame.script();
    auto* globalObject = script.globalObject(world);
    if (!globalObject)
        return;
    auto& vm = globalObject->vm();
    auto* function = JSC::JSFunction::create(vm, globalObject, 1, "translate"_s, translateModule, JSC::ImplementationVisibility::Public);
    globalObject->putDirect(vm, JSC::Identifier::fromString(vm, "__inceptionWasmTranslate"_s), function);
    script.executeScriptIgnoringException(polyfill(), JSC::SourceTaintedOrigin::Untainted);
}

} // namespace Inception::GuestWasm
