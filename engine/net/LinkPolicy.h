#pragma once

#include <wtf/URL.h>

namespace WebCore {
class ResourceRequest;
}

namespace Inception::LinkPolicy {

// Where each content engine may go, decided by the host and enforced by the
// profile service: a content engine whose code was subverted still reaches
// only what its window was allowed, since every load, socket, ping and
// download of it is made here. Hosts match themselves and their subdomains.
// "link.policy" {link, allow?: [host], block?: [host], site?, thirdParty?}:
// with `allow`, only those hosts; `block` always wins.
//
// `site` (a registrable domain, "" for none) locks the link to one site, as
// isolation 'site' does with every content engine: the profile's data of other
// sites (cookies with requests, cookie lists, localStorage, IndexedDB) is
// not the link's, and responses of other sites that CORS does not open to it
// are filtered before they reach it (net/ServiceLoad.cpp). `thirdParty`:
// 'block' (the default with a site) or 'allow' (the default without one):
// whether requests to other sites carry the profile's cookies at all.
//
// "site.of" {id, url} -> "site.result" {id, site}: the host asks the service
// which site a URL belongs to (the public suffix list lives in the engine).
void registerCommands();
bool allows(unsigned link, const URL&);

// The link's site lock, if it has one ("" locks it to no site).
std::optional<String> site(unsigned link);
// Whether `url` belongs to the link's site (always, for a link without a lock).
bool isLinkSite(unsigned link, const URL&);
// Whether the link may use the profile's data (cookies, storage, databases)
// of `url`'s site.
bool allowsSiteData(unsigned link, const URL&);
// Applies the lock to a request about to leave for the network: no cookies
// for a site the link may not use, and its first party and same-site flag
// never claim a site other than the link's.
void restrict(unsigned link, WebCore::ResourceRequest&);

} // namespace Inception::LinkPolicy
