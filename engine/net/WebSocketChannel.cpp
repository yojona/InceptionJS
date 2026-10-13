#include "config.h"
#include "net/WebSocketChannel.h"

#include "Blob.h"
#include "CurlContext.h"
#include "CurlStreamScheduler.h"
#include "Document.h"
#include "ResourceRequest.h"
#include "ResourceResponse.h"
#include "SecurityOrigin.h"
#include "SharedBuffer.h"
#include "SocketProvider.h"
#include "ThreadableWebSocketChannel.h"
#include "UserAgent.h"
#include "WebSocketChannelClient.h"
#include "WebSocketFrame.h"
#include "WebSocketHandshake.h"
#include "WebTransportSession.h"
#include "link/Link.h"
#include "link/NetCoders.h"
#include "net/LinkPolicy.h"
#include <JavaScriptCore/ArrayBuffer.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/UniqueArray.h>
#include <wtf/text/CString.h>

namespace Inception {
using namespace WebCore;

using ClosingStatus = WebSocketChannelClient::ClosingHandshakeCompletionStatus;

// What a connection reports. Its owner forwards it to WebCore's channel
// client (in this engine) or over a link (in a profile service).
class WebSocketConnectionClient {
public:
    virtual ~WebSocketConnectionClient() = default;
    virtual void didConnect() = 0;
    virtual void didReceiveText(String&&) = 0;
    virtual void didReceiveBinary(Vector<uint8_t>&&) = 0;
    virtual void didReceiveError(String&&) = 0;
    virtual void didUpdateBufferedAmount(size_t) = 0;
    virtual void didClose(size_t bufferedAmount, ClosingStatus, int code, const String& reason) = 0;
};

// One WebSocket over the engine's streams: WebCore's handshake and framing on
// a TCP stream through the relay, TLS inside the engine for wss:.
class WebSocketConnection final : public RefCounted<WebSocketConnection>, public CurlStream::Client {
public:
    static Ref<WebSocketConnection> create(WebSocketConnectionClient& client) { return adoptRef(*new WebSocketConnection(client)); }
    ~WebSocketConnection() { closeStream(); }

    void connect(const URL& url, const String& protocol, const String& userAgent, const String& origin, bool allowCookies)
    {
        m_handshake = makeUnique<WebSocketHandshake>(url, protocol, userAgent, origin, allowCookies, false);
        m_streamID = CurlContext::singleton().streamScheduler().createStream(url, *this, CurlStream::ServerTrustEvaluation::Enable, CurlStream::LocalhostAlias::Disable);
    }

    String subprotocol() const { return m_handshake ? m_handshake->serverWebSocketProtocol() : String { }; }
    String extensions() const { return m_handshake ? m_handshake->acceptedExtensions() : String { }; }
    WebSocketHandshake* handshake() const { return m_handshake.get(); }
    bool isConnected() const { return m_handshake && m_handshake->mode() == WebSocketHandshake::Connected; }

    void sendText(std::span<const uint8_t> utf8) { sendFrame(WebSocketFrame::OpCodeText, utf8); }
    void sendBinary(std::span<const uint8_t> bytes) { sendFrame(WebSocketFrame::OpCodeBinary, bytes); }

    // Starts the closing handshake; the owner has told WebCore it started.
    void close(int code, const String& reason)
    {
        if (m_closeSent)
            return;
        m_closeSent = true;
        Vector<uint8_t> payload;
        if (code != ThreadableWebSocketChannel::CloseEventCodeNotSpecified) {
            payload.append(static_cast<uint8_t>(code >> 8));
            payload.append(static_cast<uint8_t>(code));
            auto utf8 = reason.utf8();
            payload.append(byteCast<uint8_t>(utf8.span()));
        }
        sendFrame(WebSocketFrame::OpCodeClose, payload.span());
    }

    void fail(String&& reason)
    {
        if (m_client)
            m_client->didReceiveError(WTF::move(reason));
        finish(ThreadableWebSocketChannel::CloseEventCodeAbnormalClosure, { }, ClosingStatus::ClosingHandshakeIncomplete);
    }

    // No more events; the stream closes.
    void disconnect()
    {
        m_client = nullptr;
        closeStream();
    }

private:
    explicit WebSocketConnection(WebSocketConnectionClient& client)
        : m_client(&client)
    {
    }

