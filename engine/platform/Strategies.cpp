#include "config.h"
#include "platform/Strategies.h"

#include "AudioDestination.h"
#include "BlobRegistry.h"
#include "BlobRegistryImpl.h"
#include "CachedResource.h"
#include "LoaderStrategy.h"
#include "LocalFrame.h"
#include "MediaStrategy.h"
#include "NetworkLoadMetrics.h"
#include "Pasteboard.h"
#include "PasteboardCustomData.h"
#include "PasteboardItemInfo.h"
#include "PasteboardStrategy.h"
#include "PlatformStrategies.h"
#include "ResourceError.h"
#include "ResourceLoader.h"
#include "SharedBuffer.h"
#include "SubresourceLoader.h"
#include "bridge/Bridge.h"
#include "net/NetworkLoad.h"
#include <wtf/HashMap.h>
#include <wtf/RunLoop.h>

namespace Inception {
using namespace WebCore;

static ResourceError makeError(const URL& url, int code, ASCIILiteral description, ResourceError::Type type = ResourceError::Type::General)
{
    return ResourceError("InceptionErrorDomain"_s, code, url, String { description }, type);
}

// Every subresource and main resource load passes through here. data: and blob:
// are served by WebCore itself (ResourceLoader::start); everything else goes to
// a NetworkLoad over curl.
class LoaderStrategyImpl final : public LoaderStrategy {
public:
    void loadResource(LocalFrame& frame, CachedResource& resource, ResourceRequest&& request, const ResourceLoaderOptions& options, CompletionHandler<void(RefPtr<SubresourceLoader>&&)>&& completionHandler) final
    {
        SubresourceLoader::create(frame, resource, WTF::move(request), options, [this, completionHandler = WTF::move(completionHandler)](RefPtr<SubresourceLoader>&& loader) mutable {
            if (loader)
                schedule(*loader);
            completionHandler(WTF::move(loader));
        });
    }

    void loadResourceSynchronously(FrameLoader&, ResourceLoaderIdentifier, const ResourceRequest& request, ClientCredentialPolicy, const FetchOptions&, const HTTPHeaderMap&, ResourceError& error, ResourceResponse&, Vector<uint8_t>&) final
    {
        // The engine thread cannot block on its own network pump.
        error = makeError(request.url(), 1, "Synchronous loads are not supported"_s);
    }

    void pageLoadCompleted(Page&) final { }
    void browsingContextRemoved(LocalFrame&) final { }

    void remove(ResourceLoader* loader) final
    {
        if (auto load = m_loads.take(loader))
            load->cancel();
    }

    void setDefersLoading(ResourceLoader&, bool) final { }
    void crossOriginRedirectReceived(ResourceLoader*, const URL&) final { }
    void servePendingRequests(ResourceLoadPriority) final { }
    void suspendPendingRequests() final { }
    void resumePendingRequests() final { }

    void startPingLoad(LocalFrame&, ResourceRequest& request, const HTTPHeaderMap&, const FetchOptions&, ContentSecurityPolicyImposition, PingLoadCompletionHandler&& completionHandler) final
    {
        if (completionHandler)
            completionHandler(makeError(request.url(), 2, "Ping loads are not supported yet"_s), { });
    }

    void preconnectTo(FrameLoader&, ResourceRequest&&, StoredCredentialsPolicy, ShouldPreconnectAsFirstParty, PreconnectCompletionHandler&& completionHandler) final
    {
        if (completionHandler)
            completionHandler({ });
    }

    void setCaptureExtraNetworkLoadMetricsEnabled(bool) final { }
    bool isOnLine() const final { return true; }
    void addOnlineStateChangeListener(Function<void(bool)>&&) final { }

    void isResourceLoadFinished(CachedResource& resource, CompletionHandler<void(bool)>&& callback) final
    {
        callback(!resource.isLoading());
    }

