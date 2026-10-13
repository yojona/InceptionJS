#pragma once

#include <wtf/URL.h>

namespace Inception::LinkPolicy {

// Where each content engine may go, decided by the host and enforced by the
// profile service: a content engine whose code was subverted still reaches
// only what its window was allowed, since every load, socket, ping and
// download of it is made here. Hosts match themselves and their subdomains.
// "link.policy" {link, allow?: [host], block?: [host]}: with `allow`, only
// those hosts; `block` always wins.
void registerCommands();
bool allows(unsigned link, const URL&);

} // namespace Inception::LinkPolicy