    // CurlStream::Client
    void didOpen(CurlStreamID) final
    {
        auto message = m_handshake->clientHandshakeMessage();
        sendBytes(byteCast<uint8_t>(message.span()));
    }

    void didSendData(CurlStreamID, size_t length) final
    {
        m_bufferedAmount -= std::min<size_t>(length, m_bufferedAmount);
        if (m_client)
            m_client->didUpdateBufferedAmount(m_bufferedAmount);
    }

    void didReceiveData(CurlStreamID, const SharedBuffer& data) final
    {
        Ref protectedThis { *this };
        if (!data.size()) {
            finish(ThreadableWebSocketChannel::CloseEventCodeAbnormalClosure, { }, ClosingStatus::ClosingHandshakeIncomplete);
            return;
        }
        m_input.append(data.span());
        if (m_handshake->mode() != WebSocketHandshake::Connected) {
            int consumed = m_handshake->readServerHandshake(m_input.span());
            if (m_handshake->mode() == WebSocketHandshake::Incomplete)
                return;
            if (m_handshake->mode() != WebSocketHandshake::Connected) {
                fail(m_handshake->failureReason());
                return;
            }
            m_input.removeAt(0, consumed);
            if (m_client)
                m_client->didConnect();
        }
        processFrames();
    }

    void didFail(CurlStreamID, CURLcode, CertificateInfo&&) final
    {
        fail("WebSocket connection failed"_s);
    }

    void processFrames()
    {
        while (!m_input.isEmpty() && m_streamID != invalidCurlStreamID) {
            WebSocketFrame frame;
            const uint8_t* frameEnd = nullptr;
            String error;
            auto result = WebSocketFrame::parseFrame(m_input.mutableSpan(), frame, frameEnd, error);
            if (result == WebSocketFrame::FrameIncomplete)
                return;
            if (result == WebSocketFrame::FrameError) {
                fail(WTF::move(error));
                return;
            }
            Vector<uint8_t> payload(frame.payload);
            m_input.removeAt(0, frameEnd - m_input.span().data());
            handleFrame(frame.opCode, frame.final, WTF::move(payload));
        }
    }

    void handleFrame(WebSocketFrame::OpCode opCode, bool final, Vector<uint8_t>&& payload)
    {
        switch (opCode) {
        case WebSocketFrame::OpCodeText:
        case WebSocketFrame::OpCodeBinary:
            m_messageOpCode = opCode;
            m_message = WTF::move(payload);
            break;
        case WebSocketFrame::OpCodeContinuation:
            m_message.appendVector(payload);
            break;
        case WebSocketFrame::OpCodePing:
            sendFrame(WebSocketFrame::OpCodePong, payload.span());
            return;
        case WebSocketFrame::OpCodePong:
            return;
        case WebSocketFrame::OpCodeClose: {
            int code = ThreadableWebSocketChannel::CloseEventCodeNoStatusRcvd;
            String reason;
            if (payload.size() >= 2) {
                code = (payload[0] << 8) | payload[1];
                reason = String::fromUTF8(payload.subspan(2));
            }
            if (!m_closeSent)
                close(code == ThreadableWebSocketChannel::CloseEventCodeNoStatusRcvd ? ThreadableWebSocketChannel::CloseEventCodeNotSpecified : code, reason);
            finish(code, reason, ClosingStatus::ClosingHandshakeComplete);
            return;
        }
        default:
            fail("Unrecognized WebSocket frame"_s);
            return;
        }
        if (!final || !m_client)
            return;
        auto message = std::exchange(m_message, { });
        if (m_messageOpCode == WebSocketFrame::OpCodeText) {
            auto text = String::fromUTF8(message.span());
            if (text.isNull())
                fail("Could not decode a text frame as UTF-8"_s);
            else
                m_client->didReceiveText(WTF::move(text));
        } else
            m_client->didReceiveBinary(WTF::move(message));
    }

    void sendFrame(WebSocketFrame::OpCode opCode, std::span<const uint8_t> payload)
    {
        if (m_streamID == invalidCurlStreamID)
            return;
        // Client frames are always masked.
        WebSocketFrame frame(opCode, true, false, true, payload);
        Vector<uint8_t> data;
        frame.makeFrameData(data);
        sendBytes(data.span());
    }

