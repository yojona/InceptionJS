#pragma once

#include "IntSize.h"
#include <wtf/Function.h>
#include <wtf/Vector.h>

WTF_IGNORE_WARNINGS_IN_THIRD_PARTY_CODE_BEGIN
#include <skia/core/SkRefCnt.h>
WTF_IGNORE_WARNINGS_IN_THIRD_PARTY_CODE_END

class SkSurface;

namespace WebCore {
class GraphicsContext;
}

namespace Inception {

// Paints frames and hands them to the host. GPU first: Skia on the engine's
// WebGL2 context, presented as an ImageBitmap. When WebGL2 is unavailable (or
// disabled), Skia rasterizes on the CPU and the pixels are posted instead.
class Renderer {
public:
    enum class Mode : uint8_t { GPU, CPU };

    static Renderer& singleton();

    // `preferGPU` false forces the CPU path. Returns the mode in use.
    Mode initialize(WebCore::IntSize pixelSize, bool preferGPU);
    Mode mode() const { return m_mode; }

    void resize(WebCore::IntSize pixelSize);

    // Paints one frame: `paint` receives a context in device pixels with the
    // transparent clear already done.
    void paintFrame(const Function<void(WebCore::GraphicsContext&)>& paint);

private:
    bool initializeGPU();
    void paintGPU(const Function<void(WebCore::GraphicsContext&)>&);
    void paintCPU(const Function<void(WebCore::GraphicsContext&)>&);

    Mode m_mode { Mode::CPU };
    WebCore::IntSize m_size;
    Vector<uint8_t> m_pixels;
    sk_sp<SkSurface> m_surface;
};

} // namespace Inception
