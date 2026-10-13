#pragma once

#include "FloatRect.h"
#include "MediaPlayerPrivate.h"
#include "media/HostAudioSource.h"
#include "PlatformTimeRanges.h"
#include "VideoPlaybackQualityMetrics.h"
#include <wtf/RefCounted.h>

namespace Inception::Media {

class HostMediaSource;

// WebCore's view of one host <video>. Commands go to the host; the host's
// state reports come back through update() and drive the page's element.
class HostMediaPlayer final : public WebCore::MediaPlayerPrivateInterface, public RefCounted<HostMediaPlayer> {
    WTF_MAKE_TZONE_ALLOCATED(HostMediaPlayer);
public:
    static Ref<HostMediaPlayer> create(WebCore::MediaPlayer& player) { return adoptRef(*new HostMediaPlayer(player)); }
    ~HostMediaPlayer();

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    static HostMediaPlayer* fromID(unsigned);
    static void forEach(const Function<void(HostMediaPlayer&)>&);
    HostMediaSource* mediaSource() const { return m_mediaSource.get(); }
    unsigned id() const { return m_id; }
    // The window of the element's page, fixed at creation.
    unsigned window() const { return m_window; }

    void update(JSON::Object& state);
    // The host <video> met encrypted media: {initDataType, initData}.
    void encrypted(JSON::Object&);
    // The host's CDM made a key usable for this element's media.
    void keysUsable();
#if ENABLE(WEB_AUDIO)
    // The host started capturing the element's audio for the page's graph.
    void audioCaptureFormat(unsigned channels, float sampleRate);
    WebCore::AudioSourceProvider* audioSourceProvider() final;
#endif
    void sendToHost(const String& event, Ref<JSON::Object>&& data = JSON::Object::create());

    // Where the page painted the video during the frame, in CSS pixels of the
    // view; nullopt when it was not painted.
    std::optional<WebCore::FloatRect> takePaintedRect();
    void reportLayoutIfChanged(std::optional<WebCore::FloatRect>);

private:
    explicit HostMediaPlayer(WebCore::MediaPlayer&);

    constexpr WebCore::MediaPlayerType mediaPlayerType() const final { return WebCore::MediaPlayerType::HolePunch; }

    void load(const String& url) final;
    void load(const URL&, const LoadOptions&, WebCore::MediaSourcePrivateClient&) final;
    void cancelLoad() final;

    void prepareToPlay() final { }
    void play() final;
    void pause() final;

    WebCore::FloatSize naturalSize() const final { return m_naturalSize; }
    bool hasVideo() const final { return !m_naturalSize.isEmpty() || m_isMediaSource; }
    bool hasAudio() const final { return m_readyState >= WebCore::MediaPlayer::ReadyState::HaveMetadata; }
    void setPageIsVisible(bool) final { }

    void seekToTarget(const WebCore::SeekTarget&) final;
    bool seeking() const final { return m_seeking; }
    bool paused() const final { return m_paused; }

    MediaTime duration() const final;
    MediaTime currentTime() const final;
    MediaTime maxTimeSeekable() const final { return duration(); }
    void setRate(float rate) final { setRateDouble(rate); }
    void setRateDouble(double) final;
    double rate() const final { return m_paused ? 0 : m_rate; }
    void setVolume(float volume) final { setVolumeDouble(volume); }
    void setVolumeDouble(double) final;
    void setMuted(bool) final;

    WebCore::MediaPlayer::NetworkState networkState() const final { return m_networkState; }
    WebCore::MediaPlayer::ReadyState readyState() const final { return m_readyState; }
    const WebCore::PlatformTimeRanges& buffered() const final { return m_buffered; }
    bool didLoadingProgress() const final;

    void paint(WebCore::GraphicsContext&, const WebCore::FloatRect&) final;
    unsigned decodedFrameCount() const final { return m_totalFrames; }
    unsigned droppedFrameCount() const final { return m_droppedFrames; }
    std::optional<WebCore::VideoPlaybackQualityMetrics> videoPlaybackQualityMetrics() final;
    WebCore::DestinationColorSpace colorSpace() final;

#if ENABLE(ENCRYPTED_MEDIA)
    void cdmInstanceAttached(WebCore::CDMInstance&) final;
    void cdmInstanceDetached(WebCore::CDMInstance&) final;
    bool waitingForKey() const final { return m_waitingForKey; }
#endif

    ThreadSafeWeakPtr<WebCore::MediaPlayer> m_player;
    unsigned m_id;
    unsigned m_window { 1 };
    // The engine's fetch of a plain src, which the host plays (0: none).
    uint64_t m_sourceFetch { 0 };
#if ENABLE(WEB_AUDIO)
    std::unique_ptr<HostAudioSource> m_audioSource;
#endif
    void stopSourceFetch();
    RefPtr<HostMediaSource> m_mediaSource;
    bool m_isMediaSource { false };

    WebCore::MediaPlayer::NetworkState m_networkState { WebCore::MediaPlayer::NetworkState::Empty };
    WebCore::MediaPlayer::ReadyState m_readyState { WebCore::MediaPlayer::ReadyState::HaveNothing };
    WebCore::FloatSize m_naturalSize;
    WebCore::PlatformTimeRanges m_buffered;
    mutable MediaTime m_lastReportedBufferedEnd;
    double m_duration { std::numeric_limits<double>::quiet_NaN() };
    double m_currentTime { 0 };
    MonotonicTime m_currentTimeUpdatedAt;
    double m_rate { 1 };
    bool m_paused { true };
    bool m_seeking { false };
    bool m_ended { false };
    bool m_muted { false };
    bool m_waitingForKey { false };
    unsigned m_totalFrames { 0 };
    unsigned m_droppedFrames { 0 };

    std::optional<WebCore::FloatRect> m_paintedRect;
    std::optional<WebCore::FloatRect> m_reportedRect;
    bool m_layoutReported { false };
};

} // namespace Inception::Media
