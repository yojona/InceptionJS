#include "config.h"
#include "bridge/Bridge.h"

#include "view/View.h"
#include "view/Window.h"

#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringHash.h>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <emscripten/em_macros.h>

extern "C" {
char* inception_host_ask(const char* json);
void inception_bridge_post(const char* json);
}

namespace Inception {

static HashMap<String, CommandHandler>& commands()
{
    static NeverDestroyed<HashMap<String, CommandHandler>> map;
    return map;
}

void registerCommand(const String& name, CommandHandler&& handler)
{
    commands().set(name, WTF::move(handler));
}

// Events of a page or a window say which window: the one named in the data,
// else the window of the tab it names, else the current window. Engine-wide
// events (downloads, history, the engine's own diagnostics) carry none.
static void tagWindow(JSON::Object& data)
{
    if (data.getValue("window"_s))
        return;
    Window* window = nullptr;
    if (auto tab = data.getInteger("tab"_s)) {
        if (auto* view = View::byID(*tab))
            window = &view->window();
    }
    if (!window)
        window = Window::current();
    if (window)
        data.setInteger("window"_s, window->id());
}

void emitEvent(const String& name, Ref<JSON::Object>&& data)
{
    tagWindow(data.get());
    auto message = JSON::Object::create();
    message->setString("event"_s, name);
    message->setObject("data"_s, WTF::move(data));
    inception_bridge_post(message->toJSONString().utf8().data());
}

void emitEvent(const String& name)
{
    emitEvent(name, JSON::Object::create());
}

void report(ASCIILiteral level, const String& message)
{
    auto data = JSON::Object::create();
    data->setString("level"_s, level);
    data->setString("message"_s, makeString("[engine] "_s, message));
    data->setString("source"_s, "engine"_s);
    data->setInteger("line"_s, 0);
    data->setInteger("column"_s, 0);
    emitEvent("console"_s, WTF::move(data));
}

RefPtr<JSON::Value> askHost(const String& question, Ref<JSON::Object>&& data)
{
    data->setString("question"_s, question);
    tagWindow(data.get());
    char* reply = inception_host_ask(data->toJSONString().utf8().data());
    if (!reply)
        return nullptr;
    auto value = JSON::Value::parseJSON(String::fromUTF8(reply));
    free(reply);
    return value;
}

} // namespace Inception

// Commands larger than this are refused before parsing: the biggest real one
// (init, with the page shims) is far smaller.
static constexpr size_t maxCommandBytes = 16 * 1024 * 1024;
static constexpr unsigned maxCommandName = 64;

static void refuse(ASCIILiteral reason)
{
    auto data = JSON::Object::create();
    data->setString("reason"_s, reason);
    Inception::emitEvent("bad-command"_s, WTF::move(data));
}

// Called from the engine worker's message listener (js/bridge.js) with a UTF-8
// JSON command: {"command": name, "args": {...}}. Anything else is refused and
// reported as "bad-command"; handlers only ever see an object of arguments.
extern "C" EMSCRIPTEN_KEEPALIVE void inception_bridge_receive(const char* json)
{
    if (!json || strnlen(json, maxCommandBytes + 1) > maxCommandBytes)
        return refuse("too large"_s);
    auto value = JSON::Value::parseJSON(String::fromUTF8(json));
    if (!value)
        return refuse("not JSON"_s);
    auto message = value->asObject();
    if (!message)
        return refuse("not an object"_s);
    auto nameValue = message->getValue("command"_s);
    String name;
    if (!nameValue || !nameValue->asString(name) || name.isEmpty() || name.length() > maxCommandName)
        return refuse("no command name"_s);
    auto argsValue = message->getValue("args"_s);
    RefPtr<JSON::Object> args;
    if (argsValue && argsValue->type() != JSON::Value::Type::Null) {
        args = argsValue->asObject();
        if (!args)
            return refuse("arguments are not an object"_s);
    }
    auto it = Inception::commands().find(name);
    if (it == Inception::commands().end()) {
        auto error = JSON::Object::create();
        error->setString("command"_s, name);
        Inception::emitEvent("unknown-command"_s, WTF::move(error));
        return;
    }
    if (!args)
        args = JSON::Object::create();
    // {window}: the window the command acts on, window 1 when absent. It must
    // name a window that exists; handlers then see it as the current one.
    unsigned window = 1;
    if (auto windowValue = args->getValue("window"_s)) {
        auto number = windowValue->asDouble();
        if (!number || *number < 1 || *number > 0xFFFFFFFF || *number != std::floor(*number))
            return refuse("window is not a positive integer"_s);
        window = static_cast<unsigned>(*number);
        if (!Inception::Window::byID(window))
            return refuse("no such window"_s);
    }
    Inception::WindowScope scope(window);
    it->value(*args);
}
