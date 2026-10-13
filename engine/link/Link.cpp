#include "config.h"
#include "link/Link.h"

#include "bridge/Bridge.h"
#include "net/SharedCookies.h"
#include "net/Sockets.h"
#include <cstdlib>
#include <emscripten/em_macros.h>
#include <emscripten/wasmfs.h>
#include <wtf/MonotonicTime.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

extern "C" {
void inception_tcp_open(int id, const char* host, int port);
void inception_link_install();
void inception_link_post(unsigned link, const uint8_t* data, size_t length);
uint8_t* inception_link_call_sync(unsigned link, const uint8_t* data, size_t length, size_t* replyLength);
void inception_loop_schedule(double delayMs);
}

namespace Inception {

static Role s_role { Role::Standalone };
static void registerPing();

Role role()
{
    return s_role;
}

void setRole(Role role)
{
    s_role = role;
    // The listener for the host's link messages.
    if (role != Role::Standalone) {
        registerPing();
        inception_link_install();
    }
}

// A frame: kind, message, call id, then the payload.
enum class Kind : uint8_t { Send, Call, Reply, Failure };
static constexpr size_t headerBytes = 1 + 2 + 8;

static HashMap<unsigned, Ref<Link>>& links()
{
    static NeverDestroyed<HashMap<unsigned, Ref<Link>>> map;
    return map;
}

struct Handlers {
    HashMap<uint16_t, Link::Handler> sends;
    HashMap<uint16_t, Link::CallHandler> calls;
    HashMap<uint16_t, Link::SyncHandler> syncs;
    Vector<Function<void(Link&)>> openObservers;
    Vector<Function<void(Link&)>> closeObservers;
};

static Handlers& handlers()
{
    static NeverDestroyed<Handlers> table;
    return table;
}

Reply::Reply(Link& link, Message message, uint64_t callID)
    : m_link(&link)
    , m_message(message)
    , m_callID(callID)
{
}

Reply::Reply(Reply&& other)
    : m_link(std::exchange(other.m_link, nullptr))
    , m_message(other.m_message)
    , m_callID(other.m_callID)
{
}

Reply::~Reply()
{
    fail();
}

void Reply::send(Encoder&& encoder)
{
    if (RefPtr link = std::exchange(m_link, nullptr))
        link->post(static_cast<uint8_t>(Kind::Reply), m_message, m_callID, encoder.span());
}

void Reply::fail()
{
    if (RefPtr link = std::exchange(m_link, nullptr))
        link->post(static_cast<uint8_t>(Kind::Failure), m_message, m_callID, { });
}

Link::Link(unsigned id, bool serviceEnd)
    : m_id(id)
    , m_serviceEnd(serviceEnd)
{
}

Link* Link::byID(unsigned id)
{
    auto it = links().find(id);
    return it == links().end() ? nullptr : it->value.ptr();
}

Link* Link::service()
{
    for (auto& link : links().values()) {
        if (!link->m_serviceEnd && link->m_open)
            return link.ptr();
    }
    return nullptr;
}

Vector<Ref<Link>> Link::all()
{
    return copyToVector(links().values());
}

void Link::handle(Message message, Handler&& handler)
{
    handlers().sends.set(static_cast<uint16_t>(message), WTF::move(handler));
}

void Link::handleCall(Message message, CallHandler&& handler)
{
    handlers().calls.set(static_cast<uint16_t>(message), WTF::move(handler));
}

void Link::handleSync(Message message, SyncHandler&& handler)
{
    handlers().syncs.set(static_cast<uint16_t>(message), WTF::move(handler));
}

void Link::addOpenObserver(Function<void(Link&)>&& observer)
{
    handlers().openObservers.append(WTF::move(observer));
}

void Link::addCloseObserver(Function<void(Link&)>&& observer)
{
    handlers().closeObservers.append(WTF::move(observer));
}

static void writeHeader(Vector<uint8_t>& frame, uint8_t kind, Message message, uint64_t callID)
{
    frame.append(kind);
    auto type = static_cast<uint16_t>(message);
    frame.append(static_cast<uint8_t>(type));
    frame.append(static_cast<uint8_t>(type >> 8));
    for (unsigned i = 0; i < 8; ++i)
        frame.append(static_cast<uint8_t>(callID >> (8 * i)));
}

void Link::post(uint8_t kind, Message message, uint64_t callID, std::span<const uint8_t> payload)
{
    if (!m_open)
        return;
    Vector<uint8_t> frame;
    frame.reserveInitialCapacity(headerBytes + payload.size());
    writeHeader(frame, kind, message, callID);
    frame.append(payload);
    inception_link_post(m_id, frame.span().data(), frame.size());
}

void Link::send(Message message, Encoder&& encoder)
{
    post(static_cast<uint8_t>(Kind::Send), message, 0, encoder.span());
}

void Link::call(Message message, Encoder&& encoder, CompletionHandler<void(Decoder*)>&& completion)
{
    if (!m_open) {
        completion(nullptr);
        return;
    }
    auto callID = ++m_lastCallID;
    m_calls.add(callID, WTF::move(completion));
    post(static_cast<uint8_t>(Kind::Call), message, callID, encoder.span());
}

std::optional<Vector<uint8_t>> Link::callSync(Message message, Encoder&& encoder)
{
    if (!m_open || m_serviceEnd)
        return std::nullopt;
    Vector<uint8_t> frame;
    writeHeader(frame, static_cast<uint8_t>(Kind::Call), message, 0);
    frame.append(encoder.span());
    size_t length = 0;
    auto* reply = inception_link_call_sync(m_id, frame.span().data(), frame.size(), &length);
    if (!reply) {
        // No answer means the service is gone or stuck; this link is done.
        closed(m_id);
        return std::nullopt;
    }
    // The first byte says whether the handler answered.
    std::optional<Vector<uint8_t>> result;
    if (length >= 1 && reply[0] == 1)
        result = Vector<uint8_t> { std::span<const uint8_t> { reply + 1, length - 1 } };
    free(reply);
    return result;
}

void Link::opened(unsigned id, bool serviceEnd)
{
    if (links().contains(id))
        return;
    Ref link = adoptRef(*new Link(id, serviceEnd));
    links().add(id, link);
    for (auto& observer : handlers().openObservers)
        observer(link);
}

void Link::closed(unsigned id)
{
    auto it = links().find(id);
    if (it == links().end())
        return;
    Ref link = it->value;
    links().remove(it);
    link->close();
}

void Link::close()
{
    if (!m_open)
        return;
    m_open = false;
    auto calls = std::exchange(m_calls, { });
    for (auto& completion : calls.values())
        completion(nullptr);
    for (auto& observer : handlers().closeObservers)
        observer(*this);
}

struct Header {
    Kind kind;
    Message message;
    uint64_t callID;
};

static std::optional<Header> readHeader(std::span<const uint8_t> frame)
{
    if (frame.size() < headerBytes || frame[0] > static_cast<uint8_t>(Kind::Failure))
        return std::nullopt;
    uint64_t callID = 0;
    for (unsigned i = 0; i < 8; ++i)
        callID |= static_cast<uint64_t>(frame[3 + i]) << (8 * i);
    return Header { static_cast<Kind>(frame[0]), static_cast<Message>(frame[1] | (frame[2] << 8)), callID };
}

void Link::receive(std::span<const uint8_t> frame)
{
    Ref protectedThis { *this };
    auto header = readHeader(frame);
    if (!header || !m_open)
        return;
    Decoder decoder { frame.subspan(headerBytes) };
    auto type = static_cast<uint16_t>(header->message);
    switch (header->kind) {
    case Kind::Send:
        if (auto it = handlers().sends.find(type); it != handlers().sends.end())
            it->value(*this, decoder);
        break;
    case Kind::Call: {
        Reply reply { *this, header->message, header->callID };
        if (auto it = handlers().calls.find(type); it != handlers().calls.end())
            it->value(*this, decoder, WTF::move(reply));
        break;
    }
    case Kind::Reply:
    case Kind::Failure:
        if (auto completion = m_calls.take(header->callID)) {
            if (header->kind == Kind::Reply)
                completion(&decoder);
            else
                completion(nullptr);
        }
        break;
    }
}

std::optional<Vector<uint8_t>> Link::receiveSync(std::span<const uint8_t> frame)
{
    Ref protectedThis { *this };
    auto header = readHeader(frame);
    Vector<uint8_t> answer { static_cast<uint8_t>(0) };
    if (!header || header->kind != Kind::Call || !m_serviceEnd)
        return answer;
    auto it = handlers().syncs.find(static_cast<uint16_t>(header->message));
    if (it == handlers().syncs.end())
        return answer;
    Decoder decoder { frame.subspan(headerBytes) };
    Encoder reply;
    if (!it->value(*this, decoder, reply))
        return answer;
    answer[0] = 1;
    answer.append(reply.span());
    return answer;
}

static void registerPing()
{
    // Echoes what it gets: the transport's own test.
    Link::handleCall(Message::Ping, [](Link&, Decoder& decoder, Reply&& reply) {
        auto bytes = decoder.bytes();
        if (!bytes)
            return;
        Encoder encoder;
        encoder << *bytes;
        reply.send(WTF::move(encoder));
    });
    Link::handleSync(Message::PingSync, [](Link&, Decoder& decoder, Encoder& reply) {
        auto bytes = decoder.bytes();
        if (!bytes)
            return false;
        reply << *bytes;
        return true;
    });
}

static void emitPingResult(double id, bool ok, size_t bytes, MonotonicTime started)
{
    auto result = JSON::Object::create();
    result->setDouble("id"_s, id);
    result->setBoolean("ok"_s, ok);
    result->setInteger("bytes"_s, static_cast<int>(bytes));
    result->setDouble("ms"_s, (MonotonicTime::now() - started).milliseconds());
    emitEvent("debug.link.result"_s, WTF::move(result));
}

void registerLinkDebugCommands()
{
    registerCookieDebugCommands();
    // {files?, network?}: this engine's own code tries to open the profile's
    // storage, or a socket through the relay at `network`, as a subverted
    // engine would. A standalone engine or a service may; a content engine
    // is stopped by its guard (js/guard.js) before either is reached.
    registerCommand("debug.reach"_s, [](JSON::Object& args) {
        if (args.getBoolean("files"_s).value_or(false)) {
            auto backend = wasmfs_create_opfs_backend();
            wasmfs_create_directory("/reached", 0777, backend);
            report("warn"_s, "debug.reach: opened the origin-private file system"_s);
        }
        auto network = args.getString("network"_s);
        if (!network.isEmpty()) {
            Sockets::configure(network);
            inception_tcp_open(0x7fff0000, "example.com", 443);
            report("warn"_s, "debug.reach: opened a socket"_s);
        }
    });

    // {id, bytes, sync}: a content engine sends `bytes` bytes to its service
    // and checks the echo; "debug.link.result" {id, ok, bytes, ms}.
    registerCommand("debug.link"_s, [](JSON::Object& args) {
        double id = args.getDouble("id"_s).value_or(0);
        size_t size = std::clamp<double>(args.getDouble("bytes"_s).value_or(16), 0, 64 * 1024 * 1024);
        bool sync = args.getBoolean("sync"_s).value_or(false);
        auto started = MonotonicTime::now();
        Vector<uint8_t> payload;
        payload.appendUsingFunctor(size, [](size_t i) { return static_cast<uint8_t>(i * 7 + 3); });
        RefPtr link = Link::service();
        if (!link) {
            emitPingResult(id, false, 0, started);
            return;
        }
        Encoder encoder;
        encoder << payload;
        if (sync) {
            auto reply = link->callSync(Message::PingSync, WTF::move(encoder));
            std::optional<Vector<uint8_t>> echoed;
            if (reply) {
                Decoder decoder { reply->span() };
                echoed = decoder.bytes();
            }
            emitPingResult(id, echoed && *echoed == payload, echoed ? echoed->size() : 0, started);
            return;
        }
        link->call(Message::Ping, WTF::move(encoder), [id, payload = WTF::move(payload), started](Decoder* decoder) {
            auto echoed = decoder ? decoder->bytes() : std::nullopt;
            emitPingResult(id, echoed && *echoed == payload, echoed ? echoed->size() : 0, started);
        });
    });
}

} // namespace Inception

