#pragma once

namespace Inception {

// back, forward, reload, stop, find, find.clear and zoom; see Navigation.cpp.
void registerNavigationCommands();

// Tells the host whether back and forward have somewhere to go.
void emitNavigationState();

// Where pages' window.open() and target=_blank go: a new tab in the opener's
// window (the default), or a new window (view/Clients.cpp).
void setPopupsOpenWindows(bool);

} // namespace Inception
