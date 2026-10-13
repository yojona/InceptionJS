#include "config.h"
#include "net/SharedCookies.h"

#include "Cookie.h"
#include "CookieJar.h"
#include "CookieJarDB.h"
#include "CookieStoreGetOptions.h"
#include "Document.h"
#include "NetworkStorageSession.h"
#include "PublicSuffixStore.h"
#include "RegistrableDomain.h"
#include "bridge/Bridge.h"
#include "SameSiteInfo.h"
#include "StorageSessionProvider.h"
#include "link/Link.h"
#include "net/Session.h"
#include <pal/SessionID.h>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringHash.h>

namespace Inception {
using namespace WebCore;

template<> struct EnumLimit<Cookie::SameSitePolicy> {
    static constexpr std::optional<uint64_t> max = static_cast<uint64_t>(Cookie::SameSitePolicy::Strict);
};

template<> struct Coder<Cookie> {
    static void encode(Encoder& encoder, const Cookie& cookie)
    {
        encoder << cookie.name << cookie.value << cookie.domain << cookie.path << cookie.partitionKey << cookie.created << cookie.expires;
        encoder << cookie.httpOnly << cookie.secure << cookie.session << cookie.sameSite;
    }
    static std::optional<Cookie> decode(Decoder& decoder)
    {
        Cookie cookie;
        auto name = decoder.string();
        auto value = decoder.string();
        auto domain = decoder.string();
        auto path = decoder.string();
        auto partitionKey = decoder.string();
        auto created = decoder.f64();
        auto expires = decoder.decode<std::optional<double>>();
        auto httpOnly = decoder.boolean();
        auto secure = decoder.boolean();
        auto session = decoder.boolean();
        auto sameSite = decoder.decode<Cookie::SameSitePolicy>();
        if (!sameSite)
            return std::nullopt;
        cookie.name = WTF::move(*name);
        cookie.value = WTF::move(*value);
        cookie.domain = WTF::move(*domain);
        cookie.path = WTF::move(*path);
        cookie.partitionKey = WTF::move(*partitionKey);
        cookie.created = *created;
        cookie.expires = *expires;
        cookie.httpOnly = *httpOnly;
        cookie.secure = *secure;
        cookie.session = *session;
        cookie.sameSite = *sameSite;
        return cookie;
    }
};

template<> struct Coder<SameSiteInfo> {
    static void encode(Encoder& encoder, const SameSiteInfo& info) { encoder << info.isSameSite << info.isTopSite << info.isSafeHTTPMethod; }
    static std::optional<SameSiteInfo> decode(Decoder& decoder)
    {
        auto sameSite = decoder.boolean();
        auto topSite = decoder.boolean();
        auto safe = decoder.boolean();
        if (!safe)
            return std::nullopt;
        return SameSiteInfo { *sameSite, *topSite, *safe };
    }
};

// Whether a cookie for `domain` is sent to `host` (a leading dot is the
// old way of writing a domain cookie).
static bool domainMatches(StringView domain, const String& host)
{
    if (domain.startsWith('.'))
        domain = domain.substring(1);
    if (domain.isEmpty())
        return false;
    if (equalIgnoringASCIICase(domain, host))
        return true;
    return host.length() > domain.length() && host[host.length() - domain.length() - 1] == '.' && host.endsWithIgnoringASCIICase(domain);
}

static String hostOf(const URL& url)
{
    return url.host().convertToASCIILowercase();
}

// Service side.

// Bumped on every change, so a content engine can tell a stale list from a
// fresh one.
static uint64_t s_version;

// Hosts each content engine keeps cookies of.
static HashMap<unsigned, HashSet<String>>& subscriptions()
{
    static NeverDestroyed<HashMap<unsigned, HashSet<String>>> map;
    return map;
}

// The cookies a page of `host` could see, without the HttpOnly ones: a
// content engine never holds those.
static Vector<Cookie> cookiesForHost(const String& host)
{
    Vector<Cookie> result;
    for (auto& cookie : networkSession().getAllCookies()) {
        if (!cookie.httpOnly && domainMatches(cookie.domain, host))
            result.append(cookie);
    }
    return result;
}

static void encodeHost(Encoder& encoder, const String& host)
{
    encoder << host << s_version << cookiesForHost(host);
}

void cookiesChanged(const URL& url)
{
    if (role() != Role::Profile)
        return;
    ++s_version;
    auto changed = hostOf(url);
    auto site = RegistrableDomain { url };
    for (auto& [linkID, hosts] : subscriptions()) {
        RefPtr link = Link::byID(linkID);
        if (!link)
            continue;
        for (auto& host : hosts) {
            // A cookie set for a parent domain reaches its other hosts too.
            if (host != changed && !site.matches(URL { makeString("https://"_s, host, '/') }))
                continue;
            Encoder encoder;
            encodeHost(encoder, host);
            link->send(Message::CookiesForHostChanged, WTF::move(encoder));
        }
    }
}

void registerCookieDebugCommands()
{
    // {id, url, value?} -> "debug.cookies.result" {id, publicSuffix, site,
    // set?, cookies}: what the store holds for the URL's host, and whether a
    // response's Set-Cookie `value` would be kept. Development aid.
    registerCommand("debug.cookies"_s, [](JSON::Object& args) {
        URL url { args.getString("url"_s) };
        auto host = hostOf(url);
        auto result = JSON::Object::create();
        result->setDouble("id"_s, args.getDouble("id"_s).value_or(0));
        result->setBoolean("publicSuffix"_s, PublicSuffixStore::singleton().isPublicSuffix(host));
        result->setString("site"_s, RegistrableDomain { url }.string());
        auto value = args.getString("value"_s);
        if (!value.isEmpty()) {
            auto before = networkSession().getAllCookies().size();
            networkSession().setCookiesFromHTTPResponse(url, url, value);
            result->setBoolean("set"_s, networkSession().getAllCookies().size() > before);
        }
        auto list = JSON::Array::create();
        for (auto& cookie : networkSession().getAllCookies()) {
            if (domainMatches(cookie.domain, host))
                list->pushString(makeString(cookie.name, '=', cookie.value, "; domain="_s, cookie.domain, "; path="_s, cookie.path));
        }
        result->setArray("cookies"_s, WTF::move(list));
        emitEvent("debug.cookies.result"_s, WTF::move(result));
    });
}

void installCookieService()
{
    // {host} -> {host, version, cookies}; the caller is kept up to date on
    // that host from now on.
    Link::handleSync(Message::CookiesForHost, [](Link& link, Decoder& decoder, Encoder& reply) {
        auto host = decoder.string();
        if (!host || host->isEmpty() || host->length() > 1024)
            return false;
        auto lowered = host->convertToASCIILowercase();
        subscriptions().ensure(link.id(), [] { return HashSet<String> { }; }).iterator->value.add(lowered);
        encodeHost(reply, lowered);
        return true;
    });
    // {firstParty, sameSite, url, value}: document.cookie = value.
    Link::handle(Message::CookieSet, [](Link&, Decoder& decoder) {
        auto firstParty = decoder.decode<URL>();
        auto sameSite = decoder.decode<SameSiteInfo>();
        auto url = decoder.decode<URL>();
        auto value = decoder.string();
        if (!value || !url->protocolIsInHTTPFamily())
            return;
        networkSession().setCookiesFromDOM(*firstParty, *sameSite, *url, std::nullopt, std::nullopt, ApplyTrackingPrevention::Yes, RequiresScriptTrackingPrivacy::No, *value, ShouldRelaxThirdPartyCookieBlocking::No, IsKnownCrossSiteTracker::No);
        cookiesChanged(*url);
    });
    // {url, name}: the cookie store API's delete.
    Link::handle(Message::CookieDelete, [](Link&, Decoder& decoder) {
        auto url = decoder.decode<URL>();
        auto name = decoder.string();
        if (!name || !url->protocolIsInHTTPFamily())
            return;
        networkSession().deleteCookie(*url, *url, *name, [] { });
        cookiesChanged(*url);
    });
    Link::addCloseObserver([](Link& link) {
        if (link.isServiceEnd())
            subscriptions().remove(link.id());
    });
}

// Content side: a cookie store in memory that holds, per host, what the
// service sent; document.cookie reads it, so script never waits more than
// once per host. Writes apply here at once and go to the service, which
// sends every content engine that holds the host its new list.

static NetworkStorageSession& cacheSession()
{
    static NeverDestroyed<std::unique_ptr<NetworkStorageSession>> session = [] {
        auto session = makeUnique<NetworkStorageSession>(PAL::SessionID::defaultSessionID());
        session->setCookieDatabase(makeUniqueRef<CookieJarDB>(":memory:"_s));
        return session;
    }();
    return *session.get();
}

// Host -> the version of its list here.
static HashMap<String, uint64_t>& cachedHosts()
{
    static NeverDestroyed<HashMap<String, uint64_t>> map;
    return map;
}

static void replaceHost(const String& host, uint64_t version, Vector<Cookie>&& cookies)
{
    auto& session = cacheSession();
    for (auto& cookie : session.getAllCookies()) {
        if (domainMatches(cookie.domain, host))
            session.deleteCookie(cookie, [] { });
    }
    for (auto& cookie : cookies)
        session.setCookie(cookie);
    cachedHosts().set(host, version);
}

static bool decodeHost(Decoder& decoder, bool fromPush)
{
    auto host = decoder.string();
    auto version = decoder.u64();
    auto cookies = decoder.decode<Vector<Cookie>>();
    if (!cookies || host->isEmpty())
        return false;
    // A list older than the one here is late; a push for a host this engine
    // no longer holds is not needed.
    auto it = cachedHosts().find(*host);
    if (fromPush && (it == cachedHosts().end() || it->value >= *version))
        return true;
    replaceHost(*host, *version, WTF::move(*cookies));
    return true;
}

// The service the copy came from is gone: pages read it until another one
// is there, then everything is asked for again.
static bool s_stale;

static void clearCache()
{
    cachedHosts().clear();
    for (auto& cookie : cacheSession().getAllCookies())
        cacheSession().deleteCookie(cookie, [] { });
}

static void ensureHost(const URL& url)
{
    RefPtr link = Link::service();
    if (s_stale && link) {
        s_stale = false;
        clearCache();
    }
    auto host = hostOf(url);
    if (host.isEmpty() || cachedHosts().contains(host) || !link)
        return;
    Encoder encoder;
    encoder << host;
    auto reply = link->callSync(Message::CookiesForHost, WTF::move(encoder));
    if (!reply)
        return;
    Decoder decoder { reply->span() };
    decodeHost(decoder, false);
}

class CacheSessionProvider final : public StorageSessionProvider {
    NetworkStorageSession* storageSession() const final { return &cacheSession(); }
};

class ProxyCookieJar final : public CookieJar {
public:
    static Ref<ProxyCookieJar> create() { return adoptRef(*new ProxyCookieJar); }

private:
    ProxyCookieJar()
        : CookieJar(adoptRef(*new CacheSessionProvider))
    {
    }

