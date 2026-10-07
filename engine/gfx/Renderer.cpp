#include "config.h"
#include "gfx/Renderer.h"

#include "FontRenderOptions.h"
#include "GLContext.h"
#include "GraphicsContextSkia.h"
#include "PlatformDisplay.h"
#include "PlatformDisplayEmscripten.h"
#include "SkiaGLInterfaceEmscripten.h"
#include "WebGLContextEmscripten.h"
#include "bridge/Bridge.h"
#include <GLES3/gl3.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringBuilder.h>

WTF_IGNORE_WARNINGS_IN_THIRD_PARTY_CODE_BEGIN
#include <skia/core/SkCanvas.h>
#include <skia/core/SkColorSpace.h>
#include <skia/core/SkSurface.h>
#include <skia/gpu/ganesh/GrBackendSurface.h>
#include <skia/gpu/ganesh/GrDirectContext.h>
#include <skia/gpu/ganesh/SkSurfaceGanesh.h>
#include <skia/gpu/ganesh/gl/GrGLBackendSurface.h>
#include <skia/gpu/ganesh/gl/GrGLAssembleInterface.h>
#include <skia/gpu/ganesh/gl/GrGLDirectContext.h>
#include <skia/gpu/ganesh/gl/GrGLInterface.h>
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

// Assembles Skia's GLES interface the way the port does, recording which entry
// points WebGL2 does not provide, so a failed GPU start says why.
static void reportMissingGLFunctions()
{
    static StringBuilder* missing;
    StringBuilder names;
    missing = &names;
    auto interface = GrGLMakeAssembledInterface(nullptr, [](void*, const char* name) -> GrGLFuncPtr {
        auto proc = reinterpret_cast<GrGLFuncPtr>(emscripten_webgl_get_proc_address(name));
        if (!proc && strcmp(name, "glGetInternalformativ"))
            missing->append(' ', String::fromLatin1(name));
        return proc;
    });
    missing = nullptr;

    auto port = WebCore::makeSkiaGLInterfaceForWebGL();
    String version, glsl, made;
    if (port) {
        version = String::fromLatin1(reinterpret_cast<const char*>(port->fFunctions.fGetString(GL_VERSION)));
        glsl = String::fromLatin1(reinterpret_cast<const char*>(port->fFunctions.fGetString(GL_SHADING_LANGUAGE_VERSION)));
        made = GrDirectContexts::MakeGL(port) ? "yes"_s : "no"_s;
    }
    report("warn"_s, makeString("GL interface "_s, interface ? (interface->validate() ? "valid"_s : "invalid"_s) : "not assembled"_s, ", missing:"_s, names.toString(),
        "; port interface "_s, port ? (port->validate() ? "valid"_s : "invalid"_s) : "null"_s, " version '"_s, version, "' glsl '"_s, glsl, "' context "_s, made));
}

bool Renderer::initializeGPU()
{
    auto handle = inception_gfx_create_context(m_size.width(), m_size.height());
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
        reportMissingGLFunctions();
        report("warn"_s, makeString("Skia could not use WebGL2 ("_s, String::fromLatin1(reinterpret_cast<const char*>(glGetString(GL_VERSION))), "); painting on the CPU"_s));
        return false;
    }
    return true;
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

    // Skia paints into a render target of its own, which is then blitted to the
    // canvas's default framebuffer: Skia will not wrap WebGL's default
    // framebuffer directly. Bottom-left origin, like the canvas, so the blit
    // needs no flip.
    if (!m_surface || m_surface->width() != m_size.width() || m_surface->height() != m_size.height()) {
        auto info = SkImageInfo::Make(m_size.width(), m_size.height(), kRGBA_8888_SkColorType, kPremul_SkAlphaType, SkColorSpace::MakeSRGB());
        auto properties = FontRenderOptions::singleton().createSurfaceProps();
        m_surface = SkSurfaces::RenderTarget(grContext, skgpu::Budgeted::kNo, info, 0, kBottomLeft_GrSurfaceOrigin, &properties);
        if (!m_surface) {
            report("error"_s, makeString("Skia could not create a "_s, m_size.width(), 'x', m_size.height(), " render target (RGBA8 surface "_s,
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
    auto* surface = m_surface.get();

    auto* canvas = surface->getCanvas();
    canvas->clear(SK_ColorTRANSPARENT);
    {
        GraphicsContextSkia context(*canvas, RenderingMode::Accelerated, RenderingPurpose::Unspecified);
        paint(context);
    }
    grContext->flushAndSubmit(surface, GrSyncCpu::kNo);

    GrBackendRenderTarget target = SkSurfaces::GetBackendRenderTarget(surface, SkSurfaces::BackendHandleAccess::kFlushRead);
    GrGLFramebufferInfo framebuffer;
    if (!GrBackendRenderTargets::GetGLFramebufferInfo(target, &framebuffer))
        return;
    glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffer.fFBOID);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
    glBlitFramebuffer(0, 0, m_size.width(), m_size.height(), 0, 0, m_size.width(), m_size.height(), GL_COLOR_BUFFER_BIT, GL_NEAREST);
    grContext->resetContext(kRenderTarget_GrGLBackendState);
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
