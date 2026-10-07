#include "config.h"
#include "view/Clients.h"

#include "Color.h"
#include "Cursor.h"
#include "DocumentLoader.h"
#include "FrameLoader.h"
#include "LocalFrameInlines.h"
#include "LocalFrameView.h"
#include "MIMETypeRegistry.h"
#include "ResourceError.h"
#include "ResourceRequest.h"
#include "ResourceResponse.h"
#include "SharedBuffer.h"
#include "UserAgent.h"
#include "bridge/Bridge.h"
#include "view/View.h"
#include "wasm/GuestWasm.h"
#include <JavaScriptCore/ConsoleTypes.h>

namespace Inception {
using namespace WebCore;

FloatRect ChromeClientImpl::windowRect() const
{
    return { { }, m_view.cssSize() };
}

FloatRect ChromeClientImpl::pageRect() const
{
    return windowRect();
}

void ChromeClientImpl::invalidateRootView(const IntRect&)
{
    m_view.setNeedsPaint();
}

void ChromeClientImpl::invalidateContentsAndRootView(const IntRect&)
{
    m_view.setNeedsPaint();
}

void ChromeClientImpl::invalidateContentsForSlowScroll(const IntRect&)
{
    m_view.setNeedsPaint();
}

bool ChromeClientImpl::scheduleRenderingUpdate()
{
    m_view.requestFrame();
    return true;
}

void ChromeClientImpl::triggerRenderingUpdate()
{
    m_view.requestFrame();
}

// The CSS cursor keyword for each WebCore cursor. Image cursors fall back to
// the default until the engine can encode their images for the host.
static ASCIILiteral cssCursor(Cursor::Type type)
{
    switch (type) {
    case Cursor::Type::Pointer: return "default"_s;
    case Cursor::Type::Cross: return "crosshair"_s;
    case Cursor::Type::Hand: return "pointer"_s;
    case Cursor::Type::IBeam: return "text"_s;
    case Cursor::Type::Wait: return "wait"_s;
    case Cursor::Type::Help: return "help"_s;
    case Cursor::Type::EastResize: return "e-resize"_s;
    case Cursor::Type::NorthResize: return "n-resize"_s;
    case Cursor::Type::NorthEastResize: return "ne-resize"_s;
    case Cursor::Type::NorthWestResize: return "nw-resize"_s;
    case Cursor::Type::SouthResize: return "s-resize"_s;
    case Cursor::Type::SouthEastResize: return "se-resize"_s;
    case Cursor::Type::SouthWestResize: return "sw-resize"_s;
    case Cursor::Type::WestResize: return "w-resize"_s;
    case Cursor::Type::NorthSouthResize: return "ns-resize"_s;
    case Cursor::Type::EastWestResize: return "ew-resize"_s;
    case Cursor::Type::NorthEastSouthWestResize: return "nesw-resize"_s;
    case Cursor::Type::NorthWestSouthEastResize: return "nwse-resize"_s;
    case Cursor::Type::ColumnResize: return "col-resize"_s;
    case Cursor::Type::RowResize: return "row-resize"_s;
    case Cursor::Type::MiddlePanning:
    case Cursor::Type::EastPanning:
    case Cursor::Type::NorthPanning:
    case Cursor::Type::NorthEastPanning:
    case Cursor::Type::NorthWestPanning:
    case Cursor::Type::SouthPanning:
    case Cursor::Type::SouthEastPanning:
    case Cursor::Type::SouthWestPanning:
    case Cursor::Type::WestPanning:
    case Cursor::Type::Move: return "move"_s;
    case Cursor::Type::VerticalText: return "vertical-text"_s;
    case Cursor::Type::Cell: return "cell"_s;
    case Cursor::Type::ContextMenu: return "context-menu"_s;
    case Cursor::Type::Alias: return "alias"_s;
    case Cursor::Type::Progress: return "progress"_s;
    case Cursor::Type::NoDrop: return "no-drop"_s;
    case Cursor::Type::Copy: return "copy"_s;
    case Cursor::Type::None: return "none"_s;
    case Cursor::Type::NotAllowed: return "not-allowed"_s;
    case Cursor::Type::ZoomIn: return "zoom-in"_s;
    case Cursor::Type::ZoomOut: return "zoom-out"_s;
    case Cursor::Type::Grab: return "grab"_s;
    case Cursor::Type::Grabbing: return "grabbing"_s;
    case Cursor::Type::Invalid:
    case Cursor::Type::Custom:
        break;
    }
    return "default"_s;
}

void ChromeClientImpl::setCursor(const Cursor& cursor)
{
    String css = cssCursor(cursor.type());
    if (css == m_cursor)
        return;
    m_cursor = css;
    auto data = JSON::Object::create();
    data->setString("cursor"_s, css);
    emitEvent("cursor"_s, WTF::move(data));
}

static ASCIILiteral levelName(JSC::MessageLevel level)
{
    switch (level) {
    case JSC::MessageLevel::Error:
        return "error"_s;
    case JSC::MessageLevel::Warning:
        return "warn"_s;
    case JSC::MessageLevel::Debug:
        return "debug"_s;
    case JSC::MessageLevel::Info:
        return "info"_s;
    default:
        return "log"_s;
    }
}

void ChromeClientImpl::addMessageToConsole(JSC::MessageSource, JSC::MessageLevel level, const String& message, unsigned lineNumber, unsigned columnNumber, const String& sourceID)
{
    auto data = JSON::Object::create();
    data->setString("level"_s, levelName(level));
    data->setString("message"_s, message);
    data->setString("source"_s, sourceID);
    data->setInteger("line"_s, lineNumber);
    data->setInteger("column"_s, columnNumber);
    emitEvent("console"_s, WTF::move(data));
}

FrameLoaderClientImpl::FrameLoaderClientImpl(FrameLoader& loader, LocalFrame& frame, View& view)
    : EmptyFrameLoaderClient(loader)
    , m_frame(frame)
    , m_view(view)
{
}

void FrameLoaderClientImpl::dispatchDidClearWindowObjectInWorld(DOMWrapperWorld& world)
{
    GuestWasm::installInWindow(m_frame.get(), world);
}

bool FrameLoaderClientImpl::isMainFrame() const
{
    return m_frame->isMainFrame();
}

String FrameLoaderClientImpl::userAgent(const URL& url) const
{
    if (!m_view.userAgent().isEmpty())
        return m_view.userAgent();
    return standardUserAgentForURL(url);
}

void FrameLoaderClientImpl::dispatchDecidePolicyForNavigationAction(const NavigationAction&, const ResourceRequest&, const ResourceResponse&, FormState*, const String&, std::optional<NavigationIdentifier>, std::optional<HitTestResult>&&, bool, NavigationUpgradeToHTTPSBehavior, SandboxFlags, PolicyDecisionMode, FramePolicyFunction&& function)
{
    function(PolicyAction::Use);
}

void FrameLoaderClientImpl::dispatchDecidePolicyForResponse(const ResourceResponse& response, const ResourceRequest&, const String&, FramePolicyFunction&& function)
{
    // Downloads arrive with the download milestone; until then anything the
    // engine cannot render is dropped.
    function(canShowMIMEType(response.mimeType()) ? PolicyAction::Use : PolicyAction::Ignore);
}

void FrameLoaderClientImpl::dispatchDecidePolicyForNewWindowAction(const NavigationAction&, const ResourceRequest& request, FormState*, const String&, std::optional<HitTestResult>&&, FramePolicyFunction&& function)
{
    auto data = JSON::Object::create();
    data->setString("url"_s, request.url().string());
    emitEvent("popup"_s, WTF::move(data));
    function(PolicyAction::Ignore);
}

bool FrameLoaderClientImpl::canShowMIMEType(const String& mimeType) const
{
    return MIMETypeRegistry::canShowMIMEType(mimeType);
}

void FrameLoaderClientImpl::committedLoad(DocumentLoader* loader, const SharedBuffer& data)
{
    loader->commitData(data);
}

void FrameLoaderClientImpl::transitionToCommittedForNewPage(InitializingIframe)
{
    m_frame->createView(m_view.cssSize(), Color::white, { });
}

void FrameLoaderClientImpl::dispatchDidStartProvisionalLoad()
{
    if (!isMainFrame())
        return;
    auto data = JSON::Object::create();
    data->setBoolean("loading"_s, true);
    emitEvent("loading"_s, WTF::move(data));
}

void FrameLoaderClientImpl::dispatchDidReceiveTitle(const StringWithDirection& title)
{
    if (!isMainFrame())
        return;
    auto data = JSON::Object::create();
    data->setString("title"_s, title.string);
    emitEvent("title"_s, WTF::move(data));
}

void FrameLoaderClientImpl::dispatchDidCommitLoad(std::optional<HasInsecureContent>, std::optional<UsedLegacyTLS>, std::optional<WasPrivateRelayed>)
{
    if (!isMainFrame())
        return;
    auto data = JSON::Object::create();
    data->setString("url"_s, m_frame->loader().documentLoader()->url().string());
    emitEvent("navigate"_s, WTF::move(data));
}

static void emitLoadFinished(const ResourceError* error)
{
    auto data = JSON::Object::create();
    data->setBoolean("loading"_s, false);
    if (error && !error->isCancellation()) {
        data->setString("error"_s, error->localizedDescription());
        data->setString("failedURL"_s, error->failingURL().string());
    }
    emitEvent("loading"_s, WTF::move(data));
}

void FrameLoaderClientImpl::dispatchDidFailProvisionalLoad(const ResourceError& error, WillContinueLoading, WillInternallyHandleFailure)
{
    if (isMainFrame())
        emitLoadFinished(&error);
}

void FrameLoaderClientImpl::dispatchDidFailLoad(const ResourceError& error)
{
    if (isMainFrame())
        emitLoadFinished(&error);
}

void FrameLoaderClientImpl::dispatchDidFinishLoad()
{
    if (isMainFrame())
        emitLoadFinished(nullptr);
    m_view.setNeedsPaint();
}

} // namespace Inception
