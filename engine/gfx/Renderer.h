#pragma once

#include "IntSize.h"
#include <wtf/Function.h>
#include <wtf/HashMap.h>
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
//
// There is one context and one canvas for every window (a worker holds few
// WebGL contexts). Each window paints into a render target of its own; the
// canvas takes that window's size when its frame is presented, and every
// presented frame is a full copy of the window's target.
class Renderer {
public:
    enum class Mode : uint8_t { GPU, CPU };

    static Renderer& singleton();

    // `preferGPU` false forces the CPU path. `pageContexts` caps the WebGL
    // contexts pages may hold (0: derived from the host's renderer). Returns the
    // mode in use.
    Mode initialize(WebCore::IntSize pixelSize, bool preferGPU, int pageContexts = 0);
    Mode mode() const { return m_mode; }

    // Paints one frame of `window` at `pixelSize` and presents it: `paint`
    // receives a context in device pixels with the transparent clear done.
    void paintFrame(unsigned window, WebCore::IntSize pixelSize, const Function<void(WebCore::GraphicsContext&)>& paint);

    // Frees what a closed window painted into.
    void releaseSurface(unsigned window);

private:
    struct Surface {
        sk_sp<SkSurface> target;
        Vector<uint8_t> pixels;
    };

    bool initializeGPU(WebCore::IntSize);
    void rebuildGPU();
    void paintGPU(unsigned window, Surface&, WebCore::IntSize, const Function<void(WebCore::GraphicsContext&)>&);
    void paintCPU(unsigned window, Surface&, WebCore::IntSize, const Function<void(WebCore::GraphicsContext&)>&);

    Mode m_mode { Mode::CPU };
    int m_requestedPageContexts { 0 };
    HashMap<unsigned, std::unique_ptr<Surface>> m_surfaces;
};

} // namespace Inception