    void sendBytes(std::span<const uint8_t> bytes)
    {
        if (m_streamID == invalidCurlStreamID || bytes.empty())
            return;
        auto copy = makeUniqueArray<uint8_t>(bytes.size());
        memcpySpan(std::span { copy.get(), bytes.size() }, bytes);
        m_bufferedAmount += bytes.size();
        CurlContext::singleton().streamScheduler().send(m_streamID, WTF::move(copy), bytes.size());
    }

    void finish(int code, const String& reason, ClosingStatus status)
    {
        closeStream();
        if (auto* client = std::exchange(m_client, nullptr))
            client->didClose(m_bufferedAmount, status, code == ThreadableWebSocketChannel::CloseEventCodeNotSpecified ? ThreadableWebSocketChannel::CloseEventCodeNoStatusRcvd : code, reason);
    }

    void closeStream()
    {
        if (m_streamID == invalidCurlStreamID)
            return;
        CurlContext::singleton().streamScheduler().destroyStream(std::exchange(m_streamID, invalidCurlStreamID));
    }

    WebSocketConnectionClient* m_client;
    std::unique_ptr<WebSocketHandshake> m_handshake;
    CurlStreamID m_streamID { invalidCurlStreamID };
    Vector<uint8_t> m_input;
    Vector<uint8_t> m_message;
    WebSocketFrame::OpCode m_messageOpCode { WebSocketFrame::OpCodeText };
    size_t m_bufferedAmount { 0 };
    bool m_closeSent { false };
};

// A page's WebSocket in a standalone engine: the connection runs here.
class EngineWebSocketChannel final : public RefCounted<EngineWebSocketChannel>, public ThreadableWebSocketChannel, public WebSocketConnectionClient {
public:
    static Ref<EngineWebSocketChannel> create(Document& document, WebSocketChannelClient& client) { return adoptRef(*new EngineWebSocketChannel(document, client)); }
    ~EngineWebSocketChannel() { m_connection->disconnect(); }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    EngineWebSocketChannel(Document& document, WebSocketChannelClient& client)
        : m_document(document)
        , m_client(client)
        , m_identifier(WebSocketChannelIdentifier::generate())
        , m_connection(WebSocketConnection::create(*this))
    {
    }

    ConnectStatus connect(const URL& url, const String& protocol) final
    {
        RefPtr document = m_document.get();
        if (!document)
            return ConnectStatus::KO;
        auto validated = validateURL(*document, url);
        if (!validated)
            return ConnectStatus::KO;
        m_connection->connect(validated->url, protocol, document->userAgent(validated->url), document->securityOrigin().toString(), validated->areCookiesAllowed);
        return ConnectStatus::OK;
    }

    String subprotocol() final { return m_connection->subprotocol(); }
    String extensions() final { return m_connection->extensions(); }

    void send(CString&& message) final { m_connection->sendText(byteCast<uint8_t>(message.span())); }
    void send(const JSC::ArrayBuffer& buffer, unsigned byteOffset, unsigned byteLength) final { m_connection->sendBinary(buffer.span().subspan(byteOffset, byteLength)); }
    void send(Blob&) final { fail("Sending Blob data over WebSocket is not supported yet"_s); }

    void close(int code, const String& reason) final
    {
        if (RefPtr client = m_client.get())
            client->didStartClosingHandshake();
        m_connection->close(code, reason);
    }

    void fail(String&& reason) final { m_connection->fail(WTF::move(reason)); }

    void disconnect() final
    {
        m_client = nullptr;
        m_connection->disconnect();
    }

    void suspend() final { }
    void resume() final { }

    WebSocketChannelIdentifier progressIdentifier() const final { return m_identifier; }
    bool hasCreatedHandshake() const final { return !!m_connection->handshake(); }
    bool isConnected() const final { return m_connection->isConnected(); }

    ResourceRequest clientHandshakeRequest(const CookieGetter& cookieGetter) const final
    {
        auto* handshake = m_connection->handshake();
        return handshake ? handshake->clientHandshakeRequest(cookieGetter) : ResourceRequest { };
    }

