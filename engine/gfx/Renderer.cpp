#include "config.h"
#include "gfx/Renderer.h"

#include "FontRenderOptions.h"
#include "GLContext.h"
#include "GraphicsContextSkia.h"
#include "PlatformDisplay.h"
#include "PlatformDisplayEmscripten.h"
#include "WebGLContextEmscripten.h"
#include "bridge/Bridge.h"
#include <GLES3/gl3.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

WTF_IGNORE_WARNINGS_IN_THIRD_PARTY_CODE_BEGIN
#include <skia/core/SkCanvas.h>
#include <skia/core/SkColorSpace.h>
#include <skia/core/SkImage.h>
#include <skia/core/SkPaint.h>
#include <skia/core/SkSurface.h>
#include <skia/gpu/ganesh/GrBackendSurface.h>
#include <skia/gpu/ganesh/GrDirectContext.h>
#include <skia/gpu/ganesh/SkSurfaceGanesh.h>
#include <skia/gpu/ganesh/gl/GrGLBackendSurface.h>
WTF_IGNORE_WARNINGS_IN_THIRD_PARTY_CODE_END

extern "C" {
int inception_gfx_create_context(int width, int height, int requestedPageContexts);
int inception_gfx_take_context_state();
void inception_gfx_resize(int width, int height);
void inception_gfx_present(unsigned window, int scrollX, int scrollY, int overscan);
void inception_gfx_present_pixels(unsigned window, const uint8_t*, int width, int height, int scrollX, int scrollY, int overscan);
}

