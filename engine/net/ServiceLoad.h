#pragma once

namespace Inception {

// The profile service's side of content engines' loads (net/RemoteLoad.h):
// each one fetched with curl, the profile's cookies and the relay, streamed
// back over the link it came from.
void installServiceLoads();

} // namespace Inception