// js/link.js: the host attached or closed a link.
extern "C" EMSCRIPTEN_KEEPALIVE void inception_link_opened(unsigned id, int serviceEnd)
{
    Inception::Link::opened(id, serviceEnd);
}

extern "C" EMSCRIPTEN_KEEPALIVE void inception_link_closed(unsigned id)
{
    Inception::Link::closed(id);
}

extern "C" EMSCRIPTEN_KEEPALIVE void inception_link_receive(unsigned id, const uint8_t* data, size_t length)
{
    if (RefPtr link = Inception::Link::byID(id))
        link->receive({ data, length });
}

// A service answers a content engine that waits: the reply is malloc'd here
// and freed by js/link.js. Its first byte says whether a handler answered.
extern "C" EMSCRIPTEN_KEEPALIVE uint8_t* inception_link_receive_sync(unsigned id, const uint8_t* data, size_t length, size_t* replyLength)
{
    std::optional<Vector<uint8_t>> reply;
    if (RefPtr link = Inception::Link::byID(id))
        reply = link->receiveSync({ data, length });
    if (!reply)
        reply = Vector<uint8_t> { static_cast<uint8_t>(0) };
    auto* buffer = static_cast<uint8_t*>(malloc(reply->size()));
    memcpy(buffer, reply->span().data(), reply->size());
    *replyLength = reply->size();
    return buffer;
}
