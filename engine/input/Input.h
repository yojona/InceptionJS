#pragma once

#include <wtf/JSONValues.h>

namespace Inception {

// Registers the bridge commands that carry user input from the host page:
// mouse, wheel, key and focus. Positions are CSS pixels relative to the view.
void registerInputCommands();

// The same input, delivered by the agent (agent/Agent.cpp): it reaches the
// page exactly as a person's does.
void dispatchMouse(JSON::Object&);
void dispatchWheel(JSON::Object&);
void dispatchKey(JSON::Object&);

} // namespace Inception
