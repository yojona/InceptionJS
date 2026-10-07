#pragma once

#include <wtf/Function.h>
#include <wtf/JSONValues.h>
#include <wtf/text/WTFString.h>

namespace Inception {

// The one channel between the engine (on its pthread) and the host page. Both
// directions carry JSON objects; the version is checked once, at "init".
// Commands come in by name; events go out by name. Binary payloads (frames,
// media data) travel next to the JSON as transferables, never inside it.
constexpr unsigned bridgeVersion = 1;

using CommandHandler = Function<void(JSON::Object& args)>;

void registerCommand(const String& name, CommandHandler&&);
void emitEvent(const String& name, Ref<JSON::Object>&& data);
void emitEvent(const String& name);

} // namespace Inception