    ResourceError cancelledError(const ResourceRequest& request) const final { return makeError(request.url(), 100, "Cancelled"_s, ResourceError::Type::Cancellation); }
    ResourceError blockedError(const ResourceRequest& request) const final { return makeError(request.url(), 101, "Blocked"_s); }
    ResourceError blockedByContentBlockerError(const ResourceRequest& request) const final { return makeError(request.url(), 102, "Blocked by content blocker"_s); }
    ResourceError cannotShowURLError(const ResourceRequest& request) const final { return makeError(request.url(), 103, "Cannot show URL"_s); }
    ResourceError interruptedForPolicyChangeError(const ResourceRequest& request) const final { return makeError(request.url(), 104, "Interrupted by policy change"_s, ResourceError::Type::Cancellation); }
    ResourceError cannotShowMIMETypeError(const ResourceResponse& response) const final { return makeError(response.url(), 106, "Cannot show content of this type"_s); }
    ResourceError fileDoesNotExistError(const ResourceResponse& response) const final { return makeError(response.url(), 107, "File does not exist"_s); }
    ResourceError httpsUpgradeRedirectLoopError(const ResourceRequest& request) const final { return makeError(request.url(), 108, "HTTPS upgrade redirect loop"_s); }
    ResourceError httpNavigationWithHTTPSOnlyError(const ResourceRequest& request) const final { return makeError(request.url(), 109, "HTTP navigation blocked by HTTPS-only mode"_s); }
    ResourceError pluginWillHandleLoadError(const ResourceResponse& response) const final { return makeError(response.url(), 110, "Plug-in will handle load"_s, ResourceError::Type::Cancellation); }

private:
    // Starting is deferred one loop turn: WebCore is still setting the loader
    // up when create() completes.
    void schedule(SubresourceLoader& loader)
    {
        RunLoop::mainSingleton().dispatch([this, loader = Ref { loader }] {
            if (loader->reachedTerminalState())
                return;
            const auto& request = loader->request();
            if (request.url().protocolIsData() || request.url().protocolIsBlob()) {
                loader->start();
                return;
            }
            auto load = NetworkLoad::create(loader.get());
            m_loads.set(loader.ptr(), load.copyRef());
            load->start(request);
        });
    }

    HashMap<ResourceLoader*, Ref<NetworkLoad>> m_loads;
};

// The engine-wide clipboard. The host mirrors it to the system clipboard when
// the user allows; WebCore only ever sees this copy.
class ClipboardStrategy final : public PasteboardStrategy {
public:
    String readStringFromPasteboard(size_t, const String& type, const String&, const PasteboardContext*) final { return m_items.get(type); }
    RefPtr<SharedBuffer> readBufferFromPasteboard(std::optional<size_t>, const String& type, const String&, const PasteboardContext*) final
    {
        auto value = m_items.get(type);
        return value.isNull() ? nullptr : RefPtr { SharedBuffer::create(byteCast<uint8_t>(value.utf8().span())) };
    }
    URL readURLFromPasteboard(size_t, const String&, String&, const PasteboardContext*) final { return URL { m_items.get("text/uri-list"_s) }; }
    std::optional<PasteboardItemInfo> informationForItemAtIndex(size_t, const String&, int64_t, const PasteboardContext*) final { return std::nullopt; }
    std::optional<Vector<PasteboardItemInfo>> allPasteboardItemInfo(const String&, int64_t, const PasteboardContext*) final { return std::nullopt; }
    int getPasteboardItemsCount(const String&, const PasteboardContext*) final { return m_items.isEmpty() ? 0 : 1; }
    Vector<String> typesSafeForDOMToReadAndWrite(const String&, const String&, const PasteboardContext*) final { return copyToVector(m_items.keys()); }
    int64_t writeCustomData(const Vector<PasteboardCustomData>&, const String&, const PasteboardContext*) final { return ++m_changeCount; }
    bool containsStringSafeForDOMToReadForType(const String& type, const String&, const PasteboardContext*) final { return m_items.contains(type); }

    void getTypes(Vector<String>& types) final { types = copyToVector(m_items.keys()); }
    void writeToPasteboard(const PasteboardWebContent& content) final
    {
        m_items.clear();
        m_items.set("text/plain"_s, content.text);
        m_items.set("text/html"_s, content.markup);
        changed();
    }
    void writeToPasteboard(const String& type, const String& value) final
    {
        m_items.clear();
        m_items.set(type, value);
        changed();
    }