    const ResourceResponse& serverHandshakeResponse() const final
    {
        static NeverDestroyed<ResourceResponse> empty;
        auto* handshake = m_connection->handshake();
        return handshake ? handshake->serverHandshakeResponse() : empty.get();
    }

    // WebSocketConnectionClient
    void didConnect() final
    {
        if (RefPtr client = m_client.get())
            client->didConnect();
    }
    void didReceiveText(String&& text) final
    {
        if (RefPtr client = m_client.get())
            client->didReceiveMessage(WTF::move(text));
    }
    void didReceiveBinary(Vector<uint8_t>&& data) final
    {
        if (RefPtr client = m_client.get())
            client->didReceiveBinaryData(WTF::move(data));
    }
    void didReceiveError(String&& reason) final
    {
        if (RefPtr client = m_client.get())
            client->didReceiveMessageError(WTF::move(reason));
    }
    void didUpdateBufferedAmount(size_t amount) final
    {
        if (RefPtr client = m_client.get())
            client->didUpdateBufferedAmount(amount);
    }
    void didClose(size_t bufferedAmount, ClosingStatus status, int code, const String& reason) final
    {
        if (RefPtr client = std::exchange(m_client, nullptr).get())
            client->didClose(bufferedAmount, status, code, reason);
    }

    WeakPtr<Document, WeakPtrImplWithEventTargetData> m_document;
    ThreadSafeWeakPtr<WebSocketChannelClient> m_client;
    WebSocketChannelIdentifier m_identifier;
    Ref<WebSocketConnection> m_connection;
};

// Socket messages. A text or binary message: {id, binary, bytes}.
// SocketConnected {id, subprotocol, extensions, response}; SocketBuffered
// {id, amount}; SocketError {id, reason}; SocketClosed {id, buffered, status
// (1 complete), code, reason}.

// A page's WebSocket in a content engine: the connection runs in the profile
// service, which has the network.
class RemoteWebSocketChannel final : public RefCounted<RemoteWebSocketChannel>, public ThreadableWebSocketChannel {
public:
    static Ref<RemoteWebSocketChannel> create(Document& document, WebSocketChannelClient& client) { return adoptRef(*new RemoteWebSocketChannel(document, client)); }
    ~RemoteWebSocketChannel() { disconnect(); }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    static void install();

private:
    RemoteWebSocketChannel(Document& document, WebSocketChannelClient& client)
        : m_document(document)
        , m_client(client)
        , m_identifier(WebSocketChannelIdentifier::generate())
    {
        static uint64_t lastID;
        m_id = ++lastID;
    }

    static HashMap<uint64_t, RemoteWebSocketChannel*>& channels()
    {
        static NeverDestroyed<HashMap<uint64_t, RemoteWebSocketChannel*>> map;
        return map;
    }

    Encoder header() const
    {
        Encoder encoder;
        encoder.u64(m_id);
        return encoder;
    }

    ConnectStatus connect(const URL& url, const String& protocol) final
    {
        RefPtr document = m_document.get();
        m_link = Link::service();
        if (!document || !m_link)
            return ConnectStatus::KO;
        auto validated = validateURL(*document, url);
        if (!validated)
            return ConnectStatus::KO;
        auto userAgent = document->userAgent(validated->url);
        auto origin = document->securityOrigin().toString();
        // A local handshake, for what WebCore asks of the request it made.
        m_handshake = makeUnique<WebSocketHandshake>(validated->url, protocol, userAgent, origin, validated->areCookiesAllowed, false);
        channels().set(m_id, this);
        auto encoder = header();
        encoder << validated->url << protocol << userAgent << origin << validated->areCookiesAllowed;
        m_link->send(Message::SocketConnect, WTF::move(encoder));
        return ConnectStatus::OK;
    }

    String subprotocol() final { return m_subprotocol; }
    String extensions() final { return m_extensions; }

    void sendMessage(bool binary, std::span<const uint8_t> bytes)
    {
        if (!m_link)
            return;
        auto encoder = header();
        encoder.boolean(binary);
        encoder.bytes(bytes);
        m_link->send(Message::SocketSend, WTF::move(encoder));
    }

