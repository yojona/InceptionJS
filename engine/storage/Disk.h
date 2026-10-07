#pragma once

namespace Inception::Disk {

// The engine's disk: /inception is a directory of the host page's origin
// private file system (OPFS), so profiles survive reloads. Everything else in
// the file system (fonts, ICU data, /tmp) stays in memory. Without OPFS,
// /inception is in memory too and nothing persists. Returns whether it persists.
bool mount();
bool isPersistent();

} // namespace Inception::Disk
