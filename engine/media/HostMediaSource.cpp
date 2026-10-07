#include "config.h"
#include "media/HostMediaSource.h"

#include "ContentType.h"
#include "MediaSourcePrivateClient.h"
#include "SharedBuffer.h"
#include "SourceBufferPrivateClient.h"
#include "media/HostMediaPlayer.h"
#include "media/MediaBridge.h"
#include <wtf/Logger.h>
#include <wtf/NeverDestroyed.h>

extern "C" {
void inception_media_append(unsigned player, unsigned sourceBuffer, const uint8_t*, size_t);
}

namespace Inception::Media {
using namespace WebCore;

HostMediaSource::HostMediaSource(HostMediaPlayer& player, MediaSourcePrivateClient& client)
    : MediaSourcePrivate(client)
    , m_player(&player)
{
}

RefPtr<MediaPlayerPrivateInterface> HostMediaSource::player() const
{
    return m_player;
}

HostSourceBuffer* HostMediaSource::sourceBuffer(unsigned id) const
{
    for (auto& buffer : sourceBuffers()) {
        auto& hostBuffer = static_cast<HostSourceBuffer&>(buffer.get());
        if (hostBuffer.id() == id)
            return &hostBuffer;
    }
    return nullptr;
}

MediaSourcePrivate::AddStatus HostMediaSource::addSourceBuffer(const ContentType& type, const MediaSourceConfiguration&, RefPtr<SourceBufferPrivate>& result)
{
    if (!m_player)
        return AddStatus::InvalidState;
    if (!hostSupports(type, true))
        return AddStatus::NotSupported;

    auto buffer = HostSourceBuffer::create(*this, m_nextSourceBufferID++);
    {
        Locker locker { m_lock };
        m_sourceBuffers.append(buffer.copyRef());
    }
    auto data = JSON::Object::create();
    data->setInteger("sb"_s, buffer->id());
    data->setString("type"_s, type.raw());
    m_player->sendToHost("media.addSourceBuffer"_s, WTF::move(data));
    result = WTF::move(buffer);
    return AddStatus::Ok;
}

void HostMediaSource::removeSourceBuffer(SourceBufferPrivate& buffer)
{
    if (m_player) {
        auto data = JSON::Object::create();
        data->setInteger("sb"_s, static_cast<HostSourceBuffer&>(buffer).id());
        m_player->sendToHost("media.removeSourceBuffer"_s, WTF::move(data));
    }
    MediaSourcePrivate::removeSourceBuffer(buffer);
}

void HostMediaSource::durationChanged(const MediaTime& duration)
{
    MediaSourcePrivate::durationChanged(duration);
    if (!m_player)
        return;
    auto data = JSON::Object::create();
    if (duration.isValid() && !duration.isPositiveInfinite())
        data->setDouble("duration"_s, duration.toDouble());
    else
        data->setValue("duration"_s, JSON::Value::null());
    m_player->sendToHost("media.duration"_s, WTF::move(data));
}

void HostMediaSource::markEndOfStream(EndOfStreamStatus status)
{
    MediaSourcePrivate::markEndOfStream(status);
    if (!m_player)
        return;
    auto data = JSON::Object::create();
    switch (status) {
    case EndOfStreamStatus::NetworkError:
        data->setString("error"_s, "network"_s);
        break;
    case EndOfStreamStatus::DecodeError:
        data->setString("error"_s, "decode"_s);
        break;
    case EndOfStreamStatus::NoError:
        break;
    }
    m_player->sendToHost("media.endOfStream"_s, WTF::move(data));
}

HostSourceBuffer::HostSourceBuffer(HostMediaSource& source, unsigned id)
    : SourceBufferPrivate(source)
    , m_id(id)
{
}

void HostSourceBuffer::send(const String& event, Ref<JSON::Object>&& data)
{
    RefPtr source = static_cast<HostMediaSource*>(m_mediaSource.get().get());
    if (!source || !source->hostPlayer())
        return;
    data->setInteger("sb"_s, m_id);
    source->hostPlayer()->sendToHost(event, WTF::move(data));
}

Ref<MediaPromise> HostSourceBuffer::append(Ref<SharedBuffer>&& data)
{
    RefPtr source = static_cast<HostMediaSource*>(m_mediaSource.get().get());
    if (!source || !source->hostPlayer())
        return MediaPromise::createAndReject(PlatformMediaError::SourceRemoved);
    auto span = data->span();
    inception_media_append(source->hostPlayer()->id(), m_id, span.data(), span.size());
    m_pending.append(MediaPromise::Producer { });
    return m_pending.last().promise();
}

Ref<MediaPromise> HostSourceBuffer::appendInternal(Ref<SharedBuffer>&&)
{
    // append() forwards the bytes to the host; nothing parses them here.
    return MediaPromise::createAndReject(PlatformMediaError::LogicError);
}

Ref<MediaPromise> HostSourceBuffer::removeCodedFrames(const MediaTime& start, const MediaTime& end, const MediaTime&)
{
    auto data = JSON::Object::create();
    data->setDouble("start"_s, start.toDouble());
    if (end.isPositiveInfinite())
        data->setValue("end"_s, JSON::Value::null());
    else
        data->setDouble("end"_s, end.toDouble());
    send("media.remove"_s, WTF::move(data));
    m_pending.append(MediaPromise::Producer { });
    return m_pending.last().promise();
}

void HostSourceBuffer::operationDone(const PlatformTimeRanges& buffered, bool failed)
{
    if (RefPtr client = this->client())
        client->sourceBufferPrivateBufferedChanged({ buffered });
    if (RefPtr source = m_mediaSource.get())
        source->trackBufferedChanged(*this, { buffered });
    if (m_pending.isEmpty())
        return;
    auto producer = m_pending.takeFirst();
    if (failed)
        producer.reject(PlatformMediaError::AppendError);
    else
        producer.resolve();
}

void HostSourceBuffer::abort()
{
    send("media.abort"_s);
}

void HostSourceBuffer::setMode(SourceBufferAppendMode mode)
{
    SourceBufferPrivate::setMode(mode);
    auto data = JSON::Object::create();
    data->setString("mode"_s, mode == SourceBufferAppendMode::Sequence ? "sequence"_s : "segments"_s);
    send("media.setMode"_s, WTF::move(data));
}

void HostSourceBuffer::setTimestampOffset(const MediaTime& offset)
{
    SourceBufferPrivate::setTimestampOffset(offset);
    auto data = JSON::Object::create();
    data->setDouble("offset"_s, offset.toDouble());
    send("media.setTimestampOffset"_s, WTF::move(data));
}

void HostSourceBuffer::setAppendWindowStart(const MediaTime& start)
{
    m_appendWindowStart = start;
    sendAppendWindow();
}

void HostSourceBuffer::setAppendWindowEnd(const MediaTime& end)
{
    m_appendWindowEnd = end;
    sendAppendWindow();
}

void HostSourceBuffer::sendAppendWindow()
{
    auto data = JSON::Object::create();
    data->setDouble("start"_s, m_appendWindowStart.toDouble());
    if (m_appendWindowEnd.isPositiveInfinite())
        data->setValue("end"_s, JSON::Value::null());
    else
        data->setDouble("end"_s, m_appendWindowEnd.toDouble());
    send("media.setAppendWindow"_s, WTF::move(data));
}

// The host's media element does its own seeking over its own buffers.
Ref<SourceBufferPrivate::ComputeSeekPromise> HostSourceBuffer::computeSeekTime(const SeekTarget& target)
{
    return ComputeSeekPromise::createAndResolve(target.time);
}

const Logger& HostSourceBuffer::sourceBufferLogger() const
{
    static NeverDestroyed<Ref<Logger>> logger = Logger::create(this);
    return logger.get();
}

} // namespace Inception::Media