    // The host's clipboard, delivered before a paste.
    void replace(JSON::Object& items)
    {
        m_items.clear();
        for (auto& [type, value] : items) {
            auto text = value->asString();
            if (!text.isNull())
                m_items.set(type, text);
        }
        ++m_changeCount;
    }

private:
    // "clipboard.write" {items: {type: value}}: the host copies it to the
    // system clipboard if its policy allows.
    void changed()
    {
        ++m_changeCount;
        auto items = JSON::Object::create();
        for (auto& [type, value] : m_items) {
            if (!value.isEmpty())
                items->setString(type, value);
        }
        auto data = JSON::Object::create();
        data->setObject("items"_s, WTF::move(items));
        emitEvent("clipboard.write"_s, WTF::move(data));
    }

    HashMap<String, String> m_items;
    int64_t m_changeCount { 0 };
};

class MediaStrategyImpl final : public MediaStrategy {
#if ENABLE(WEB_AUDIO)
    Ref<AudioDestination> createAudioDestination(const AudioDestinationCreationOptions& options) final
    {
        return AudioDestination::create(options);
    }
#endif
};

class BlobRegistryBridge final : public BlobRegistry {
public:
    void registerInternalFileBlobURL(const URL& url, Ref<BlobDataFileReference>&& file, const String&, const String& contentType) final { m_impl.registerInternalFileBlobURL(url, WTF::move(file), contentType); }
    void registerInternalBlobURL(const URL& url, Vector<BlobPart>&& parts, const String& contentType) final { m_impl.registerInternalBlobURL(url, WTF::move(parts), contentType); }
    void registerBlobURL(const URL& url, const URL& source, const PolicyContainer& policy, const std::optional<SecurityOriginData>& topOrigin) final { m_impl.registerBlobURL(url, source, policy, topOrigin); }
    void registerInternalBlobURLOptionallyFileBacked(const URL& url, const URL& source, RefPtr<BlobDataFileReference>&& file, const String& contentType) final { m_impl.registerInternalBlobURLOptionallyFileBacked(url, source, WTF::move(file), contentType, { }); }
    void registerInternalBlobURLForSlice(const URL& url, const URL& source, long long start, long long end, const String& contentType) final { m_impl.registerInternalBlobURLForSlice(url, source, start, end, contentType); }
    void unregisterBlobURL(const URL& url, const std::optional<SecurityOriginData>& topOrigin) final { m_impl.unregisterBlobURL(url, topOrigin); }
    void registerBlobURLHandle(const URL& url, const std::optional<SecurityOriginData>& topOrigin) final { m_impl.registerBlobURLHandle(url, topOrigin); }
    void unregisterBlobURLHandle(const URL& url, const std::optional<SecurityOriginData>& topOrigin) final { m_impl.unregisterBlobURLHandle(url, topOrigin); }
    String blobType(const URL& url) final { return m_impl.blobType(url); }
    unsigned long long blobSize(const URL& url) final { return m_impl.blobSize(url); }
    void writeBlobsToTemporaryFilesForIndexedDB(const Vector<String>& urls, CompletionHandler<void(Vector<String>&&)>&& completion) final { m_impl.writeBlobsToTemporaryFilesForIndexedDB(urls, WTF::move(completion)); }
    BlobRegistryImpl* blobRegistryImpl() final { return &m_impl; }

private:
    BlobRegistryImpl m_impl;
};

class PlatformStrategiesImpl final : public PlatformStrategies {
private:
    LoaderStrategy* createLoaderStrategy() final { return new LoaderStrategyImpl; }
    PasteboardStrategy* createPasteboardStrategy() final { return clipboard(); }
public:
    static ClipboardStrategy* clipboard()
    {
        static ClipboardStrategy* strategy = new ClipboardStrategy;
        return strategy;
    }
private:
    MediaStrategy* createMediaStrategy() final { return new MediaStrategyImpl; }
    BlobRegistry* createBlobRegistry() final { return new BlobRegistryBridge; }
};

void installPlatformStrategies()
{
    static PlatformStrategiesImpl* strategies = new PlatformStrategiesImpl;
    setPlatformStrategies(strategies);

    // {items: {type: value}}
    registerCommand("clipboard.set"_s, [](JSON::Object& args) {
        if (auto items = args.getObject("items"_s))
            PlatformStrategiesImpl::clipboard()->replace(*items);
    });
}

} // namespace Inception