    String cookies(Document& document, const URL& url) const final
    {
        ensureHost(url);
        return CookieJar::cookies(document, url);
    }

    void setCookies(Document& document, const URL& url, const String& value) final
    {
        ensureHost(url);
        CookieJar::setCookies(document, url, value);
        if (RefPtr link = Link::service()) {
            Encoder encoder;
            encoder << document.firstPartyForCookies() << sameSiteInfo(document, IsForDOMCookieAccess::Yes) << url << value;
            link->send(Message::CookieSet, WTF::move(encoder));
        }
    }

    std::pair<String, SecureCookiesAccessed> cookieRequestHeaderFieldValue(const URL& firstParty, const SameSiteInfo& sameSite, const URL& url, std::optional<FrameIdentifier> frame, std::optional<PageIdentifier> page, IncludeSecureCookies includeSecure) const final
    {
        ensureHost(url);
        return CookieJar::cookieRequestHeaderFieldValue(firstParty, sameSite, url, frame, page, includeSecure);
    }

    bool getRawCookies(Document& document, const URL& url, Vector<Cookie>& cookies) const final
    {
        ensureHost(url);
        return CookieJar::getRawCookies(document, url, cookies);
    }

    void deleteCookie(const Document& document, const URL& url, const String& name, CompletionHandler<void()>&& completion) final
    {
        ensureHost(url);
        if (RefPtr link = Link::service()) {
            Encoder encoder;
            encoder << url << name;
            link->send(Message::CookieDelete, WTF::move(encoder));
        }
        CookieJar::deleteCookie(document, url, name, WTF::move(completion));
    }

    void getCookiesAsync(Document& document, const URL& url, const CookieStoreGetOptions& options, CompletionHandler<void(std::optional<Vector<Cookie>>&&)>&& completion) const final
    {
        ensureHost(url);
        CookieJar::getCookiesAsync(document, url, options, WTF::move(completion));
    }

    void clearCache() final { Inception::clearCache(); }
};

Ref<CookieJar> createProxyCookieJar()
{
    static NeverDestroyed<Ref<ProxyCookieJar>> jar { ProxyCookieJar::create() };
    return jar.get().copyRef();
}

void installCookieProxy()
{
    Link::handle(Message::CookiesForHostChanged, [](Link&, Decoder& decoder) {
        decodeHost(decoder, true);
    });
    // A new service may hold other cookies (a restart loses session ones).
    Link::addCloseObserver([](Link& link) {
        if (!link.isServiceEnd())
            s_stale = true;
    });
}

} // namespace Inception
