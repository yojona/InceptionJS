#pragma once

#include "link/Codec.h"
#include <wtf/CompletionHandler.h>
#include <wtf/Function.h>
#include <wtf/HashMap.h>
#include <wtf/RefCounted.h>

namespace Inception {

// What this engine is in its profile (set by "init"):
// - Standalone: one engine with everything in it (cookies, storage, network),
//   as before profile services existed.
// - Profile: the profile service. It owns the profile's files, cookies,
//   storage, IndexedDB, history and downloads, and the only network
//   connection; it shows no page and runs no page script.
// - Content: shows pages. It has no files and no network of its own: what
//   needs them goes to the profile service over its link.
enum class Role : uint8_t { Standalone, Profile, Content };
Role role();
void setRole(Role);

// Every message that crosses a link. Each module registers the handlers of
// its own messages on the side that answers them.
enum class Message : uint16_t {
    Ping = 1,
    PingSync,
};

class Link;

// The answer to a call, sent when the handler has it. A Reply dropped without
// an answer answers with a failure, so the caller never waits forever.
class Reply {
public:
    Reply(Link&, Message, uint64_t callID);
    Reply(Reply&&);
    Reply& operator=(Reply&&) = delete;
    ~Reply();

    void send(Encoder&& = { });
    void fail();

private:
    RefPtr<Link> m_link;
    Message m_message;
    uint64_t m_callID;
};

// A connection between a content engine and its profile service: a message
// port for everything asynchronous, and shared memory for the few calls a
// content engine must have answered before it can go on (a cookie read by
// script, a storage area's first use). The host makes the pair and gives one
// end to each engine; both ends are this class.
//
// A content engine has one link, to its service. A service has one per
// content engine. A link closes when the other engine is gone; a content
// engine's calls then fail and it waits for the host to attach a new one.
class Link final : public RefCounted<Link> {
public:
    using Handler = Function<void(Link&, Decoder&)>;
    using CallHandler = Function<void(Link&, Decoder&, Reply&&)>;
    // Answers into `reply` before returning; false fails the call.
    using SyncHandler = Function<bool(Link&, Decoder&, Encoder& reply)>;

    static Link* byID(unsigned);
    // A content engine's link to its profile service, if it has an open one.
    static Link* service();
    static Vector<Ref<Link>> all();

    static void handle(Message, Handler&&);
    static void handleCall(Message, CallHandler&&);
    static void handleSync(Message, SyncHandler&&);
    // When a link opens or closes, on either side.
    static void addOpenObserver(Function<void(Link&)>&&);
    static void addCloseObserver(Function<void(Link&)>&&);

    unsigned id() const { return m_id; }
    bool isOpen() const { return m_open; }
    // This end belongs to the service (its peer is a content engine).
    bool isServiceEnd() const { return m_serviceEnd; }

    void send(Message, Encoder&& = { });
    // `completion` gets the reply, or null when the call failed or the link
    // closed first.
    void call(Message, Encoder&&, CompletionHandler<void(Decoder*)>&&);
    // Blocks this thread until the peer answers (content engines only, to
    // their service). Null when it failed or the link is closed.
    std::optional<Vector<uint8_t>> callSync(Message, Encoder&& = { });

    // Called from js/link.js.
    static void opened(unsigned id, bool serviceEnd);
    static void closed(unsigned id);
    void receive(std::span<const uint8_t>);
    std::optional<Vector<uint8_t>> receiveSync(std::span<const uint8_t>);

private:
    friend class Reply;
    Link(unsigned id, bool serviceEnd);
    void post(uint8_t kind, Message, uint64_t callID, std::span<const uint8_t> payload);
    void close();

    unsigned m_id;
    bool m_serviceEnd;
    bool m_open { true };
    uint64_t m_lastCallID { 0 };
    HashMap<uint64_t, CompletionHandler<void(Decoder*)>> m_calls;
};

void registerLinkDebugCommands();

} // namespace Inception
