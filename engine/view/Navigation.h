#pragma once

namespace Inception {

// back, forward, reload, stop, find, find.clear and zoom; see Navigation.cpp.
void registerNavigationCommands();

// Tells the host whether back and forward have somewhere to go.
void emitNavigationState();

} // namespace Inception
