#include "config.h"
#include "link/NetCoders.h"

#include "BlobRegistry.h"
#include "BlobRegistryImpl.h"
#include "CertificateInfo.h"
#include "FormData.h"
#include "HTTPHeaderMap.h"
#include "NetworkLoadMetrics.h"
#include "PlatformStrategies.h"
#include "ResourceError.h"
#include "ResourceRequest.h"
#include "ResourceResponse.h"
#include <cmath>
#include <wtf/FileSystem.h>

namespace Inception {
using namespace WebCore;

template<> struct EnumLimit<ResourceRequestCachePolicy> {
    static constexpr std::optional<uint64_t> max = static_cast<uint64_t>(ResourceRequestCachePolicy::RefreshAnyCacheData);
};
template<> struct EnumLimit<ResourceRequestBase::SameSiteDisposition> {
    static constexpr std::optional<uint64_t> max = static_cast<uint64_t>(ResourceRequestBase::SameSiteDisposition::CrossSite);
};
template<> struct EnumLimit<ResourceLoadPriority> {
    static constexpr std::optional<uint64_t> max = static_cast<uint64_t>(ResourceLoadPriority::VeryHigh);
};
template<> struct EnumLimit<ResourceRequestRequester> {
    static constexpr std::optional<uint64_t> max = static_cast<uint64_t>(ResourceRequestRequester::EventSource);
};
template<> struct EnumLimit<ResourceError::Type> {
    static constexpr std::optional<uint64_t> max = static_cast<uint64_t>(ResourceError::Type::Timeout);
};

void Coder<HTTPHeaderMap>::encode(Encoder& encoder, const HTTPHeaderMap& headers)
{
    encoder.u32(headers.size());
    for (auto& header : headers)
        encoder << header.key << header.value;
}

std::optional<HTTPHeaderMap> Coder<HTTPHeaderMap>::decode(Decoder& decoder)
{
    auto count = decoder.count(10);
    if (!count)
        return std::nullopt;
    HTTPHeaderMap headers;
    for (uint32_t i = 0; i < *count; ++i) {
        auto name = decoder.string();
        auto value = name ? decoder.string() : std::nullopt;
        if (!value || name->isEmpty()) {
            decoder.fail();
            return std::nullopt;
        }
        headers.add(*name, *value);
    }
    return headers;
}

void Coder<ResourceRequest>::encode(Encoder& encoder, const ResourceRequest& request)
{
    encoder << request.url() << request.firstPartyForCookies() << request.httpMethod() << request.httpHeaderFields();
    encoder << request.timeoutInterval() << request.cachePolicy() << request.sameSiteDisposition() << request.priority() << request.requester();
    encoder << request.isTopSite() << request.allowCookies();
    RefPtr body = request.httpBody();
    encoder.boolean(!!body);
    if (body)
        encoder.bytes(body->flatten().span());
}

std::optional<ResourceRequest> Coder<ResourceRequest>::decode(Decoder& decoder)
{
    auto url = decoder.decode<URL>();
    auto firstParty = decoder.decode<URL>();
    auto method = decoder.string();
    auto headers = decoder.decode<HTTPHeaderMap>();
    auto timeout = decoder.f64();
    auto cachePolicy = decoder.decode<ResourceRequestCachePolicy>();
    auto sameSite = decoder.decode<ResourceRequestBase::SameSiteDisposition>();
    auto priority = decoder.decode<ResourceLoadPriority>();
    auto requester = decoder.decode<ResourceRequestRequester>();
    auto isTopSite = decoder.boolean();
    auto allowCookies = decoder.boolean();
    auto hasBody = decoder.boolean();
    // Every field read is checked through failed(): a read after a refused
    // one fails too.
    if (decoder.failed() || !hasBody || !std::isfinite(*timeout))
        return std::nullopt;
    ResourceRequest request { WTF::move(*url) };
    request.setFirstPartyForCookies(*firstParty);
    request.setHTTPMethod(*method);
    request.setHTTPHeaderFields(WTF::move(*headers));
    request.setTimeoutInterval(*timeout);
    request.setCachePolicy(*cachePolicy);
    request.setSameSiteDisposition(*sameSite);
    request.setPriority(*priority);
    request.setRequester(*requester);
    request.setIsTopSite(*isTopSite);
    request.setAllowCookies(*allowCookies);
    if (*hasBody) {
        auto body = decoder.bytes();
        if (!body)
            return std::nullopt;
        request.setHTTPBody(FormData::create(WTF::move(*body)));
    }
    return request;
}

void Coder<CertificateInfo>::encode(Encoder& encoder, const CertificateInfo& info)
{
    encoder.i32(info.verificationError());
    encoder << info.certificateChain();
}

std::optional<CertificateInfo> Coder<CertificateInfo>::decode(Decoder& decoder)
{
    auto error = decoder.i32();
    auto chain = error ? decoder.decode<Vector<Vector<uint8_t>>>() : std::nullopt;
    if (!chain)
        return std::nullopt;
    return CertificateInfo { *error, WTF::move(*chain) };
}

void Coder<ResourceResponse>::encode(Encoder& encoder, const ResourceResponse& response)
{
    encoder << response.url() << response.mimeType() << response.expectedContentLength() << response.textEncodingName();
    encoder.i32(response.httpStatusCode());
    encoder << response.httpStatusText() << response.httpVersion() << response.httpHeaderFields();
    encoder << response.certificateInfo();
}

std::optional<ResourceResponse> Coder<ResourceResponse>::decode(Decoder& decoder)
{
    auto url = decoder.decode<URL>();
    auto mimeType = decoder.string();
    auto expectedLength = decoder.i64();
    auto encoding = decoder.string();
    auto status = decoder.i32();
    auto statusText = decoder.string();
    auto version = decoder.string();
    auto headers = decoder.decode<HTTPHeaderMap>();
    auto certificate = decoder.decode<std::optional<CertificateInfo>>();
    if (decoder.failed() || !certificate || *status < 0 || *status > 999)
        return std::nullopt;
    ResourceResponse response { WTF::move(*url), WTF::move(*mimeType), *expectedLength, WTF::move(*encoding) };
    response.setHTTPStatusCode(*status);
    response.setHTTPStatusText(WTF::move(*statusText));
    response.setHTTPVersion(WTF::move(*version));
    response.setHTTPHeaderFields(WTF::move(*headers));
    if (*certificate)
        response.setCertificateInfo(WTF::move(**certificate));
    response.setSource(ResourceResponse::Source::Network);
    return response;
}

void Coder<ResourceError>::encode(Encoder& encoder, const ResourceError& error)
{
    encoder << error.type() << error.domain();
    encoder.i32(error.errorCode());
    encoder << error.failingURL() << error.localizedDescription();
}

std::optional<ResourceError> Coder<ResourceError>::decode(Decoder& decoder)
{
    auto type = decoder.decode<ResourceError::Type>();
    auto domain = decoder.string();
    auto code = decoder.i32();
    auto url = decoder.decode<URL>();
    auto description = decoder.string();
    if (!description)
        return std::nullopt;
    if (*type == ResourceError::Type::Null)
        return ResourceError { };
    return ResourceError { *domain, *code, *url, *description, *type };
}

static void encodeTime(Encoder& encoder, MonotonicTime time, MonotonicTime start)
{
    // Zero is "did not happen", and stays so.
    encoder.f64(time ? (time - start).seconds() : std::numeric_limits<double>::quiet_NaN());
}

static std::optional<MonotonicTime> decodeTime(Decoder& decoder, MonotonicTime start)
{
    auto offset = decoder.f64();
    if (!offset)
        return std::nullopt;
    if (std::isnan(*offset))
        return MonotonicTime { };
    if (!std::isfinite(*offset)) {
        decoder.fail();
        return std::nullopt;
    }
    return start + Seconds { *offset };
}

void encodeMetrics(Encoder& encoder, const NetworkLoadMetrics& metrics, MonotonicTime serviceStart)
{
    for (auto time : { metrics.redirectStart, metrics.fetchStart, metrics.domainLookupStart, metrics.domainLookupEnd, metrics.connectStart, metrics.secureConnectionStart, metrics.connectEnd, metrics.requestStart, metrics.responseStart, metrics.responseEnd })
        encodeTime(encoder, time, serviceStart);
    encoder << metrics.protocol << metrics.redirectCount << static_cast<bool>(metrics.complete) << static_cast<bool>(metrics.isReusedConnection);
    encoder << metrics.responseBodyBytesReceived << metrics.responseBodyDecodedSize;
}

std::optional<NetworkLoadMetrics> decodeMetrics(Decoder& decoder, MonotonicTime contentStart)
{
    std::array<MonotonicTime, 10> times;
    for (auto& time : times) {
        auto value = decodeTime(decoder, contentStart);
        if (!value)
            return std::nullopt;
        time = *value;
    }
    auto protocol = decoder.string();
    auto redirectCount = decoder.decode<uint16_t>();
    auto complete = decoder.boolean();
    auto reused = decoder.boolean();
    auto received = decoder.u64();
    auto decoded = decoder.u64();
    if (!decoded)
        return std::nullopt;
    NetworkLoadMetrics metrics;
    metrics.redirectStart = times[0];
    metrics.fetchStart = times[1];
    metrics.domainLookupStart = times[2];
    metrics.domainLookupEnd = times[3];
    metrics.connectStart = times[4];
    metrics.secureConnectionStart = times[5];
    metrics.connectEnd = times[6];
    metrics.requestStart = times[7];
    metrics.responseStart = times[8];
    metrics.responseEnd = times[9];
    metrics.protocol = WTF::move(*protocol);
    metrics.redirectCount = *redirectCount;
    metrics.complete = *complete;
    metrics.isReusedConnection = *reused;
    metrics.responseBodyBytesReceived = *received;
    metrics.responseBodyDecodedSize = *decoded;
    return metrics;
}

void flattenBody(ResourceRequest& request)
{
    RefPtr body = request.httpBody();
    if (!body)
        return;
    auto* registry = platformStrategies()->blobRegistry()->blobRegistryImpl();
    Ref resolved = body->resolveBlobReferences(registry);
    Vector<uint8_t> bytes;
    for (auto& element : resolved->elements()) {
        WTF::switchOn(element.data,
            [&](const Vector<uint8_t>& data) {
                bytes.append(data.span());
            },
            [&](const FormDataElement::EncodedFileData& file) {
                auto contents = FileSystem::readEntireFile(file.filename);
                if (!contents)
                    return;
                uint64_t start = std::min<uint64_t>(std::max<int64_t>(file.fileStart, 0), contents->size());
                uint64_t length = file.fileLength < 0 ? contents->size() - start : std::min<uint64_t>(file.fileLength, contents->size() - start);
                bytes.append(contents->span().subspan(start, length));
            },
            [&](const FormDataElement::EncodedBlobData&) {
                // resolveBlobReferences leaves none.
            });
    }
    request.setHTTPBody(FormData::create(WTF::move(bytes)));
}

} // namespace Inception