namespace Inception {
using namespace WebCore;

Renderer& Renderer::singleton()
{
    static NeverDestroyed<Renderer> renderer;
    return renderer;
}

Renderer::Mode Renderer::initialize(IntSize pixelSize, bool preferGPU, int pageContexts)
{
    m_requestedPageContexts = pageContexts;
    m_mode = preferGPU && initializeGPU(pixelSize) ? Mode::GPU : Mode::CPU;
    return m_mode;
}

bool Renderer::initializeGPU(IntSize pixelSize)
{
    auto handle = inception_gfx_create_context(pixelSize.width(), pixelSize.height(), m_requestedPageContexts);
    if (!handle)
        return false;
    setSharedWebGLContext(handle);
    if (emscripten_webgl_make_context_current(handle) != EMSCRIPTEN_RESULT_SUCCESS) {
        report("warn"_s, "could not make the WebGL2 context current"_s);
        return false;
    }

    if (!PlatformDisplay::sharedDisplayIfExists()) {
        auto display = PlatformDisplayEmscripten::create();
        if (!display)
            return false;
        PlatformDisplay::setSharedDisplay(WTF::move(display));
    }
    auto& display = PlatformDisplay::sharedDisplay();
    if (!display.skiaGLContext() || !display.skiaGrContext()) {
        report("warn"_s, makeString("Skia could not use WebGL2 ("_s, String::fromLatin1(reinterpret_cast<const char*>(glGetString(GL_VERSION))), "); painting on the CPU"_s));
        return false;
    }
    return true;
}

// Moves the pixels of `scroll.rect` by its offset, within the rect: a copy of
// the region drawn back over it. False when the copy cannot be made.
static bool shiftPixels(SkSurface& surface, const Renderer::Scroll& scroll)
{
    auto& rect = scroll.rect;
    auto image = surface.makeImageSnapshot(SkIRect::MakeXYWH(rect.x(), rect.y(), rect.width(), rect.height()));
    if (!image)
        return false;
    auto* canvas = surface.getCanvas();
    SkAutoCanvasRestore restoreCanvas(canvas, true);
    canvas->clipIRect(SkIRect::MakeXYWH(rect.x(), rect.y(), rect.width(), rect.height()));
    SkPaint paint;
    paint.setBlendMode(SkBlendMode::kSrc);
    canvas->drawImage(image, rect.x() + scroll.offset.width(), rect.y() + scroll.offset.height(), SkSamplingOptions(), &paint);
    return true;
}

// Clears and paints the damaged rects of `canvas` only; the rest keeps the
// last frame. No damage paints all of it.
static void paintRegion(SkCanvas& canvas, RenderingMode mode, IntSize size, const std::optional<Renderer::Damage>& damage, const Renderer::PaintFunction& paint)
{
    auto paintRect = [&](const IntRect& region) {
        if (region.isEmpty())
            return;
        SkAutoCanvasRestore restoreCanvas(&canvas, true);
        canvas.clipIRect(SkIRect::MakeXYWH(region.x(), region.y(), region.width(), region.height()));
        canvas.clear(SK_ColorTRANSPARENT);
        GraphicsContextSkia context(canvas, mode, RenderingPurpose::Unspecified);
        paint(context, region);
    };
    if (!damage) {
        paintRect(IntRect({ }, size));
        return;
    }
    for (auto& rect : *damage)
        paintRect(rect);
}

void Renderer::paintFrame(unsigned window, IntSize pixelSize, std::optional<Damage> damage, std::optional<Scroll> scroll, const FrameInfo& info, const PaintFunction& paint)
{
    if (pixelSize.isEmpty())
        return;
    auto& surface = *m_surfaces.ensure(static_cast<unsigned>(window), [] { return std::make_unique<Surface>(); }).iterator->value;
    if (m_mode == Mode::GPU)
        paintGPU(window, surface, pixelSize, damage, scroll, info, paint);
    else
        paintCPU(window, surface, pixelSize, damage, scroll, info, paint);
}

void Renderer::releaseSurface(unsigned window)
{
    m_surfaces.remove(window);
}

// The WebGL context came back after a loss: every GL object Skia held is gone.
// Skia's context is abandoned (WebCore's buffers that still reference it stop
// drawing instead of touching dead objects) and a fresh one is built on the same
// WebGL context.
void Renderer::rebuildGPU()
{
    auto& display = PlatformDisplay::sharedDisplay();
    if (display.skiaGLContext()) {
        if (auto* grContext = display.skiaGrContext())
            grContext->abandonContext();
    }
    // Every window's target belonged to the lost context; each is made again
    // at its next frame (the caller marks every window as needing paint).
    for (auto& surface : m_surfaces.values())
        surface->target = nullptr;
    display.clearGLContexts();
    if (!display.skiaGLContext() || !display.skiaGrContext())
        report("error"_s, "Skia could not use the restored WebGL context"_s);
}

void Renderer::paintGPU(unsigned window, Surface& windowSurface, IntSize size, std::optional<Damage> damage, std::optional<Scroll> scroll, const FrameInfo& frame, const PaintFunction& paint)
{
    switch (inception_gfx_take_context_state()) {
    case 1:
        return;
    case 2:
        rebuildGPU();
        break;
    }
    auto& display = PlatformDisplay::sharedDisplay();
    if (!display.skiaGLContext()->makeContextCurrent())
        return;
    auto* grContext = display.skiaGrContext();

    // Skia paints into a render target of its own, which is then blitted to the
    // canvas's default framebuffer: Skia will not wrap WebGL's default
    // framebuffer directly. Bottom-left origin, like the canvas, so the blit
    // needs no flip.
    auto& renderTarget = windowSurface.target;
    if (!renderTarget || renderTarget->width() != size.width() || renderTarget->height() != size.height()) {
        damage = std::nullopt;
        auto info = SkImageInfo::Make(size.width(), size.height(), kRGBA_8888_SkColorType, kPremul_SkAlphaType, SkColorSpace::MakeSRGB());
        auto properties = FontRenderOptions::singleton().createSurfaceProps();
        renderTarget = SkSurfaces::RenderTarget(grContext, skgpu::Budgeted::kNo, info, 0, kBottomLeft_GrSurfaceOrigin, &properties);
        if (!renderTarget) {
            report("error"_s, makeString("Skia could not create a "_s, size.width(), 'x', size.height(), " render target (RGBA8 surface "_s,
                grContext->colorTypeSupportedAsSurface(kRGBA_8888_SkColorType) ? "supported"_s : "unsupported"_s, ", max target "_s, grContext->maxRenderTargetSize(),
                ", max texture "_s, grContext->maxTextureSize(), ", abandoned "_s, grContext->abandoned() ? "yes"_s : "no"_s,
                ", renderable format "_s, grContext->defaultBackendFormat(kRGBA_8888_SkColorType, GrRenderable::kYes).isValid() ? "yes"_s : "no"_s,
                ", texture format "_s, grContext->defaultBackendFormat(kRGBA_8888_SkColorType, GrRenderable::kNo).isValid() ? "yes"_s : "no"_s,
                ", as image "_s, grContext->colorTypeSupportedAsImage(kRGBA_8888_SkColorType) ? "yes"_s : "no"_s,
                ", max samples "_s, grContext->maxSurfaceSampleCountForColorType(kRGBA_8888_SkColorType),
                ", GL "_s, String::fromLatin1(reinterpret_cast<const char*>(glGetString(GL_VERSION))), ')'));
            return;
        }
    }
    auto* surface = renderTarget.get();

    if (damage && scroll && !shiftPixels(*surface, *scroll))
        damage = std::nullopt;
    // The surface, and so its canvas and matrix, lives across frames: each
    // frame's transforms and clip end with it (paintRegion restores them).
    paintRegion(*surface->getCanvas(), RenderingMode::Accelerated, size, damage, paint);
    // Painting a WebGL canvas reads its pixels in that page context's own
    // host context; Skia's must be current again for the flush.
    if (!display.skiaGLContext()->makeContextCurrent())
        return;
    grContext->flushAndSubmit(surface, GrSyncCpu::kNo);

    GrBackendRenderTarget target = SkSurfaces::GetBackendRenderTarget(surface, SkSurfaces::BackendHandleAccess::kFlushRead);
    GrGLFramebufferInfo framebuffer;
    if (!GrBackendRenderTargets::GetGLFramebufferInfo(target, &framebuffer))
        return;
    // The canvas is shared by every window: it takes this one's size first.
    // Presenting resets it, so nothing of another window's frame remains.
    inception_gfx_resize(size.width(), size.height());
    glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffer.fFBOID);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
    // WebKit hands out a blank bitmap for a drawing buffer that only a blit
    // wrote since the last one: clearing one pixel, which the blit then
    // covers, counts as drawing (js/gfx.js checks it works, and copies each
    // frame where it does not).
    glEnable(GL_SCISSOR_TEST);
    glScissor(0, 0, 1, 1);
    glClearColor(0, 0, 0, 0);
    glClear(GL_COLOR_BUFFER_BIT);
    // The blit obeys the scissor test, and Skia leaves it set to whatever it
    // drew last; without this only that region reaches the canvas.
    glDisable(GL_SCISSOR_TEST);
    glBlitFramebuffer(0, 0, size.width(), size.height(), 0, 0, size.width(), size.height(), GL_COLOR_BUFFER_BIT, GL_NEAREST);
    grContext->resetContext();
    inception_gfx_present(window, frame.scrollX, frame.scrollY, frame.overscan);
}

void Renderer::paintCPU(unsigned window, Surface& windowSurface, IntSize size, std::optional<Damage> damage, std::optional<Scroll> scroll, const FrameInfo& frame, const PaintFunction& paint)
{
    auto info = SkImageInfo::Make(size.width(), size.height(), kRGBA_8888_SkColorType, kPremul_SkAlphaType, SkColorSpace::MakeSRGB());
    auto& pixels = windowSurface.pixels;
    if (windowSurface.pixelsSize != size) {
        damage = std::nullopt;
        windowSurface.pixelsSize = size;
    }
    pixels.resize(info.computeMinByteSize());
    auto properties = FontRenderOptions::singleton().createSurfaceProps();
    auto surface = SkSurfaces::WrapPixels(info, pixels.mutableSpan().data(), info.minRowBytes(), &properties);
    if (!surface)
        return;

    if (damage && scroll && !shiftPixels(*surface, *scroll))
        damage = std::nullopt;
    paintRegion(*surface->getCanvas(), RenderingMode::Unaccelerated, size, damage, paint);
    inception_gfx_present_pixels(window, pixels.span().data(), size.width(), size.height(), frame.scrollX, frame.scrollY, frame.overscan);
}

} // namespace Inception
