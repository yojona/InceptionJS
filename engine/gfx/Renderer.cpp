#include "config.h"
#include "gfx/Renderer.h"

#include "FontRenderOptions.h"
#include "GLContext.h"
#include "GraphicsContextSkia.h"
#include "PlatformDisplay.h"
#include "PlatformDisplayEmscripten.h"
#include "WebGLContextEmscripten.h"
#include <GLES3/gl3.h>
#include <wtf/NeverDestroyed.h>

WTF_IGNORE_WARNINGS_IN_THIRD_PARTY_CODE_BEGIN
#include <skia/core/SkCanvas.h>
#include <skia/core/SkColorSpace.h>
#include <skia/core/SkSurface.h>
#include <skia/gpu/ganesh/GrBackendSurface.h>
#include <skia/gpu/ganesh/GrDirectContext.h>
#include <skia/gpu/ganesh/SkSurfaceGanesh.h>
#include <skia/gpu/ganesh/gl/GrGLBackendSurface.h>
WTF_IGNORE_WARNINGS_IN_THIRD_PARTY_CODE_END

extern "C" {
int inception_gfx_create_context(int width, int height);
void inception_gfx_resize(int width, int height);
void inception_gfx_present();
void inception_gfx_present_pixels(const uint8_t*, int width, int height);
}

namespace Inception {
using namespace WebCore;

Renderer& Renderer::singleton()
{
    static NeverDestroyed<Renderer> renderer;
    return renderer;
}

Renderer::Mode Renderer::initialize(IntSize pixelSize, bool preferGPU)
{
    m_size = pixelSize;
    m_mode = preferGPU && initializeGPU() ? Mode::GPU : Mode::CPU;
    return m_mode;
}

bool Renderer::initializeGPU()
{
    auto handle = inception_gfx_create_context(m_size.width(), m_size.height());
    if (!handle)
        return false;
    setSharedWebGLContext(handle);
    if (emscripten_webgl_make_context_current(handle) != EMSCRIPTEN_RESULT_SUCCESS)
        return false;

    if (!PlatformDisplay::sharedDisplayIfExists()) {
        auto display = PlatformDisplayEmscripten::create();
        if (!display)
            return false;
        PlatformDisplay::setSharedDisplay(WTF::move(display));
    }
    auto& display = PlatformDisplay::sharedDisplay();
    return display.skiaGLContext() && display.skiaGrContext();
}

void Renderer::resize(IntSize pixelSize)
{
    m_size = pixelSize;
    if (m_mode == Mode::GPU)
        inception_gfx_resize(m_size.width(), m_size.height());
}

void Renderer::paintFrame(const Function<void(GraphicsContext&)>& paint)
{
    if (m_size.isEmpty())
        return;
    if (m_mode == Mode::GPU)
        paintGPU(paint);
    else
        paintCPU(paint);
}

void Renderer::paintGPU(const Function<void(GraphicsContext&)>& paint)
{
    auto& display = PlatformDisplay::sharedDisplay();
    if (!display.skiaGLContext()->makeContextCurrent())
        return;
    auto* grContext = display.skiaGrContext();

    // The default framebuffer of the OffscreenCanvas; WebGL flips it on present,
    // hence the bottom-left origin.
    GrGLFramebufferInfo framebuffer { 0, GL_RGBA8 };
    auto target = GrBackendRenderTargets::MakeGL(m_size.width(), m_size.height(), 0, 8, framebuffer);
    auto properties = FontRenderOptions::singleton().createSurfaceProps();
    auto surface = SkSurfaces::WrapBackendRenderTarget(grContext, target, kBottomLeft_GrSurfaceOrigin,
        kRGBA_8888_SkColorType, SkColorSpace::MakeSRGB(), &properties);
    if (!surface)
        return;

    auto* canvas = surface->getCanvas();
    canvas->clear(SK_ColorTRANSPARENT);
    {
        GraphicsContextSkia context(*canvas, RenderingMode::Accelerated, RenderingPurpose::Unspecified);
        paint(context);
    }
    grContext->flushAndSubmit(surface.get(), GrSyncCpu::kNo);
    inception_gfx_present();
}

void Renderer::paintCPU(const Function<void(GraphicsContext&)>& paint)
{
    auto info = SkImageInfo::Make(m_size.width(), m_size.height(), kRGBA_8888_SkColorType, kPremul_SkAlphaType, SkColorSpace::MakeSRGB());
    m_pixels.resize(info.computeMinByteSize());
    auto properties = FontRenderOptions::singleton().createSurfaceProps();
    auto surface = SkSurfaces::WrapPixels(info, m_pixels.mutableSpan().data(), info.minRowBytes(), &properties);
    if (!surface)
        return;

    auto* canvas = surface->getCanvas();
    canvas->clear(SK_ColorTRANSPARENT);
    {
        GraphicsContextSkia context(*canvas, RenderingMode::Unaccelerated, RenderingPurpose::Unspecified);
        paint(context);
    }
    inception_gfx_present_pixels(m_pixels.span().data(), m_size.width(), m_size.height());
}

} // namespace Inception
