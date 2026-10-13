#include "config.h"
#include "net/Download.h"

#include "CertificateInfo.h"
#include "CurlRequest.h"
#include "CurlResponse.h"
#include "HTTPHeaderNames.h"
#include "NetworkLoadMetrics.h"
#include "ResourceError.h"
#include "ResourceResponse.h"
#include "SharedBuffer.h"
#include "bridge/Bridge.h"
#include "link/Link.h"
#include "link/NetCoders.h"
#include "net/Session.h"
#include "view/Preferences.h"
#include <emscripten/em_js.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

// The bytes go to the host next to the JSON events, as a transferable copy.
// In a profile service, `link` names the content engine the download is for
// and `media` says the bytes are a media element's.
EM_JS(void, inception_download_chunk, (double id, const uint8_t* data, size_t length, unsigned link, int media), {
    const bytes = HEAPU8.slice(data, data + length);
    postMessage({ inceptionDownload: link ? { id, bytes, link, media: !!media } : { id, bytes } }, [bytes.buffer]);
});

namespace Inception {
using namespace WebCore;

static constexpr unsigned maxRedirects = 20;
// Progress events at most this often, in bytes.
static constexpr uint64_t progressStep = 256 * 1024;

static HashMap<uint64_t, Ref<Download>>& active()
{
    static NeverDestroyed<HashMap<uint64_t, Ref<Download>>> downloads;
    return downloads;
}

String Download::eventName(ASCIILiteral what) const
{
    return makeString(m_mediaID ? "media.fetch."_s : "download."_s, what);
}

Ref<JSON::Object> Download::eventData() const
{
    auto data = JSON::Object::create();
    data->setDouble("id"_s, m_outwardID ? m_outwardID : m_id);
    if (m_mediaID)
        data->setInteger("media"_s, m_mediaID);
    if (m_link)
        data->setInteger("link"_s, m_link);
    return data;
}

// A content engine's media fetches, by (link, the id the content engine gave
// it): the service's own id.
static HashMap<std::pair<unsigned, uint64_t>, uint64_t>& mediaFetches()
{
    static NeverDestroyed<HashMap<std::pair<unsigned, uint64_t>, uint64_t>> map;
    return map;
}

uint64_t Download::startForMedia(const ResourceRequest& request, unsigned mediaID)
{
    if (role() == Role::Content) {
        // The id is this engine's; the service's events carry it back.
        static uint64_t lastID;
        auto id = ++lastID;
        if (RefPtr link = Link::service()) {
            ResourceRequest copy = request;
            flattenBody(copy);
            Encoder encoder;
            encoder.u64(id);
            encoder << copy << mediaID;
            link->send(Message::MediaFetchStart, WTF::move(encoder));
        }
        return id;
    }
    Ref download = adoptRef(*new Download(request, { }));
    download->m_mediaID = mediaID;
    active().add(download->m_id, download);
    download->begin();
    return download->m_id;
}

void Download::cancelMedia(uint64_t id)
{
    if (role() == Role::Content) {
        if (RefPtr link = Link::service()) {
            Encoder encoder;
            encoder.u64(id);
            link->send(Message::MediaFetchCancel, WTF::move(encoder));
        }
        return;
    }
    if (auto it = active().find(id); it != active().end())
        Ref { it->value }->cancel();
}

void Download::start(const ResourceRequest& request, const String& suggestedFilename, bool userGesture)
{
    if (role() == Role::Content) {
        if (RefPtr link = Link::service()) {
            ResourceRequest copy = request;
            flattenBody(copy);
            Encoder encoder;
            encoder << copy << suggestedFilename << userGesture;
            link->send(Message::DownloadStart, WTF::move(encoder));
        }
        return;
    }
    startForLink(request, suggestedFilename, userGesture, 0);
}

void Download::startForLink(const ResourceRequest& request, const String& suggestedFilename, bool userGesture, unsigned link)
{
    Ref download = adoptRef(*new Download(request, suggestedFilename));
    download->m_userGesture = userGesture;
    download->m_link = link;
    active().add(download->m_id, download);
    download->begin();
}

void Download::installService()
{
    // {request, filename, userGesture}
    Link::handle(Message::DownloadStart, [](Link& link, Decoder& decoder) {
        auto request = decoder.decode<ResourceRequest>();
        auto filename = decoder.string();
        auto userGesture = decoder.boolean();
        if (userGesture && request->url().protocolIsInHTTPFamily())
            startForLink(*request, *filename, *userGesture, link.id());
    });
    // {id, request, media}
    Link::handle(Message::MediaFetchStart, [](Link& link, Decoder& decoder) {
        auto id = decoder.u64();
        auto request = decoder.decode<ResourceRequest>();
        auto mediaID = decoder.decode<unsigned>();
        if (!mediaID || !*id || !request->url().protocolIsInHTTPFamily() || mediaFetches().contains({ link.id(), *id }))
            return;
        Ref download = adoptRef(*new Download(*request, { }));
        download->m_mediaID = *mediaID;
        download->m_link = link.id();
        download->m_outwardID = *id;
        mediaFetches().add({ link.id(), *id }, download->m_id);
        active().add(download->m_id, download);
        download->begin();
    });
    // {id}
    Link::handle(Message::MediaFetchCancel, [](Link& link, Decoder& decoder) {
        auto id = decoder.u64();
        if (!id)
            return;
        auto serviceID = mediaFetches().take({ link.id(), *id });
        if (auto it = active().find(serviceID); serviceID && it != active().end())
            Ref { it->value }->cancel();
    });
    // A content engine is gone: its media fetches stop. Its downloads go on;
    // they are the person's.
    Link::addCloseObserver([](Link& link) {
        if (!link.isServiceEnd())
            return;
        Vector<uint64_t> fetches;
        mediaFetches().removeIf([&](auto& entry) {
            if (entry.key.first != link.id())
                return false;
            fetches.append(entry.value);
            return true;
        });
        for (auto id : fetches) {
            if (auto it = active().find(id); it != active().end())
                Ref { it->value }->cancel();
        }
    });
}

Download::Download(const ResourceRequest& request, const String& suggestedFilename)
    : m_request(request)
    , m_suggestedFilename(suggestedFilename)
{
    static uint64_t nextID;
    m_id = ++nextID;
}

void Download::begin()
{
    addCookieHeader(m_request);
    if (!acceptLanguage().isEmpty() && !m_request.hasHTTPHeaderField(HTTPHeaderName::AcceptLanguage))
        m_request.setHTTPHeaderField(HTTPHeaderName::AcceptLanguage, acceptLanguage());
    m_curl = CurlRequest::create(m_request, *this);
    m_curl->resume();
}

void Download::curlDidReceiveResponse(CurlRequest& curl, CurlResponse&& curlResponse)
{
    storeResponseCookies(m_request, curlResponse);
    ResourceResponse response(curlResponse);
    if (response.isRedirection() && m_redirects < maxRedirects) {
        auto location = response.httpHeaderField(HTTPHeaderName::Location);
        URL next { response.url(), location };
        if (!location.isEmpty() && next.isValid()) {
            ++m_redirects;
            m_request.setURL(WTF::move(next));
            if (response.httpStatusCode() == 303) {
                m_request.setHTTPMethod("GET"_s);
                m_request.setHTTPBody(nullptr);
            }
            m_request.clearHTTPAuthorization();
            m_request.removeHTTPHeaderField(HTTPHeaderName::Cookie);
            curl.invalidateClient();
            curl.cancel();
            begin();
            return;
        }
    }
    if (response.httpStatusCode() >= 400) {
        finish(makeString("HTTP "_s, response.httpStatusCode()));
        return;
    }
    if (std::exchange(m_resuming, false)) {
        auto data = eventData();
        if (response.httpStatusCode() == 206) {
            data->setDouble("received"_s, m_received);
            emitEvent(eventName("resumed"_s), WTF::move(data));
        } else {
            // The server ignored the range: the file starts over.
            m_received = 0;
            m_reported = 0;
            emitEvent(eventName("restarted"_s), WTF::move(data));
        }
        curl.completeDidReceiveResponse();
        return;
    }
    auto filename = m_suggestedFilename;
    if (filename.isEmpty())
        filename = response.suggestedFilename();
    if (filename.isEmpty())
        filename = response.url().lastPathComponent().toString();
    if (filename.isEmpty())
        filename = "download"_s;
    m_size = response.expectedContentLength() > 0 ? response.expectedContentLength() : 0;
    m_started = true;
    auto data = eventData();
    data->setString("url"_s, response.url().string());
    data->setString("filename"_s, filename);
    data->setString("mime"_s, response.mimeType());
    data->setDouble("size"_s, m_size);
    data->setBoolean("userGesture"_s, m_userGesture);
    emitEvent(eventName("started"_s), WTF::move(data));
    curl.completeDidReceiveResponse();
}

void Download::curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&& buffer)
{
    if (!m_started)
        return;
    auto span = buffer->span();
    inception_download_chunk(m_outwardID ? m_outwardID : m_id, span.data(), span.size(), m_link, m_mediaID ? 1 : 0);
    m_received += span.size();
    if (m_received - m_reported >= progressStep) {
        m_reported = m_received;
        auto data = eventData();
        data->setDouble("received"_s, m_received);
        data->setDouble("size"_s, m_size);
        emitEvent(eventName("progress"_s), WTF::move(data));
    }
}

