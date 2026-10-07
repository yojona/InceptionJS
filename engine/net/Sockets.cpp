#include "config.h"
#include "net/Sockets.h"

#include <arpa/inet.h>
#include <cerrno>
#include <cstdarg>
#include <cstdlib>
#include <cstring>
#include <emscripten/em_macros.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <wtf/Deque.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/Vector.h>
#include <wtf/text/CString.h>

extern "C" {
// js/tcp.js
void inception_tcp_configure(const char* url);
void inception_tcp_open(int id, const char* host, int port);
void inception_tcp_send(int id, const uint8_t*, size_t);
void inception_tcp_close(int id);

// The file system's implementations, for descriptors that are not sockets.
int __real___syscall_poll(intptr_t fds, int nfds, int timeout);
int __real___syscall_fcntl64(int fd, int cmd, ...);
int __real___syscall_ioctl(int fd, int request, ...);
int __real___wasi_fd_close(int fd);
}

namespace Inception::Sockets {

// Below FD_SETSIZE, since select() is one of the ways callers poll.
static constexpr int firstSocket = 768;
static constexpr int lastSocket = FD_SETSIZE - 1;

static bool isSocket(int fd) { return fd >= firstSocket && fd <= lastSocket; }

enum class State : uint8_t { Unconnected, Connecting, Open, Closed, Failed };

struct Socket {
    WTF_DEPRECATED_MAKE_STRUCT_FAST_ALLOCATED(Socket);
    State state { State::Unconnected };
    bool nonBlocking { false };
    bool peerClosed { false };
    int error { 0 };
    // Socket pairs deliver to each other in memory instead of the relay.
    int pairedWith { -1 };
    Deque<uint8_t> input;
    in_addr_t address { 0 };
    in_port_t port { 0 };
};

static HashMap<int, std::unique_ptr<Socket>>& sockets()
{
    static NeverDestroyed<HashMap<int, std::unique_ptr<Socket>>> table;
    return table;
}

static Socket* socketFor(int fd)
{
    if (!isSocket(fd))
        return nullptr;
    auto it = sockets().find(fd);
    return it == sockets().end() ? nullptr : it->value.get();
}

static int allocate()
{
    for (int fd = firstSocket; fd <= lastSocket; ++fd) {
        if (!sockets().contains(fd)) {
            sockets().add(fd, makeUnique<Socket>());
            return fd;
        }
    }
    return -EMFILE;
}

// Host names resolve at the relay. getaddrinfo() hands out placeholder
// addresses in 240.0.0.0/4 (reserved) and connect() maps them back.
static Vector<CString>& placeholderNames()
{
    static NeverDestroyed<Vector<CString>> names;
    return names;
}

static in_addr_t placeholderFor(const char* host)
{
    auto& names = placeholderNames();
    for (size_t i = 0; i < names.size(); ++i) {
        if (!strcmp(names[i].data(), host))
            return htonl(0xF0000000u | static_cast<uint32_t>(i + 1));
    }
    names.append(CString(host));
    return htonl(0xF0000000u | static_cast<uint32_t>(names.size()));
}

static CString hostFor(in_addr_t address)
{
    uint32_t value = ntohl(address);
    if ((value & 0xF0000000u) == 0xF0000000u) {
        size_t index = (value & 0x0FFFFFFFu) - 1;
        if (index < placeholderNames().size())
            return placeholderNames()[index];
    }
    char text[INET_ADDRSTRLEN] { };
    in_addr inAddress { address };
    inet_ntop(AF_INET, &inAddress, text, sizeof(text));
    return CString(text);
}

void configure(const String& relayURL)
{
    inception_tcp_configure(relayURL.utf8().data());
}

static void fillAddress(const Socket& socket, sockaddr* address, socklen_t* length)
{
    if (!address || !length)
        return;
    sockaddr_in result { };
    result.sin_family = AF_INET;
    result.sin_addr.s_addr = socket.address;
    result.sin_port = socket.port;
    memcpy(address, &result, std::min<size_t>(*length, sizeof(result)));
    *length = sizeof(result);
}

static short readiness(const Socket& socket, short events)
{
    short revents = 0;
    if ((events & POLLIN) && (!socket.input.isEmpty() || socket.peerClosed || socket.state == State::Closed))
        revents |= POLLIN;
    if ((events & POLLOUT) && socket.state == State::Open && !socket.peerClosed)
        revents |= POLLOUT;
    if (socket.state == State::Failed)
        revents |= POLLERR;
    if (socket.peerClosed || socket.state == State::Closed)
        revents |= POLLHUP;
    return revents;
}

static ssize_t receive(Socket& socket, uint8_t* buffer, size_t length)
{
    if (socket.input.isEmpty()) {
        if (socket.state == State::Failed)
            return -(socket.error ? socket.error : ECONNRESET);
        if (socket.peerClosed || socket.state == State::Closed)
            return 0;
        return -EAGAIN;
    }
    size_t count = std::min(length, socket.input.size());
    for (size_t i = 0; i < count; ++i)
        buffer[i] = socket.input.takeFirst();
    return count;
}

static ssize_t transmit(int fd, Socket& socket, const uint8_t* data, size_t length)
{
    if (socket.pairedWith >= 0) {
        auto* peer = socketFor(socket.pairedWith);
        if (!peer)
            return -EPIPE;
        for (size_t i = 0; i < length; ++i)
            peer->input.append(data[i]);
        return length;
    }
    switch (socket.state) {
    case State::Open:
        if (socket.peerClosed)
            return -EPIPE;
        inception_tcp_send(fd, data, length);
        return length;
    case State::Connecting:
        return -EAGAIN;
    case State::Failed:
        return -(socket.error ? socket.error : ECONNRESET);
    default:
        return -ENOTCONN;
    }
}

} // namespace Inception::Sockets

