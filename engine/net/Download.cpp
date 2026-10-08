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
#include "net/Session.h"
#include "view/Preferences.h"
#include <emscripten/em_js.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

// The bytes go to the host next to the JSON events, as a transferable copy.
EM_JS(void, inception_download_chunk, (double id, const uint8_t* data, size_t length), {
    const bytes = HEAPU8.slice(data, data + length);
    postMessage({ inceptionDownload: { id, bytes } }, [bytes.buffer]);
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

void Download::start(const ResourceRequest& request, const String& suggestedFilename)
{
    Ref download = adoptRef(*new Download(request, suggestedFilename));
    active().add(download->m_id, download);
    download->begin();
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
        auto data = JSON::Object::create();
        data->setDouble("id"_s, m_id);
        if (response.httpStatusCode() == 206) {
            data->setDouble("received"_s, m_received);
            emitEvent("download.resumed"_s, WTF::move(data));
        } else {
            // The server ignored the range: the file starts over.
            m_received = 0;
            m_reported = 0;
            emitEvent("download.restarted"_s, WTF::move(data));
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
    auto data = JSON::Object::create();
    data->setDouble("id"_s, m_id);
    data->setString("url"_s, response.url().string());
    data->setString("filename"_s, filename);
    data->setString("mime"_s, response.mimeType());
    data->setDouble("size"_s, m_size);
    emitEvent("download.started"_s, WTF::move(data));
    curl.completeDidReceiveResponse();
}

void Download::curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&& buffer)
{
    if (!m_started)
        return;
    auto span = buffer->span();
    inception_download_chunk(m_id, span.data(), span.size());
    m_received += span.size();
    if (m_received - m_reported >= progressStep) {
        m_reported = m_received;
        auto data = JSON::Object::create();
        data->setDouble("id"_s, m_id);
        data->setDouble("received"_s, m_received);
        data->setDouble("size"_s, m_size);
        emitEvent("download.progress"_s, WTF::move(data));
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
    auto data = JSON::Object::create();
    data->setDouble("id"_s, m_id);
    data->setDouble("received"_s, m_received);
    emitEvent("download.paused"_s, WTF::move(data));
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
    auto data = JSON::Object::create();
    data->setDouble("id"_s, m_id);
    data->setDouble("received"_s, m_received);
    if (!error.isEmpty())
        data->setString("error"_s, error);
    emitEvent("download.finished"_s, WTF::move(data));
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
    // {url}: a download the host asked for (a context menu's "Save").
    registerCommand("download.start"_s, [](JSON::Object& args) {
        URL url { args.getString("url"_s) };
        if (url.protocolIsInHTTPFamily())
            Download::start(ResourceRequest { WTF::move(url) }, args.getString("filename"_s));
    });
}

} // namespace Inception
