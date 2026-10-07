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
#include <JavaScriptCore/ArrayBuffer.h>
#include <wtf/UniqueArray.h>
#include <wtf/text/CString.h>

namespace Inception {
using namespace WebCore;

class EngineWebSocketChannel final : public RefCounted<EngineWebSocketChannel>, public ThreadableWebSocketChannel, public CurlStream::Client {
public:
    static Ref<EngineWebSocketChannel> create(Document& document, WebSocketChannelClient& client) { return adoptRef(*new EngineWebSocketChannel(document, client)); }
    ~EngineWebSocketChannel() { closeStream(); }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

private:
    EngineWebSocketChannel(Document& document, WebSocketChannelClient& client)
        : m_document(document)
        , m_client(client)
        , m_identifier(WebSocketChannelIdentifier::generate())
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
        m_handshake = makeUnique<WebSocketHandshake>(validated->url, protocol, standardUserAgentForURL(validated->url), document->securityOrigin().toString(), validated->areCookiesAllowed, false);
        m_streamID = CurlContext::singleton().streamScheduler().createStream(validated->url, *this, CurlStream::ServerTrustEvaluation::Enable, CurlStream::LocalhostAlias::Disable);
        return ConnectStatus::OK;
    }

    String subprotocol() final { return m_handshake ? m_handshake->serverWebSocketProtocol() : String { }; }
    String extensions() final { return m_handshake ? m_handshake->acceptedExtensions() : String { }; }

    void send(CString&& message) final
    {
        sendFrame(WebSocketFrame::OpCodeText, byteCast<uint8_t>(message.span()));
    }

    void send(const JSC::ArrayBuffer& buffer, unsigned byteOffset, unsigned byteLength) final
    {
        sendFrame(WebSocketFrame::OpCodeBinary, buffer.span().subspan(byteOffset, byteLength));
    }

    void send(Blob&) final
    {
        fail("Sending Blob data over WebSocket is not supported yet"_s);
    }

    void close(int code, const String& reason) final
    {
        if (m_closeSent)
            return;
        m_closeSent = true;
        Vector<uint8_t> payload;
        if (code != CloseEventCodeNotSpecified) {
            payload.append(static_cast<uint8_t>(code >> 8));
            payload.append(static_cast<uint8_t>(code));
            auto utf8 = reason.utf8();
            payload.append(byteCast<uint8_t>(utf8.span()));
        }
        if (RefPtr client = m_client.get())
            client->didStartClosingHandshake();
        sendFrame(WebSocketFrame::OpCodeClose, payload.span());
    }

    void fail(String&& reason) final
    {
        if (RefPtr client = m_client.get())
            client->didReceiveMessageError(WTF::move(reason));
        finish(CloseEventCodeAbnormalClosure, { }, WebSocketChannelClient::ClosingHandshakeIncomplete);
    }

    void disconnect() final
    {
        m_client = nullptr;
        closeStream();
    }

    void suspend() final { }
    void resume() final { }

    WebSocketChannelIdentifier progressIdentifier() const final { return m_identifier; }
    bool hasCreatedHandshake() const final { return !!m_handshake; }
    bool isConnected() const final { return m_handshake && m_handshake->mode() == WebSocketHandshake::Connected; }

    ResourceRequest clientHandshakeRequest(const CookieGetter& cookieGetter) const final
    {
        return m_handshake ? m_handshake->clientHandshakeRequest(cookieGetter) : ResourceRequest { };
    }

    const ResourceResponse& serverHandshakeResponse() const final
    {
        static NeverDestroyed<ResourceResponse> empty;
        return m_handshake ? m_handshake->serverHandshakeResponse() : empty.get();
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
        if (RefPtr client = m_client.get())
            client->didUpdateBufferedAmount(m_bufferedAmount);
    }

    void didReceiveData(CurlStreamID, const SharedBuffer& data) final
    {
        Ref protectedThis { *this };
        if (!data.size()) {
            finish(CloseEventCodeAbnormalClosure, { }, WebSocketChannelClient::ClosingHandshakeIncomplete);
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
            if (RefPtr client = m_client.get())
                client->didConnect();
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
        RefPtr client = m_client.get();
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
            int code = CloseEventCodeNoStatusRcvd;
            String reason;
            if (payload.size() >= 2) {
                code = (payload[0] << 8) | payload[1];
                reason = String::fromUTF8(payload.subspan(2));
            }
            if (!m_closeSent)
                close(code == CloseEventCodeNoStatusRcvd ? CloseEventCodeNotSpecified : code, reason);
            finish(code, reason, WebSocketChannelClient::ClosingHandshakeComplete);
            return;
        }
        default:
            fail("Unrecognized WebSocket frame"_s);
            return;
        }
        if (!final || !client)
            return;
        auto message = std::exchange(m_message, { });
        if (m_messageOpCode == WebSocketFrame::OpCodeText) {
            auto text = String::fromUTF8(message.span());
            if (text.isNull())
                fail("Could not decode a text frame as UTF-8"_s);
            else
                client->didReceiveMessage(WTF::move(text));
        } else
            client->didReceiveBinaryData(WTF::move(message));
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

    void finish(int code, const String& reason, WebSocketChannelClient::ClosingHandshakeCompletionStatus status)
    {
        closeStream();
        if (RefPtr client = std::exchange(m_client, nullptr).get())
            client->didClose(m_bufferedAmount, status, code == CloseEventCodeNotSpecified ? CloseEventCodeNoStatusRcvd : code, reason);
    }

    void closeStream()
    {
        if (m_streamID == invalidCurlStreamID)
            return;
        CurlContext::singleton().streamScheduler().destroyStream(std::exchange(m_streamID, invalidCurlStreamID));
    }

    WeakPtr<Document, WeakPtrImplWithEventTargetData> m_document;
    ThreadSafeWeakPtr<WebSocketChannelClient> m_client;
    WebSocketChannelIdentifier m_identifier;
    std::unique_ptr<WebSocketHandshake> m_handshake;
    CurlStreamID m_streamID { invalidCurlStreamID };
    Vector<uint8_t> m_input;
    Vector<uint8_t> m_message;
    WebSocketFrame::OpCode m_messageOpCode { WebSocketFrame::OpCodeText };
    size_t m_bufferedAmount { 0 };
    bool m_closeSent { false };
};

class EngineSocketProvider final : public SocketProvider {
    RefPtr<ThreadableWebSocketChannel> createWebSocketChannel(Document& document, WebSocketChannelClient& client) final
    {
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

} // namespace Inception
