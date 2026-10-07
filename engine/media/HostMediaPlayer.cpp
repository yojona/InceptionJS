#include "config.h"
#include "media/HostMediaPlayer.h"

#include "DestinationColorSpace.h"
#include "GraphicsContext.h"
#include "MediaPlayer.h"
#include "MediaSourcePrivateClient.h"
#include "bridge/Bridge.h"
#include "media/HostMediaSource.h"
#include "media/MediaBridge.h"
#include "view/View.h"
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/text/MakeString.h>

namespace Inception::Media {
using namespace WebCore;

WTF_MAKE_TZONE_ALLOCATED_IMPL(HostMediaPlayer);

static HashMap<unsigned, HostMediaPlayer*>& players()
{
    static NeverDestroyed<HashMap<unsigned, HostMediaPlayer*>> map;
    return map;
}

HostMediaPlayer* HostMediaPlayer::fromID(unsigned id)
{
    return players().get(id);
}

void HostMediaPlayer::forEach(const Function<void(HostMediaPlayer&)>& function)
{
    for (auto* player : copyToVector(players().values()))
        function(*player);
}

HostMediaPlayer::HostMediaPlayer(MediaPlayer& player)
    : m_player(player)
    , m_id(nextPlayerID())
{
    players().add(m_id, this);
    sendToHost("media.create"_s);
}

HostMediaPlayer::~HostMediaPlayer()
{
    players().remove(m_id);
    if (m_mediaSource)
        m_mediaSource->detachPlayer();
    sendToHost("media.destroy"_s);
}

void HostMediaPlayer::sendToHost(const String& event, Ref<JSON::Object>&& data)
{
    data->setInteger("id"_s, m_id);
    emitEvent(event, WTF::move(data));
}

void HostMediaPlayer::load(const String& url)
{
    m_networkState = MediaPlayer::NetworkState::Loading;
    if (RefPtr player = m_player.get())
        player->networkStateChanged();
    auto data = JSON::Object::create();
    data->setString("url"_s, url);
    sendToHost("media.load"_s, WTF::move(data));
}

void HostMediaPlayer::load(const URL&, const LoadOptions&, MediaSourcePrivateClient& client)
{
    m_isMediaSource = true;
    m_mediaSource = HostMediaSource::create(*this, client);
    sendToHost("media.attachSource"_s);
    client.setPrivateAndOpen(*m_mediaSource);
    m_networkState = MediaPlayer::NetworkState::Loading;
    if (RefPtr player = m_player.get())
        player->networkStateChanged();
}

void HostMediaPlayer::cancelLoad()
{
    sendToHost("media.pause"_s);
}

void HostMediaPlayer::play()
{
    report("debug"_s, makeString("media "_s, m_id, " play"_s));
    m_paused = false;
    sendToHost("media.play"_s);
    if (RefPtr player = m_player.get())
        player->playbackStateChanged();
}

void HostMediaPlayer::pause()
{
    report("debug"_s, makeString("media "_s, m_id, " pause"_s));
    m_currentTime = currentTime().toDouble();
    m_currentTimeUpdatedAt = MonotonicTime::now();
    m_paused = true;
    sendToHost("media.pause"_s);
    if (RefPtr player = m_player.get())
        player->playbackStateChanged();
}

void HostMediaPlayer::seekToTarget(const SeekTarget& target)
{
    report("debug"_s, makeString("media "_s, m_id, " seek "_s, target.time.toDouble()));
    m_seeking = true;
    m_currentTime = target.time.toDouble();
    m_currentTimeUpdatedAt = MonotonicTime::now();
    auto data = JSON::Object::create();
    data->setDouble("time"_s, m_currentTime);
    sendToHost("media.seek"_s, WTF::move(data));
    if (RefPtr player = m_player.get())
        player->timeChanged();
}

MediaTime HostMediaPlayer::duration() const
{
    if (m_isMediaSource && m_mediaSource) {
        auto duration = m_mediaSource->duration();
        if (duration.isValid())
            return duration;
    }
    if (std::isnan(m_duration))
        return MediaTime::invalidTime();
    if (m_duration < 0)
        return MediaTime::positiveInfiniteTime();
    return MediaTime::createWithDouble(m_duration);
}

// Between host reports, playing media advances with the clock, so script
// reading currentTime sees smooth progress.
MediaTime HostMediaPlayer::currentTime() const
{
    double time = m_currentTime;
    if (!m_paused && !m_seeking && m_readyState >= MediaPlayer::ReadyState::HaveFutureData && !m_ended)
        time += (MonotonicTime::now() - m_currentTimeUpdatedAt).seconds() * m_rate;
    if (!std::isnan(m_duration) && m_duration >= 0)
        time = std::min(time, m_duration);
    return MediaTime::createWithDouble(time);
}

void HostMediaPlayer::setRateDouble(double rate)
{
    m_rate = rate;
    auto data = JSON::Object::create();
    data->setDouble("rate"_s, rate);
    sendToHost("media.rate"_s, WTF::move(data));
}

void HostMediaPlayer::setVolumeDouble(double volume)
{
    auto data = JSON::Object::create();
    data->setDouble("volume"_s, volume);
    sendToHost("media.volume"_s, WTF::move(data));
}

void HostMediaPlayer::setMuted(bool muted)
{
    m_muted = muted;
    auto data = JSON::Object::create();
    data->setBoolean("muted"_s, muted);
    sendToHost("media.muted"_s, WTF::move(data));
}

bool HostMediaPlayer::didLoadingProgress() const
{
    auto end = m_buffered.length() ? m_buffered.maximumBufferedTime() : MediaTime::zeroTime();
    bool progressed = end != m_lastReportedBufferedEnd;
    m_lastReportedBufferedEnd = end;
    return progressed;
}

// The video itself is the host's <video>, under the view's canvas: painting
// clears the box so it shows through, and records where the box is.
void HostMediaPlayer::paint(GraphicsContext& context, const FloatRect& rect)
{
    if (context.paintingDisabled() || rect.isEmpty())
        return;
    context.clearRect(rect);
    float scale = View::singleton() ? View::singleton()->deviceScaleFactor() : 1;
    auto deviceRect = context.getCTM().mapRect(rect);
    deviceRect.scale(1 / scale);
    m_paintedRect = deviceRect;
}

std::optional<VideoPlaybackQualityMetrics> HostMediaPlayer::videoPlaybackQualityMetrics()
{
    VideoPlaybackQualityMetrics metrics;
    metrics.totalVideoFrames = m_totalFrames;
    metrics.droppedVideoFrames = m_droppedFrames;
    metrics.displayCompositedVideoFrames = m_totalFrames - std::min(m_droppedFrames, m_totalFrames);
    return metrics;
}

DestinationColorSpace HostMediaPlayer::colorSpace()
{
    return DestinationColorSpace::SRGB();
}

std::optional<FloatRect> HostMediaPlayer::takePaintedRect()
{
    return std::exchange(m_paintedRect, std::nullopt);
}

void HostMediaPlayer::reportLayoutIfChanged(std::optional<FloatRect> rect)
{
    if (m_layoutReported && rect == m_reportedRect)
        return;
    m_layoutReported = true;
    m_reportedRect = rect;
    auto data = JSON::Object::create();
    if (rect) {
        auto box = JSON::Object::create();
        box->setDouble("x"_s, rect->x());
        box->setDouble("y"_s, rect->y());
        box->setDouble("width"_s, rect->width());
        box->setDouble("height"_s, rect->height());
        data->setObject("rect"_s, WTF::move(box));
    } else
        data->setValue("rect"_s, JSON::Value::null());
    sendToHost("media.layout"_s, WTF::move(data));
}

static MediaPlayer::ReadyState readyStateFrom(int value)
{
    switch (value) {
    case 1:
        return MediaPlayer::ReadyState::HaveMetadata;
    case 2:
        return MediaPlayer::ReadyState::HaveCurrentData;
    case 3:
        return MediaPlayer::ReadyState::HaveFutureData;
    case 4:
        return MediaPlayer::ReadyState::HaveEnoughData;
    default:
        return MediaPlayer::ReadyState::HaveNothing;
    }
}

static MediaPlayer::NetworkState networkStateFrom(int value, int error)
{
    switch (error) {
    case 2:
        return MediaPlayer::NetworkState::NetworkError;
    case 3:
        return MediaPlayer::NetworkState::DecodeError;
    case 4:
        return MediaPlayer::NetworkState::FormatError;
    default:
        break;
    }
    switch (value) {
    case 1:
        return MediaPlayer::NetworkState::Idle;
    case 2:
        return MediaPlayer::NetworkState::Loading;
    case 3:
        return MediaPlayer::NetworkState::Empty;
    default:
        return MediaPlayer::NetworkState::Empty;
    }
}

// A state report from the host's <video> (host/media.js).
void HostMediaPlayer::update(JSON::Object& state)
{
    RefPtr player = m_player.get();
    if (!player)
        return;

    bool wasSeeking = m_seeking;
    bool hostSeeking = state.getBoolean("seeking"_s).value_or(false);
    if (!hostSeeking) {
        m_currentTime = state.getDouble("currentTime"_s).value_or(m_currentTime);
        m_currentTimeUpdatedAt = MonotonicTime::now();
    }

    auto durationValue = state.getValue("duration"_s);
    double duration = std::numeric_limits<double>::quiet_NaN();
    if (durationValue && durationValue->type() == JSON::Value::Type::Double)
        duration = durationValue->asDouble().value_or(duration);
    else if (durationValue && durationValue->type() == JSON::Value::Type::Integer)
        duration = durationValue->asInteger().value_or(0);
    bool durationChanged = !(std::isnan(duration) && std::isnan(m_duration)) && duration != m_duration;
    m_duration = duration;

    FloatSize naturalSize(state.getInteger("width"_s).value_or(0), state.getInteger("height"_s).value_or(0));
    bool sizeChanged = naturalSize != m_naturalSize;
    m_naturalSize = naturalSize;

    PlatformTimeRanges buffered;
    if (auto ranges = state.getArray("buffered"_s)) {
        for (auto& range : *ranges) {
            auto pair = range->asArray();
            if (!pair || pair->length() != 2)
                continue;
            buffered.add(MediaTime::createWithDouble(pair->get(0)->asDouble().value_or(0)), MediaTime::createWithDouble(pair->get(1)->asDouble().value_or(0)));
        }
    }
    m_buffered = WTF::move(buffered);

    m_totalFrames = state.getInteger("totalFrames"_s).value_or(m_totalFrames);
    m_droppedFrames = state.getInteger("droppedFrames"_s).value_or(m_droppedFrames);

    bool paused = state.getBoolean("paused"_s).value_or(true);
    bool ended = state.getBoolean("ended"_s).value_or(false);
    double rate = state.getDouble("rate"_s).value_or(m_rate);
    auto readyState = readyStateFrom(state.getInteger("readyState"_s).value_or(0));
    auto networkState = networkStateFrom(state.getInteger("networkState"_s).value_or(0), state.getInteger("error"_s).value_or(0));
    // The page, not the host element, fetches Media Source data, and a stream
    // the host element keeps open would read as stalled; once data can play,
    // the engine's element is idle, as browsers report MSE elements.
    if (networkState == MediaPlayer::NetworkState::Loading && (m_isMediaSource ? readyState >= MediaPlayer::ReadyState::HaveMetadata : readyState == MediaPlayer::ReadyState::HaveEnoughData))
        networkState = MediaPlayer::NetworkState::Idle;

    if (sizeChanged)
        player->sizeChanged();
    if (durationChanged)
        player->durationChanged();
    if (networkState != m_networkState || readyState != m_readyState)
        report("debug"_s, makeString("media "_s, m_id, " network "_s, static_cast<int>(networkState), " ready "_s, static_cast<int>(readyState)));
    if (networkState != m_networkState) {
        m_networkState = networkState;
        player->networkStateChanged();
    }
    if (readyState != m_readyState) {
        m_readyState = readyState;
        player->readyStateChanged();
    }
    if (wasSeeking && !hostSeeking) {
        m_seeking = false;
        player->seeked(MediaTime::createWithDouble(m_currentTime));
        player->timeChanged();
    }
    // Playback state follows the host's playing and pause events, as the
    // element's own events would; play() and pause() flip it optimistically.
    bool sawPlaying = false;
    bool sawPause = false;
    if (auto reasons = state.getArray("reasons"_s)) {
        for (auto& reason : *reasons) {
            auto name = reason->asString();
            sawPlaying |= name == "playing"_s;
            sawPause |= name == "pause"_s;
        }
    }
    if (sawPlaying && !paused && m_paused) {
        m_paused = false;
        player->playbackStateChanged();
    } else if ((sawPause || ended) && !m_paused && paused) {
        m_paused = true;
        player->playbackStateChanged();
    }
    if (auto muted = state.getBoolean("muted"_s); muted && *muted != m_muted) {
        m_muted = *muted;
        player->muteChanged(m_muted);
    }
    if (rate != m_rate) {
        m_rate = rate;
        player->rateChanged();
    }
    if (ended != m_ended) {
        m_ended = ended;
        player->timeChanged();
    }
}

} // namespace Inception::Media
