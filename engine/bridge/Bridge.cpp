#include "config.h"
#include "bridge/Bridge.h"

#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringHash.h>
#include <cstdlib>
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

void emitEvent(const String& name, Ref<JSON::Object>&& data)
{
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
    char* reply = inception_host_ask(data->toJSONString().utf8().data());
    if (!reply)
        return nullptr;
    auto value = JSON::Value::parseJSON(String::fromUTF8(reply));
    free(reply);
    return value;
}

} // namespace Inception

// Called from the engine worker's message listener (js/bridge.js) with a UTF-8
// JSON command: {"command": name, "args": {...}}.
extern "C" EMSCRIPTEN_KEEPALIVE void inception_bridge_receive(const char* json)
{
    auto value = JSON::Value::parseJSON(String::fromUTF8(json));
    if (!value)
        return;
    auto message = value->asObject();
    if (!message)
        return;
    auto name = message->getString("command"_s);
    auto it = Inception::commands().find(name);
    if (it == Inception::commands().end()) {
        auto error = JSON::Object::create();
        error->setString("command"_s, name);
        Inception::emitEvent("unknown-command"_s, WTF::move(error));
        return;
    }
    auto args = message->getObject("args"_s);
    if (!args)
        args = JSON::Object::create();
    it->value(*args);
}
