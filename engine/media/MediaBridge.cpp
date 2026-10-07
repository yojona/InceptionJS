#include "config.h"
#include "media/MediaBridge.h"

#include "ContentType.h"
#include "MediaPlayer.h"
#include "bridge/Bridge.h"
#include "media/HostMediaPlayer.h"
#include "media/HostMediaSource.h"
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/text/StringHash.h>

namespace Inception::Media {
using namespace WebCore;

struct Capabilities {
    // container MIME type -> codec families the host decodes
    HashMap<String, HashSet<String>> progressive;
    HashMap<String, HashSet<String>> mediaSource;
};

static Capabilities& capabilities()
{
    static NeverDestroyed<Capabilities> value;
    return value;
}

unsigned nextPlayerID()
{
    static unsigned id;
    return ++id;
}

void setCapabilities(JSON::Object& media)
{
    auto& caps = capabilities();
    caps.progressive.clear();
    caps.mediaSource.clear();
    for (auto& [container, value] : media) {
        auto entry = value->asObject();
        if (!entry)
            continue;
        auto read = [&](ASCIILiteral key, HashMap<String, HashSet<String>>& into) {
            HashSet<String> families;
            if (auto list = entry->getArray(key)) {
                for (auto& family : *list)
                    families.add(family->asString());
            }
            into.set(container.convertToASCIILowercase(), WTF::move(families));
        };
        read("progressive"_s, caps.progressive);
        read("mse"_s, caps.mediaSource);
    }
}

// "vp09.00.10.08" and "vp9" are the same family; so are avc1/avc3 and
// hev1/hvc1.
static String codecFamily(const String& codec)
{
    auto family = codec.left(codec.find('.')).trim(isASCIIWhitespace<char16_t>).convertToASCIILowercase();
    if (family == "vp9"_s)
        return "vp09"_s;
    if (family == "avc3"_s)
        return "avc1"_s;
    if (family == "hvc1"_s)
        return "hev1"_s;
    if (family == "mp3"_s)
        return "mp3"_s;
    return family;
}

static MediaPlayer::SupportsType supports(const ContentType& type, bool mediaSource)
{
    auto& table = mediaSource ? capabilities().mediaSource : capabilities().progressive;
    auto container = type.containerType().convertToASCIILowercase();
    auto it = table.find(container);
    if (it == table.end() || it->value.isEmpty())
        return MediaPlayer::SupportsType::IsNotSupported;
    auto codecs = type.codecs();
    if (codecs.isEmpty())
        return MediaPlayer::SupportsType::MayBeSupported;
    for (auto& codec : codecs) {
        if (!it->value.contains(codecFamily(codec)))
            return MediaPlayer::SupportsType::IsNotSupported;
    }
    return MediaPlayer::SupportsType::IsSupported;
}

bool hostSupports(const ContentType& type, bool mediaSource)
{
    return supports(type, mediaSource) != MediaPlayer::SupportsType::IsNotSupported;
}

class HostMediaEngineFactory final : public MediaPlayerFactory {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(HostMediaEngineFactory);
    WTF_OVERRIDE_DELETE_FOR_CHECKED_PTR(HostMediaEngineFactory);
private:
    MediaPlayerEnums::MediaEngineIdentifier identifier() const final { return MediaPlayerEnums::MediaEngineIdentifier::HolePunch; }

    Ref<MediaPlayerPrivateInterface> createMediaEnginePlayer(MediaPlayer& player) const final
    {
        return HostMediaPlayer::create(player);
    }

    void getSupportedTypes(HashSet<String>& types) const final
    {
        for (auto& container : capabilities().progressive.keys())
            types.add(container);
        for (auto& container : capabilities().mediaSource.keys())
            types.add(container);
    }

    MediaPlayer::SupportsType supportsTypeAndCodecs(const MediaEngineSupportParameters& parameters) const final
    {
        return supports(parameters.type, parameters.isMediaSource);
    }
};

static void registerEngines(MediaEngineRegistrar registrar)
{
    registrar(makeUnique<HostMediaEngineFactory>());
}

void endFrame()
{
    // Players painted this frame report their box; the rest are hidden.
    HostMediaPlayer::forEach([](HostMediaPlayer& player) {
        player.reportLayoutIfChanged(player.takePaintedRect());
    });
}

void install()
{
    EmbedderMediaPlayerSupport::setRegisterMediaEngines(registerEngines);

    // {id, currentTime, duration, paused, ended, seeking, readyState, ...}
    registerCommand("media.state"_s, [](JSON::Object& args) {
        if (auto* player = HostMediaPlayer::fromID(args.getInteger("id"_s).value_or(0)))
            player->update(args);
    });

    // {id, sb, buffered: [[start, end], ...], error}
    registerCommand("media.bufferDone"_s, [](JSON::Object& args) {
        auto* player = HostMediaPlayer::fromID(args.getInteger("id"_s).value_or(0));
        if (!player)
            return;
        auto* source = player->mediaSource();
        auto* buffer = source ? source->sourceBuffer(args.getInteger("sb"_s).value_or(0)) : nullptr;
        if (!buffer)
            return;
        PlatformTimeRanges buffered;
        if (auto ranges = args.getArray("buffered"_s)) {
            for (auto& range : *ranges) {
                auto pair = range->asArray();
                if (pair && pair->length() == 2)
                    buffered.add(MediaTime::createWithDouble(pair->get(0)->asDouble().value_or(0)), MediaTime::createWithDouble(pair->get(1)->asDouble().value_or(0)));
            }
        }
        auto error = args.getValue("error"_s);
        buffer->operationDone(buffered, error && error->type() == JSON::Value::Type::String);
    });
}

} // namespace Inception::Media