void Download::curlDidComplete(CurlRequest&, NetworkLoadMetrics&&)
{
    finish({ });
}

void Download::curlDidFailWithError(CurlRequest&, ResourceError&& error, CertificateInfo&&)
{
    finish(error.localizedDescription().isEmpty() ? "Network error"_s : error.localizedDescription());
}

void Download::cancel()
{
    finish("Cancelled"_s);
}

// Stops the transfer and keeps what arrived; resume() asks the server for the
// rest with a range request.
void Download::pause()
{
    if (m_paused || !m_curl)
        return;
    m_paused = true;
    if (RefPtr curl = std::exchange(m_curl, nullptr)) {
        curl->invalidateClient();
        curl->cancel();
    }
    auto data = eventData();
    data->setDouble("received"_s, m_received);
    emitEvent(eventName("paused"_s), WTF::move(data));
}

void Download::resume()
{
    if (!m_paused)
        return;
    m_paused = false;
    m_resuming = m_started;
    m_request.removeHTTPHeaderField(HTTPHeaderName::Cookie);
    if (m_resuming && m_received)
        m_request.setHTTPHeaderField(HTTPHeaderName::Range, makeString("bytes="_s, m_received, '-'));
    begin();
}

void Download::finish(const String& error)
{
    if (RefPtr curl = std::exchange(m_curl, nullptr)) {
        curl->invalidateClient();
        curl->cancel();
    }
    auto data = eventData();
    data->setDouble("received"_s, m_received);
    if (!error.isEmpty())
        data->setString("error"_s, error);
    emitEvent(eventName("finished"_s), WTF::move(data));
    if (m_outwardID)
        mediaFetches().remove({ m_link, m_outwardID });
    // Last: this may be the final reference.
    active().remove(m_id);
}