    void send(CString&& message) final { sendMessage(false, byteCast<uint8_t>(message.span())); }
    void send(const JSC::ArrayBuffer& buffer, unsigned byteOffset, unsigned byteLength) final { sendMessage(true, buffer.span().subspan(byteOffset, byteLength)); }
    void send(Blob&) final { fail("Sending Blob data over WebSocket is not supported yet"_s); }

    void close(int code, const String& reason) final
    {
        if (RefPtr client = m_client.get())
            client->didStartClosingHandshake();
        if (!m_link)
            return;
        auto encoder = header();
        encoder.i32(code);
        encoder << reason;
        m_link->send(Message::SocketClose, WTF::move(encoder));
    }

    // As the connection does: the error, then an abnormal close.
    void fail(String&& reason) final
    {
        Ref protectedThis { *this };
        if (RefPtr client = m_client.get())
            client->didReceiveMessageError(WTF::move(reason));
        stopRemote();
        if (RefPtr client = std::exchange(m_client, nullptr).get())
            client->didClose(m_bufferedAmount, ClosingStatus::ClosingHandshakeIncomplete, CloseEventCodeAbnormalClosure, { });
    }

    void disconnect() final
    {
        m_client = nullptr;
        stopRemote();
    }

    void stopRemote()
    {
        if (!channels().remove(m_id))
            return;
        if (RefPtr link = std::exchange(m_link, nullptr)) {
            auto encoder = header();
            link->send(Message::SocketDisconnect, WTF::move(encoder));
        }
    }

    void suspend() final { }
    void resume() final { }

    WebSocketChannelIdentifier progressIdentifier() const final { return m_identifier; }
    bool hasCreatedHandshake() const final { return !!m_handshake; }
    bool isConnected() const final { return m_connected; }

    ResourceRequest clientHandshakeRequest(const CookieGetter& cookieGetter) const final
    {
        return m_handshake ? m_handshake->clientHandshakeRequest(cookieGetter) : ResourceRequest { };
    }

    const ResourceResponse& serverHandshakeResponse() const final { return m_response; }

    static RefPtr<RemoteWebSocketChannel> channelFor(Link& link, Decoder& decoder)
    {
        auto id = decoder.u64();
        auto* channel = id ? channels().get(*id) : nullptr;
        return channel && channel->m_link == &link ? channel : nullptr;
    }

