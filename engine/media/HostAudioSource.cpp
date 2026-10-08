#include "config.h"
#include "media/HostAudioSource.h"

#if ENABLE(WEB_AUDIO)

#include "AudioBus.h"
#include "AudioChannel.h"

namespace Inception::Media {
using namespace WebCore;

HostAudioSource::HostAudioSource(Function<void(int, int, int, int)>&& capture)
    : m_samples(std::make_unique<float[]>(static_cast<size_t>(capacity) * maxChannels))
    , m_capture(WTF::move(capture))
{
}

void HostAudioSource::setClient(WeakPtr<AudioSourceProviderClient>&& client)
{
    m_client = WTF::move(client);
    if (!m_client || m_capturing)
        return;
    m_capturing = true;
    m_capture(reinterpret_cast<int>(&m_header[0]), reinterpret_cast<int>(m_samples.get()), capacity, maxChannels);
}

void HostAudioSource::setFormat(unsigned channels, float sampleRate)
{
    if (RefPtr client = m_client.get())
        client->setFormat(std::min(channels, maxChannels), sampleRate);
}

// Called on the audio rendering thread. Short of data, it plays silence
// rather than wait: the graph must keep its pace.
void HostAudioSource::provideInput(AudioBus& bus, size_t frames)
{
    int32_t written = m_header[0].load();
    int32_t read = m_header[1].load();
    if (static_cast<int32_t>(written - read) < static_cast<int32_t>(frames)) {
        bus.zero();
        return;
    }
    for (unsigned channel = 0; channel < bus.numberOfChannels(); ++channel) {
        auto destination = bus.channel(channel)->mutableSpan();
        const float* source = m_samples.get() + std::min(channel, maxChannels - 1) * static_cast<size_t>(capacity);
        for (size_t i = 0; i < frames && i < destination.size(); ++i)
            destination[i] = source[static_cast<uint32_t>(read + i) & (capacity - 1)];
    }
    m_header[1].store(read + static_cast<int32_t>(frames));
}

} // namespace Inception::Media

#endif // ENABLE(WEB_AUDIO)