using namespace Inception::Sockets;

// Events from js/tcp.js.
extern "C" EMSCRIPTEN_KEEPALIVE void inception_tcp_opened(int fd)
{
    if (auto* socket = socketFor(fd); socket && socket->state == State::Connecting)
        socket->state = State::Open;
}

extern "C" EMSCRIPTEN_KEEPALIVE void inception_tcp_data(int fd, const uint8_t* data, size_t length)
{
    auto* socket = socketFor(fd);
    if (!socket)
        return;
    for (size_t i = 0; i < length; ++i)
        socket->input.append(data[i]);
}

// The relay has no half-close: a close is the end of both directions. A
// stream that closes before it ever carried data is reported as refused, the
// way a failed connect would be.
extern "C" EMSCRIPTEN_KEEPALIVE void inception_tcp_closed(int fd, int refused)
{
    auto* socket = socketFor(fd);
    if (!socket)
        return;
    if (refused && socket->state == State::Connecting) {
        socket->state = State::Failed;
        socket->error = ECONNREFUSED;
        return;
    }
    socket->peerClosed = true;
}

extern "C" {

int __wrap___syscall_socket(int domain, int type, int, int, int, int)
{
    if (domain != AF_INET || (type & 0xf) != SOCK_STREAM)
        return -EAFNOSUPPORT;
    int fd = allocate();
    if (fd < 0)
        return fd;
    socketFor(fd)->nonBlocking = type & SOCK_NONBLOCK;
    return fd;
}

int __syscall_socketpair(int, int, int, intptr_t fds, int, int)
{
    int first = allocate();
    if (first < 0)
        return first;
    int second = allocate();
    if (second < 0) {
        sockets().remove(first);
        return second;
    }
    socketFor(first)->pairedWith = second;
    socketFor(second)->pairedWith = first;
    socketFor(first)->state = socketFor(second)->state = State::Open;
    reinterpret_cast<int*>(fds)[0] = first;
    reinterpret_cast<int*>(fds)[1] = second;
    return 0;
}

int __wrap___syscall_connect(int fd, intptr_t address, size_t length, int, int, int)
{
    auto* socket = socketFor(fd);
    if (!socket)
        return -ENOTSOCK;
    if (socket->state != State::Unconnected)
        return socket->state == State::Connecting ? -EALREADY : -EISCONN;
    if (length < sizeof(sockaddr_in) || reinterpret_cast<sockaddr*>(address)->sa_family != AF_INET)
        return -EAFNOSUPPORT;
    auto* inAddress = reinterpret_cast<sockaddr_in*>(address);
    socket->address = inAddress->sin_addr.s_addr;
    socket->port = inAddress->sin_port;
    socket->state = State::Connecting;
    inception_tcp_open(fd, hostFor(socket->address).data(), ntohs(socket->port));
    // Blocking connects cannot wait here either; callers poll for writability.
    return -EINPROGRESS;
}

int __wrap___syscall_getsockopt(int fd, int level, int name, intptr_t value, intptr_t length, int)
{
    auto* socket = socketFor(fd);
    if (!socket)
        return -ENOTSOCK;
    if (!value || !length)
        return -EFAULT;
    int result = 0;
    if (level == SOL_SOCKET && name == SO_ERROR) {
        result = socket->state == State::Failed ? socket->error : 0;
        socket->error = socket->state == State::Failed ? socket->error : 0;
    } else if (level == SOL_SOCKET && name == SO_TYPE)
        result = SOCK_STREAM;
    memcpy(reinterpret_cast<void*>(value), &result, sizeof(result));
    *reinterpret_cast<socklen_t*>(length) = sizeof(result);
    return 0;
}

int __syscall_setsockopt(int fd, int, int, intptr_t, size_t, int)
{
    return socketFor(fd) ? 0 : -ENOTSOCK;
}

int __wrap___syscall_getsockname(int fd, intptr_t address, intptr_t length, int, int, int)
{
    auto* socket = socketFor(fd);
    if (!socket)
        return -ENOTSOCK;
    Socket local;
    local.address = htonl(INADDR_LOOPBACK);
    fillAddress(local, reinterpret_cast<sockaddr*>(address), reinterpret_cast<socklen_t*>(length));
    return 0;
}

int __wrap___syscall_getpeername(int fd, intptr_t address, intptr_t length, int, int, int)
{
    auto* socket = socketFor(fd);
    if (!socket)
        return -ENOTSOCK;
    if (socket->state == State::Unconnected)
        return -ENOTCONN;
    fillAddress(*socket, reinterpret_cast<sockaddr*>(address), reinterpret_cast<socklen_t*>(length));
    return 0;
}

int __syscall_shutdown(int fd, int)
{
    return socketFor(fd) ? 0 : -ENOTSOCK;
}

int __wrap___syscall_sendto(int fd, intptr_t message, size_t length, int, intptr_t, size_t)
{
    auto* socket = socketFor(fd);
    if (!socket)
        return -ENOTSOCK;
    return transmit(fd, *socket, reinterpret_cast<const uint8_t*>(message), length);
}

int __wrap___syscall_recvfrom(int fd, intptr_t buffer, size_t length, int, intptr_t, intptr_t)
{
    auto* socket = socketFor(fd);
    if (!socket)
        return -ENOTSOCK;
    return receive(*socket, reinterpret_cast<uint8_t*>(buffer), length);
}

int __wrap___syscall_sendmsg(int fd, intptr_t message, int, intptr_t, size_t, int)
{
    auto* socket = socketFor(fd);
    if (!socket)
        return -ENOTSOCK;
    auto* header = reinterpret_cast<msghdr*>(message);
    ssize_t total = 0;
    for (int i = 0; i < header->msg_iovlen; ++i) {
        auto sent = transmit(fd, *socket, static_cast<const uint8_t*>(header->msg_iov[i].iov_base), header->msg_iov[i].iov_len);
        if (sent < 0)
            return total ? total : sent;
        total += sent;
    }
    return total;
}

int __wrap___syscall_recvmsg(int fd, intptr_t message, int, int, int, int)
{
    auto* socket = socketFor(fd);
    if (!socket)
        return -ENOTSOCK;
    auto* header = reinterpret_cast<msghdr*>(message);
    ssize_t total = 0;
    for (int i = 0; i < header->msg_iovlen; ++i) {
        auto received = receive(*socket, static_cast<uint8_t*>(header->msg_iov[i].iov_base), header->msg_iov[i].iov_len);
        if (received <= 0)
            return total ? total : received;
        total += received;
        if (static_cast<size_t>(received) < header->msg_iov[i].iov_len)
            break;
    }
    return total;
}

int __wrap___syscall_bind(int fd, intptr_t, size_t, int, int, int) { return socketFor(fd) ? -EOPNOTSUPP : -ENOTSOCK; }
int __wrap___syscall_listen(int fd, int, int, int, int, int) { return socketFor(fd) ? -EOPNOTSUPP : -ENOTSOCK; }
int __wrap___syscall_accept4(int fd, intptr_t, intptr_t, int, int, int) { return socketFor(fd) ? -EOPNOTSUPP : -ENOTSOCK; }

// Never waits: the network schedulers poll from the run loop and are woken
// when the relay delivers data.
int __wrap___syscall_poll(intptr_t fds, int count, int timeout)
{
    auto* entries = reinterpret_cast<pollfd*>(fds);
    bool anySocket = false;
    for (int i = 0; i < count; ++i)
        anySocket |= isSocket(entries[i].fd);
    if (!anySocket)
        return __real___syscall_poll(fds, count, timeout);

    int ready = 0;
    for (int i = 0; i < count; ++i) {
        auto& entry = entries[i];
        entry.revents = 0;
        if (entry.fd < 0)
            continue;
        if (auto* socket = socketFor(entry.fd))
            entry.revents = readiness(*socket, entry.events);
        else if (isSocket(entry.fd))
            entry.revents = POLLNVAL;
        else {
            pollfd single { entry.fd, entry.events, 0 };
            __real___syscall_poll(reinterpret_cast<intptr_t>(&single), 1, 0);
            entry.revents = single.revents;
        }
        if (entry.revents)
            ++ready;
    }
    return ready;
}

int __syscall__newselect(int count, intptr_t readSet, intptr_t writeSet, intptr_t exceptSet, intptr_t)
{
    auto* reads = reinterpret_cast<fd_set*>(readSet);
    auto* writes = reinterpret_cast<fd_set*>(writeSet);
    auto* excepts = reinterpret_cast<fd_set*>(exceptSet);
    fd_set readyReads, readyWrites, readyExcepts;
    FD_ZERO(&readyReads);
    FD_ZERO(&readyWrites);
    FD_ZERO(&readyExcepts);
    int ready = 0;
    for (int fd = 0; fd < count; ++fd) {
        bool wantsRead = reads && FD_ISSET(fd, reads);
        bool wantsWrite = writes && FD_ISSET(fd, writes);
        bool wantsExcept = excepts && FD_ISSET(fd, excepts);
        if (!wantsRead && !wantsWrite && !wantsExcept)
            continue;
        auto* socket = socketFor(fd);
        if (!socket)
            return -EBADF;
        short revents = readiness(*socket, (wantsRead ? POLLIN : 0) | (wantsWrite ? POLLOUT : 0));
        if (wantsRead && (revents & (POLLIN | POLLHUP))) {
            FD_SET(fd, &readyReads);
            ++ready;
        }
        if (wantsWrite && (revents & POLLOUT)) {
            FD_SET(fd, &readyWrites);
            ++ready;
        }
        if (wantsExcept && (revents & POLLERR)) {
            FD_SET(fd, &readyExcepts);
            ++ready;
        }
    }
    if (reads)
        *reads = readyReads;
    if (writes)
        *writes = readyWrites;
    if (excepts)
        *excepts = readyExcepts;
    return ready;
}

int __wrap___syscall_fcntl64(int fd, int command, ...)
{
    va_list arguments;
    va_start(arguments, command);
    intptr_t argument = va_arg(arguments, intptr_t);
    va_end(arguments);
    if (!isSocket(fd))
        return __real___syscall_fcntl64(fd, command, argument);
    auto* socket = socketFor(fd);
    if (!socket)
        return -EBADF;
    switch (command) {
    case F_GETFL:
        return O_RDWR | (socket->nonBlocking ? O_NONBLOCK : 0);
    case F_SETFL:
        socket->nonBlocking = argument & O_NONBLOCK;
        return 0;
    case F_GETFD:
    case F_SETFD:
        return 0;
    default:
        return -EINVAL;
    }
}

int __wrap___syscall_ioctl(int fd, int request, ...)
{
    va_list arguments;
    va_start(arguments, request);
    intptr_t argument = va_arg(arguments, intptr_t);
    va_end(arguments);
    if (!isSocket(fd))
        return __real___syscall_ioctl(fd, request, argument);
    auto* socket = socketFor(fd);
    if (!socket)
        return -EBADF;
    if (request == FIONBIO) {
        socket->nonBlocking = *reinterpret_cast<int*>(argument);
        return 0;
    }
    if (request == FIONREAD) {
        *reinterpret_cast<int*>(argument) = socket->input.size();
        return 0;
    }
    return -ENOTTY;
}

int __wrap___wasi_fd_close(int fd)
{
    if (!isSocket(fd))
        return __real___wasi_fd_close(fd);
    auto* socket = socketFor(fd);
    if (!socket)
        return EBADF;
    if (socket->pairedWith >= 0) {
        if (auto* peer = socketFor(socket->pairedWith)) {
            peer->peerClosed = true;
            peer->pairedWith = -1;
        }
    } else if (socket->state == State::Connecting || socket->state == State::Open)
        inception_tcp_close(fd);
    sockets().remove(fd);
    return 0;
}

int getaddrinfo(const char* node, const char* service, const addrinfo* hints, addrinfo** result)
{
    if (!node && !service)
        return EAI_NONAME;
    if (hints && hints->ai_family != AF_UNSPEC && hints->ai_family != AF_INET)
        return EAI_FAMILY;
    in_port_t port = service ? htons(static_cast<uint16_t>(atoi(service))) : 0;
    in_addr_t address;
    if (!node)
        address = htonl((hints && (hints->ai_flags & AI_PASSIVE)) ? INADDR_ANY : INADDR_LOOPBACK);
    else if (inet_pton(AF_INET, node, &address) != 1)
        address = placeholderFor(node);

    auto* info = static_cast<addrinfo*>(calloc(1, sizeof(addrinfo) + sizeof(sockaddr_in)));
    auto* socketAddress = reinterpret_cast<sockaddr_in*>(info + 1);
    socketAddress->sin_family = AF_INET;
    socketAddress->sin_addr.s_addr = address;
    socketAddress->sin_port = port;
    info->ai_family = AF_INET;
    info->ai_socktype = hints && hints->ai_socktype ? hints->ai_socktype : SOCK_STREAM;
    info->ai_protocol = IPPROTO_TCP;
    info->ai_addrlen = sizeof(sockaddr_in);
    info->ai_addr = reinterpret_cast<sockaddr*>(socketAddress);
    *result = info;
    return 0;
}

void freeaddrinfo(addrinfo* info)
{
    while (info) {
        auto* next = info->ai_next;
        free(info);
        info = next;
    }
}

} // extern "C"