    WeakPtr<Document, WeakPtrImplWithEventTargetData> m_document;
    ThreadSafeWeakPtr<WebSocketChannelClient> m_client;
    WebSocketChannelIdentifier m_identifier;
    uint64_t m_id;
    RefPtr<Link> m_link;
    std::unique_ptr<WebSocketHandshake> m_handshake;
    String m_subprotocol;
    String m_extensions;
    ResourceResponse m_response;
    size_t m_bufferedAmount { 0 };
    bool m_connected { false };
};

void RemoteWebSocketChannel::install()
{
    Link::handle(Message::SocketConnected, [](Link& link, Decoder& decoder) {
        RefPtr channel = channelFor(link, decoder);
        auto subprotocol = decoder.string();
        auto extensions = decoder.string();
        auto response = decoder.decode<ResourceResponse>();
        if (!channel || !response)
            return;
        channel->m_subprotocol = WTF::move(*subprotocol);
        channel->m_extensions = WTF::move(*extensions);
        channel->m_response = WTF::move(*response);
        channel->m_connected = true;
        if (RefPtr client = channel->m_client.get())
            client->didConnect();
    });
    Link::handle(Message::SocketMessage, [](Link& link, Decoder& decoder) {
        RefPtr channel = channelFor(link, decoder);
        auto binary = decoder.boolean();
        auto bytes = binary ? decoder.bytes() : std::nullopt;
        if (!channel || !bytes)
            return;
        RefPtr client = channel->m_client.get();
        if (!client)
            return;
        if (*binary)
            client->didReceiveBinaryData(WTF::move(*bytes));
        else
            client->didReceiveMessage(String::fromUTF8(bytes->span()));
    });
    Link::handle(Message::SocketBuffered, [](Link& link, Decoder& decoder) {
        RefPtr channel = channelFor(link, decoder);
        auto amount = decoder.u64();
        if (!channel || !amount)
            return;
        channel->m_bufferedAmount = *amount;
        if (RefPtr client = channel->m_client.get())
            client->didUpdateBufferedAmount(*amount);
    });
    Link::handle(Message::SocketError, [](Link& link, Decoder& decoder) {
        RefPtr channel = channelFor(link, decoder);
        auto reason = decoder.string();
        if (!channel || !reason)
            return;
        if (RefPtr client = channel->m_client.get())
            client->didReceiveMessageError(WTF::move(*reason));
    });
    Link::handle(Message::SocketClosed, [](Link& link, Decoder& decoder) {
        RefPtr channel = channelFor(link, decoder);
        auto buffered = decoder.u64();
        auto complete = decoder.boolean();
        auto code = decoder.i32();
        auto reason = decoder.string();
        if (!channel || !reason)
            return;
        channels().remove(channel->m_id);
        channel->m_link = nullptr;
        channel->m_connected = false;
        if (RefPtr client = std::exchange(channel->m_client, nullptr).get())
            client->didClose(*buffered, *complete ? ClosingStatus::ClosingHandshakeComplete : ClosingStatus::ClosingHandshakeIncomplete, *code, *reason);
    });
    // The service is gone: every socket it carried drops.
    Link::addCloseObserver([](Link& link) {
        if (link.isServiceEnd())
            return;
        Vector<Ref<RemoteWebSocketChannel>> lost;
        for (auto* channel : channels().values()) {
            if (channel->m_link == &link)
                lost.append(*channel);
        }
        for (auto& channel : lost) {
            channels().remove(channel->m_id);
            channel->m_link = nullptr;
            channel->m_connected = false;
            if (RefPtr client = channel->m_client.get())
                client->didReceiveMessageError("The connection to the profile service was lost"_s);
            if (RefPtr client = std::exchange(channel->m_client, nullptr).get())
                client->didClose(channel->m_bufferedAmount, ClosingStatus::ClosingHandshakeIncomplete, ThreadableWebSocketChannel::CloseEventCodeAbnormalClosure, { });
        }
    });
}

// The profile service's end of a content engine's WebSocket.
class ServiceWebSocket final : public RefCounted<ServiceWebSocket>, public WebSocketConnectionClient {
public:
    using Key = std::pair<unsigned, uint64_t>;

    static Ref<ServiceWebSocket> create(Link& link, uint64_t id) { return adoptRef(*new ServiceWebSocket(link, id)); }
    ~ServiceWebSocket() { m_connection->disconnect(); }

    static HashMap<Key, Ref<ServiceWebSocket>>& sockets()
    {
        static NeverDestroyed<HashMap<Key, Ref<ServiceWebSocket>>> map;
        return map;
    }

    static void install();

    WebSocketConnection& connection() { return m_connection.get(); }

private:
    ServiceWebSocket(Link& link, uint64_t id)
        : m_link(&link)
        , m_id(id)
        , m_connection(WebSocketConnection::create(*this))
    {
    }

    Encoder header() const
    {
        Encoder encoder;
        encoder.u64(m_id);
        return encoder;
    }

    void didConnect() final
    {
        auto encoder = header();
        auto* handshake = m_connection->handshake();
        encoder << m_connection->subprotocol() << m_connection->extensions() << (handshake ? handshake->serverHandshakeResponse() : ResourceResponse { });
        m_link->send(Message::SocketConnected, WTF::move(encoder));
    }

    void sendMessage(bool binary, std::span<const uint8_t> bytes)
    {
        auto encoder = header();
        encoder.boolean(binary);
        encoder.bytes(bytes);
        m_link->send(Message::SocketMessage, WTF::move(encoder));
    }

    void didReceiveText(String&& text) final
    {
        auto utf8 = text.utf8();
        sendMessage(false, byteCast<uint8_t>(utf8.span()));
    }

    void didReceiveBinary(Vector<uint8_t>&& data) final { sendMessage(true, data.span()); }

    void didReceiveError(String&& reason) final
    {
        auto encoder = header();
        encoder << reason;
        m_link->send(Message::SocketError, WTF::move(encoder));
    }

    void didUpdateBufferedAmount(size_t amount) final
    {
        auto encoder = header();
        encoder.u64(amount);
        m_link->send(Message::SocketBuffered, WTF::move(encoder));
    }

