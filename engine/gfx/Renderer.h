#pragma once

#include "IntRect.h"
#include "IntSize.h"
#include <optional>
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

    // Paints one frame of `window` at `pixelSize` and presents it. `damage`
    // (rects in device pixels) limits the paint to what changed since the last frame,
    // which the window's target still holds; empty presents it unchanged, and
    // none repaints everything. A new or resized target is always repainted
    // whole. `paint` is called once per rect, with a context in device pixels
    // clipped to it and the transparent clear done there.
    // `scroll` first moves the pixels of a rect by an offset (a page that
    // scrolled), so that `damage` need only hold what scrolled in; where they
    // cannot be moved, everything is repainted.
    using PaintFunction = Function<void(WebCore::GraphicsContext&, const WebCore::IntRect& region)>;
    struct Scroll {
        WebCore::IntRect rect;
        WebCore::IntSize offset;
    };
    using Damage = Vector<WebCore::IntRect>;
    // Told to the host with the frame: the page's scroll position when it was
    // painted, and the CSS pixels painted beyond the viewport above and below.
    struct FrameInfo {
        int scrollX { 0 };
        int scrollY { 0 };
        int overscan { 0 };
    };
    void paintFrame(unsigned window, WebCore::IntSize pixelSize, std::optional<Damage>, std::optional<Scroll>, const FrameInfo&, const PaintFunction& paint);

    // Frees what a closed or hidden window painted into.
    void releaseSurface(unsigned window);
    unsigned surfaceCount() const { return m_surfaces.size(); }

private:
    struct Surface {
        sk_sp<SkSurface> target;
        Vector<uint8_t> pixels;
        // What `pixels` hold a frame of; another size repaints whole.
        WebCore::IntSize pixelsSize;
    };

    bool initializeGPU(WebCore::IntSize);
    void rebuildGPU();
    void paintGPU(unsigned window, Surface&, WebCore::IntSize, std::optional<Damage>, std::optional<Scroll>, const FrameInfo&, const PaintFunction&);
    void paintCPU(unsigned window, Surface&, WebCore::IntSize, std::optional<Damage>, std::optional<Scroll>, const FrameInfo&, const PaintFunction&);

    Mode m_mode { Mode::CPU };
    int m_requestedPageContexts { 0 };
    HashMap<unsigned, std::unique_ptr<Surface>> m_surfaces;
};

} // namespace Inception
