#pragma once

#include "MediaSourcePrivate.h"
#include "SourceBufferPrivate.h"
#include <wtf/Deque.h>

namespace Inception::Media {

class HostMediaPlayer;
class HostSourceBuffer;

// The engine side of a MediaSource mirrored in the host. WebCore's MSE
// front end (MediaSource, SourceBuffer) runs unchanged; the bytes and the
// buffered ranges are the host's.
class HostMediaSource final : public WebCore::MediaSourcePrivate {
public:
    static Ref<HostMediaSource> create(HostMediaPlayer& player, WebCore::MediaSourcePrivateClient& client) { return adoptRef(*new HostMediaSource(player, client)); }

    void detachPlayer() { m_player = nullptr; }
    HostMediaPlayer* hostPlayer() const { return m_player; }
    HostSourceBuffer* sourceBuffer(unsigned id) const;

private:
    HostMediaSource(HostMediaPlayer&, WebCore::MediaSourcePrivateClient&);

    RefPtr<WebCore::MediaPlayerPrivateInterface> player() const final;
    void setPlayer(WebCore::MediaPlayerPrivateInterface*) final { }
    constexpr WebCore::MediaPlatformType platformType() const final { return WebCore::MediaPlatformType::Mock; }
    AddStatus addSourceBuffer(const WebCore::ContentType&, const WebCore::MediaSourceConfiguration&, RefPtr<WebCore::SourceBufferPrivate>&) final;
    void removeSourceBuffer(WebCore::SourceBufferPrivate&) final;
    void notifyActiveSourceBuffersChanged() final { }
    void durationChanged(const MediaTime&) final;
    void markEndOfStream(EndOfStreamStatus) final;

    HostMediaPlayer* m_player;
    unsigned m_nextSourceBufferID { 1 };
};

class HostSourceBuffer final : public WebCore::SourceBufferPrivate {
public:
    static Ref<HostSourceBuffer> create(HostMediaSource& source, unsigned id) { return adoptRef(*new HostSourceBuffer(source, id)); }

    unsigned id() const { return m_id; }
    // The host finished the oldest pending append or removal.
    void operationDone(const WebCore::PlatformTimeRanges& buffered, bool failed);

private:
    HostSourceBuffer(HostMediaSource&, unsigned id);

    constexpr WebCore::MediaPlatformType platformType() const final { return WebCore::MediaPlatformType::Mock; }
    Ref<WebCore::MediaPromise> append(Ref<WebCore::SharedBuffer>&&) final;
    Ref<WebCore::MediaPromise> appendInternal(Ref<WebCore::SharedBuffer>&&) final;
    void resetParserStateInternal() final { }
    void abort() final;
    void setMode(WebCore::SourceBufferAppendMode) final;
    void setTimestampOffset(const MediaTime&) final;
    void setAppendWindowStart(const MediaTime&) final;
    void setAppendWindowEnd(const MediaTime&) final;
    Ref<WebCore::MediaPromise> removeCodedFrames(const MediaTime& start, const MediaTime& end, const MediaTime& currentTime) final;
    bool evictCodedFrames(uint64_t, const MediaTime&) final { return false; }
    void asyncEvictCodedFrames(uint64_t, const MediaTime&) final { }
    Ref<ComputeSeekPromise> computeSeekTime(const WebCore::SeekTarget&) final;
    void seekToTime(const MediaTime&) final { }

    const Logger& sourceBufferLogger() const final;
    uint64_t sourceBufferLogIdentifier() final { return 0; }

    void send(const String& event, Ref<JSON::Object>&& = JSON::Object::create());
    void sendAppendWindow();

    unsigned m_id;
    Deque<WebCore::MediaPromise::Producer> m_pending;
    MediaTime m_appendWindowStart { MediaTime::zeroTime() };
    MediaTime m_appendWindowEnd { MediaTime::positiveInfiniteTime() };
};

} // namespace Inception::Media