    void didClose(size_t bufferedAmount, ClosingStatus status, int code, const String& reason) final
    {
        Ref protectedThis { *this };
        auto encoder = header();
        encoder.u64(bufferedAmount);
        encoder.boolean(status == ClosingStatus::ClosingHandshakeComplete);
        encoder.i32(code);
        encoder << reason;
        m_link->send(Message::SocketClosed, WTF::move(encoder));
        sockets().remove({ m_link->id(), m_id });
    }

    RefPtr<Link> m_link;
    uint64_t m_id;
    Ref<WebSocketConnection> m_connection;
};

static RefPtr<ServiceWebSocket> serviceSocketFor(Link& link, Decoder& decoder)
{
    auto id = decoder.u64();
    if (!id)
        return nullptr;
    auto it = ServiceWebSocket::sockets().find({ link.id(), *id });
    return it == ServiceWebSocket::sockets().end() ? nullptr : it->value.ptr();
}

void ServiceWebSocket::install()
{
    // {id, url, protocol, userAgent, origin, allowCookies}
    Link::handle(Message::SocketConnect, [](Link& link, Decoder& decoder) {
        auto id = decoder.u64();
        auto url = decoder.decode<URL>();
        auto protocol = decoder.string();
        auto userAgent = decoder.string();
        auto origin = decoder.string();
        auto allowCookies = decoder.boolean();
        if (!allowCookies || !*id || sockets().contains({ link.id(), *id }))
            return;
        if (!url->protocolIs("ws"_s) && !url->protocolIs("wss"_s))
            return;
        Ref socket = create(link, *id);
        if (!LinkPolicy::allows(link.id(), *url)) {
            sockets().add({ link.id(), *id }, socket);
            socket->connection().fail("Blocked by the embedder's policy"_s);
            return;
        }
        sockets().add({ link.id(), *id }, socket);
        socket->connection().connect(*url, *protocol, *userAgent, *origin, *allowCookies);
    });
    // {id, binary, bytes}
    Link::handle(Message::SocketSend, [](Link& link, Decoder& decoder) {
        RefPtr socket = serviceSocketFor(link, decoder);
        auto binary = decoder.boolean();
        auto bytes = binary ? decoder.view() : std::nullopt;
        if (!socket || !bytes)
            return;
        if (*binary)
            socket->connection().sendBinary(*bytes);
        else
            socket->connection().sendText(*bytes);
    });
    // {id, code, reason}
    Link::handle(Message::SocketClose, [](Link& link, Decoder& decoder) {
        RefPtr socket = serviceSocketFor(link, decoder);
        auto code = decoder.i32();
        auto reason = decoder.string();
        if (socket && reason)
            socket->connection().close(*code, *reason);
    });
    // {id}: the page is done with it; no more events.
    Link::handle(Message::SocketDisconnect, [](Link& link, Decoder& decoder) {
        auto id = decoder.u64();
        if (!id)
            return;
        if (auto socket = sockets().take({ link.id(), *id }))
            socket->connection().disconnect();
    });
    Link::addCloseObserver([](Link& link) {
        if (!link.isServiceEnd())
            return;
        Vector<Ref<ServiceWebSocket>> closing;
        sockets().removeIf([&](auto& entry) {
            if (entry.key.first != link.id())
                return false;
            closing.append(entry.value);
            return true;
        });
        for (auto& socket : closing)
            socket->connection().disconnect();
    });
}

class EngineSocketProvider final : public SocketProvider {
    RefPtr<ThreadableWebSocketChannel> createWebSocketChannel(Document& document, WebSocketChannelClient& client) final
    {
        if (role() == Role::Content)
            return RemoteWebSocketChannel::create(document, client);
        return EngineWebSocketChannel::create(document, client);
    }

    std::pair<RefPtr<WebTransportSession>, Ref<WebTransportSessionPromise>> initializeWebTransportSession(ScriptExecutionContext&, WebTransportSessionClient&, const URL&, const WebTransportOptions&) final
    {
        return { nullptr, WebTransportSessionPromise::createAndReject() };
    }
};

Ref<SocketProvider> createSocketProvider()
{
    return adoptRef(*new EngineSocketProvider);
}

void installRemoteWebSockets()
{
    RemoteWebSocketChannel::install();
}

void installServiceWebSockets()
{
    ServiceWebSocket::install();
}

} // namespace Inception
