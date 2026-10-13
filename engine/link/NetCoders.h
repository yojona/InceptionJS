#pragma once

#include "link/Codec.h"
#include <wtf/MonotonicTime.h>

namespace WebCore {
class CertificateInfo;
class HTTPHeaderMap;
class NetworkLoadMetrics;
class ResourceError;
class ResourceRequest;
class ResourceResponse;
}

namespace Inception {

// What a load carries between a content engine and its profile service. A
// request's body crosses as bytes: the content engine resolves blobs and
// files into it first (flattenBody), since the service has neither.
template<> struct Coder<WebCore::HTTPHeaderMap> {
    static void encode(Encoder&, const WebCore::HTTPHeaderMap&);
    static std::optional<WebCore::HTTPHeaderMap> decode(Decoder&);
};

template<> struct Coder<WebCore::ResourceRequest> {
    static void encode(Encoder&, const WebCore::ResourceRequest&);
    static std::optional<WebCore::ResourceRequest> decode(Decoder&);
};

template<> struct Coder<WebCore::CertificateInfo> {
    static void encode(Encoder&, const WebCore::CertificateInfo&);
    static std::optional<WebCore::CertificateInfo> decode(Decoder&);
};

template<> struct Coder<WebCore::ResourceResponse> {
    static void encode(Encoder&, const WebCore::ResourceResponse&);
    static std::optional<WebCore::ResourceResponse> decode(Decoder&);
};

template<> struct Coder<WebCore::ResourceError> {
    static void encode(Encoder&, const WebCore::ResourceError&);
    static std::optional<WebCore::ResourceError> decode(Decoder&);
};

// Load timings. The two engines' clocks are not comparable, so times cross
// as offsets from the moment the service started the load, and the content
// engine adds them to the moment it asked for it.
void encodeMetrics(Encoder&, const WebCore::NetworkLoadMetrics&, MonotonicTime serviceStart);
std::optional<WebCore::NetworkLoadMetrics> decodeMetrics(Decoder&, MonotonicTime contentStart);

// Replaces a request's body with its bytes: blob parts are read from this
// engine's blob registry and file parts from its file system.
void flattenBody(WebCore::ResourceRequest&);

} // namespace Inception