void Download::registerCommands()
{
    // {id}
    registerCommand("download.cancel"_s, [](JSON::Object& args) {
        auto id = static_cast<uint64_t>(args.getDouble("id"_s).value_or(0));
        if (auto it = active().find(id); it != active().end())
            Ref { it->value }->cancel();
    });
    // {id} -> "download.paused" {id, received}
    registerCommand("download.pause"_s, [](JSON::Object& args) {
        auto id = static_cast<uint64_t>(args.getDouble("id"_s).value_or(0));
        if (auto it = active().find(id); it != active().end())
            Ref { it->value }->pause();
    });
    // {id} -> "download.resumed" {id, received}, or "download.restarted" {id}
    // when the server cannot continue where it stopped.
    registerCommand("download.resume"_s, [](JSON::Object& args) {
        auto id = static_cast<uint64_t>(args.getDouble("id"_s).value_or(0));
        if (auto it = active().find(id); it != active().end())
            Ref { it->value }->resume();
    });
    // {url, link?}: a download the host asked for (a context menu's "Save").
    // A profile service tags its events with `link`, the content engine whose
    // view asked.
    registerCommand("download.start"_s, [](JSON::Object& args) {
        URL url { args.getString("url"_s) };
        auto link = std::max(args.getInteger("link"_s).value_or(0), 0);
        if (url.protocolIsInHTTPFamily())
            Download::startForLink(ResourceRequest { WTF::move(url) }, args.getString("filename"_s), true, link);
    });
}

} // namespace Inception
