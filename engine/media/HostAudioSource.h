#pragma once

#if ENABLE(WEB_AUDIO)

#include "AudioSourceProvider.h"
#include "AudioSourceProviderClient.h"
#include <atomic>
#include <memory>
#include <wtf/Function.h>
#include <wtf/WeakPtr.h>

namespace Inception::Media {

// The audio of a host media element, for Web Audio in the page
// (createMediaElementSource). Once a page asks, the host routes the element's
// sound through an AudioWorklet that writes it into a ring of planar float
// samples in the engine's shared memory, instead of the speakers; the page's
// audio graph pulls it from here.
class HostAudioSource final : public WebCore::AudioSourceProvider {
public:
    // `capture(header, samples, capacity, channels)` asks the host to start.
    explicit HostAudioSource(Function<void(int, int, int, int)>&& capture);

    void provideInput(WebCore::AudioBus&, size_t framesToProcess) final;
    void setClient(WeakPtr<WebCore::AudioSourceProviderClient>&&) final;

    // The host's capture runs at its own context's rate.
    void setFormat(unsigned channels, float sampleRate);

    static constexpr int32_t capacity = 8192;
    static constexpr unsigned maxChannels = 2;

private:
    // [0] frames written by the host, [1] frames read here.
    alignas(16) std::atomic<int32_t> m_header[2] { };
    std::unique_ptr<float[]> m_samples;
    WeakPtr<WebCore::AudioSourceProviderClient> m_client;
    Function<void(int, int, int, int)> m_capture;
    bool m_capturing { false };
};

} // namespace Inception::Media

#endif // ENABLE(WEB_AUDIO)
