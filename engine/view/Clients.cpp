#include "config.h"
#include "view/Clients.h"

#include "Color.h"
#include "Cursor.h"
#include "Document.h"
#include "DocumentFullscreen.h"
#include "DocumentPage.h"
#include "Element.h"
#include "ElementInlines.h"
#include "NodeDocument.h"
#include "Exception.h"
#include "FileChooser.h"
#include "PopupMenuClient.h"
#include "DocumentLoader.h"
#include "FrameLoader.h"
#include "FrameTreeSyncData.h"
#include "HTMLInputElement.h"
#include "HTMLNames.h"
#include "SecurityOrigin.h"
#include "HTMLFrameOwnerElement.h"
#include "HistoryController.h"
#include "HistoryItem.h"
#include "LocalFrameInlines.h"
#include "LocalFrameView.h"
#include "MIMETypeRegistry.h"
#include "ResourceError.h"
#include "ResourceRequest.h"
#include "ResourceResponse.h"
#include "SharedBuffer.h"
#include "UserAgent.h"
#include "bridge/Bridge.h"
#include "modules/Modules.h"
#include "net/Download.h"
#include "storage/History.h"
#include "view/SelectMenu.h"
#include "view/View.h"
#include "wasm/GuestWasm.h"
#include <JavaScriptCore/ConsoleTypes.h>
#include <emscripten/em_macros.h>
#include <wtf/FileHandle.h>
#include <wtf/FileSystem.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

namespace Inception {
using namespace WebCore;

void runInjectedScript(LocalFrame&, DOMWrapperWorld&);

ChromeClientImpl::ChromeClientImpl(View& view)
    : m_view(view)
{
    // {active, error?}
    registerCommand("fullscreen.changed"_s, [this](JSON::Object& args) {
        hostFullscreenChanged(args.getBoolean("active"_s).value_or(false), args.getString("error"_s));
    });
    // {cancelled}
    registerCommand("file.chosen"_s, [this](JSON::Object& args) {
        filesChosen(args.getBoolean("cancelled"_s).value_or(false));
    });
    SelectMenu::registerCommands();
}

static Ref<JSON::Object> dialogData(LocalFrame& frame, const String& message)
{
    auto data = JSON::Object::create();
    data->setString("message"_s, message);
    data->setString("url"_s, frame.document() ? frame.document()->url().string() : String());
    return data;
}

void ChromeClientImpl::runJavaScriptAlert(LocalFrame& frame, const String& message)
{
    askHost("alert"_s, dialogData(frame, message));
}

bool ChromeClientImpl::runJavaScriptConfirm(LocalFrame& frame, const String& message)
{
    auto reply = askHost("confirm"_s, dialogData(frame, message));
    return reply && reply->asBoolean().value_or(false);
}

bool ChromeClientImpl::runJavaScriptPrompt(LocalFrame& frame, const String& message, const String& defaultValue, String& result)
{
    auto data = dialogData(frame, message);
    data->setString("defaultValue"_s, defaultValue);
    auto reply = askHost("prompt"_s, WTF::move(data));
    if (!reply || reply->type() != JSON::Value::Type::String)
        return false;
    result = reply->asString();
    return true;
}

bool ChromeClientImpl::runBeforeUnloadConfirmPanel(String&& message, LocalFrame& frame)
{
    auto reply = askHost("beforeunload"_s, dialogData(frame, message));
    return !reply || reply->asBoolean().value_or(true);
}

RefPtr<PopupMenu> ChromeClientImpl::createPopupMenu(PopupMenuClient& client) const
{
    return SelectMenu::create(client);
}

// Files the host has copied in for the pending chooser.
static Vector<String>& receivedFiles()
{
    static NeverDestroyed<Vector<String>> files;
    return files;
}

void ChromeClientImpl::runOpenPanel(LocalFrame&, FileChooser& chooser)
{
    if (m_fileChooser)
        m_fileChooser->cancelFileChoosing();
    m_fileChooser = &chooser;
    receivedFiles().clear();
    auto& settings = chooser.settings();
    auto data = JSON::Object::create();
    data->setBoolean("multiple"_s, settings.allowsMultipleFiles);
    data->setBoolean("directory"_s, settings.allowsDirectories);
    auto accept = JSON::Array::create();
    for (auto& type : settings.acceptMIMETypes)
        accept->pushString(type);
    for (auto& extension : settings.acceptFileExtensions)
        accept->pushString(extension);
    data->setArray("accept"_s, WTF::move(accept));
    emitEvent("file.choose"_s, WTF::move(data));
}

void ChromeClientImpl::filesChosen(bool cancelled)
{
    RefPtr chooser = std::exchange(m_fileChooser, nullptr);
    auto files = std::exchange(receivedFiles(), { });
    if (!chooser)
        return;
    if (cancelled || files.isEmpty())
        chooser->cancelFileChoosing();
    else
        chooser->chooseFiles(files);
}

void ChromeClientImpl::enterFullScreenForElement(Element& element, HTMLMediaElementEnums::VideoFullscreenMode mode, CompletionHandler<void(ExceptionOr<void>)>&& willEnter, CompletionHandler<bool(bool)>&& didEnter)
{
    if (m_willEnterFullscreen)
        m_willEnterFullscreen(Exception { ExceptionCode::TypeError, "Another fullscreen request is pending"_s });
    if (m_didEnterFullscreen)
        m_didEnterFullscreen(false);
    m_willEnterFullscreen = WTF::move(willEnter);
    m_didEnterFullscreen = WTF::move(didEnter);
    m_fullscreenElement = &element;
    m_fullscreenMode = mode;
    auto data = JSON::Object::create();
    data->setBoolean("active"_s, true);
    emitEvent("fullscreen"_s, WTF::move(data));
}

void ChromeClientImpl::exitFullScreenForElement(Element* element, CompletionHandler<void()>&& completion)
{
    if (element)
        element->document().fullscreen().willExitFullscreen();
    if (m_hostFullscreen) {
        auto data = JSON::Object::create();
        data->setBoolean("active"_s, false);
        emitEvent("fullscreen"_s, WTF::move(data));
    }
    completion();
}

void ChromeClientImpl::hostFullscreenChanged(bool active, const String& error)
{
    bool wasActive = std::exchange(m_hostFullscreen, active);
    if (m_willEnterFullscreen) {
        RefPtr element = std::exchange(m_fullscreenElement, nullptr);
        if (active && element) {
            // The document enters fullscreen in two steps around the host's own.
            auto result = element->document().fullscreen().willEnterFullscreen(*element, m_fullscreenMode);
            bool succeeded = !result.hasException();
            m_willEnterFullscreen(WTF::move(result));
            if (m_didEnterFullscreen)
                m_didEnterFullscreen(succeeded);
        } else {
            m_willEnterFullscreen(Exception { ExceptionCode::TypeError, error.isEmpty() ? "Fullscreen request denied"_s : error });
            if (m_didEnterFullscreen)
                m_didEnterFullscreen(false);
        }
        return;
    }
    // The person left fullscreen in the host (Escape, a browser control).
    if (wasActive && !active) {
        if (RefPtr frame = m_view.mainFrame()) {
            if (RefPtr document = frame->document(); document && document->fullscreen().fullscreenElement())
                document->fullscreen().fullyExitFullscreen();
        }
    }
}

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

static ASCIILiteral sensitiveFieldKind(const Element* element)
{
    RefPtr input = dynamicDowncast<HTMLInputElement>(element);
    if (!input)
        return ""_s;
    if (input->isPasswordField())
        return "password"_s;
    if (input->attributeWithoutSynchronization(HTMLNames::autocompleteAttr).contains("cc-"_s))
        return "payment"_s;
    return ""_s;
}

// "field.focus" {kind: "password"|"payment"|"", origin}: sent when the kind
// changes, including back to "" when such a field loses focus.
void ChromeClientImpl::focusedElementChanged(Element* element, LocalFrame* frame, FocusOptions, BroadcastFocusedElement)
{
    String kind = sensitiveFieldKind(element);
    if (kind == m_sensitiveField)
        return;
    m_sensitiveField = kind;
    auto data = JSON::Object::create();
    data->setString("kind"_s, kind);
    if (frame && frame->document())
        data->setString("origin"_s, frame->document()->securityOrigin().toString());
    emitEvent("field.focus"_s, WTF::move(data));
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
    installPageShims(m_frame.get(), world);
    runInjectedScript(m_frame.get(), world);
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

void FrameLoaderClientImpl::dispatchDecidePolicyForResponse(const ResourceResponse& response, const ResourceRequest& request, const String& downloadAttribute, FramePolicyFunction&& function)
{
    // Attachments, and what the engine cannot show, become downloads: this
    // load stops and the engine fetches the file again for the host.
    if (!response.isAttachment() && downloadAttribute.isNull() && canShowMIMEType(response.mimeType())) {
        function(PolicyAction::Use);
        return;
    }
    function(PolicyAction::Ignore);
    if (request.url().protocolIsInHTTPFamily())
        Download::start(request, downloadAttribute);
}

// Session history entries: the tree of the whole page, rooted at the main
// frame, with this frame as the target.
RefPtr<HistoryItem> FrameLoaderClientImpl::createHistoryItemTree(bool clipAtTarget, BackForwardItemIdentifier itemID) const
{
    Ref root = m_frame->rootFrame();
    return root->loader().history().createItemTree(m_frame.get(), clipAtTarget, itemID);
}

// <a download> and similar: straight to a download.
void FrameLoaderClientImpl::startDownload(const ResourceRequest& request, const String& suggestedName, FromDownloadAttribute)
{
    if (request.url().protocolIsInHTTPFamily())
        Download::start(request, suggestedName);
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

// <iframe> and <frame>: a local subframe with its own loader client, so it
// loads, paints inside its owner's box and takes input like the main frame.
RefPtr<LocalFrame> FrameLoaderClientImpl::createFrame(const AtomString& name, HTMLFrameOwnerElement& ownerElement)
{
    RefPtr page = m_frame->page();
    if (!page)
        return nullptr;
    auto sandboxFlags = ownerElement.sandboxFlags();
    sandboxFlags.add(m_frame->effectiveSandboxFlags());
    auto referrerPolicy = ownerElement.referrerPolicy();
    if (referrerPolicy == ReferrerPolicy::EmptyString) {
        if (RefPtr document = m_frame->document())
            referrerPolicy = document->referrerPolicy();
    }
    Ref subframe = LocalFrame::createSubframe(*page, [view = &m_view](auto& frame, auto& frameLoader) {
        return makeUniqueRefWithoutRefCountedCheck<FrameLoaderClientImpl>(frameLoader, frame, *view);
    }, generateFrameIdentifier(), sandboxFlags, referrerPolicy, ownerElement, FrameTreeSyncData::create());
    subframe->tree().setSpecifiedName(name);
    subframe->init();
    // Creating the frame can run script that removes it again.
    if (!subframe->page())
        return nullptr;
    return subframe;
}

void FrameLoaderClientImpl::transitionToCommittedForNewPage(InitializingIframe)
{
    // Subframes are transparent until their page paints a background, so the
    // owner's content shows through as in any browser.
    m_frame->createView(m_view.cssSize(), isMainFrame() ? Color::white : Color(), { });
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
    if (RefPtr loader = m_frame->loader().documentLoader())
        History::updateTitle(loader->url(), title.string);
}

void FrameLoaderClientImpl::dispatchDidCommitLoad(std::optional<HasInsecureContent>, std::optional<UsedLegacyTLS>, std::optional<WasPrivateRelayed>)
{
    if (!isMainFrame())
        return;
    auto data = JSON::Object::create();
    auto& url = m_frame->loader().documentLoader()->url();
    data->setString("url"_s, url.string());
    emitEvent("navigate"_s, WTF::move(data));
    History::recordVisit(url);
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

// One file from the host's picker (bridge.js): written under /tmp so File
// objects read it like any other file.
extern "C" EMSCRIPTEN_KEEPALIVE void inception_file_store(const char* name, const uint8_t* data, size_t length)
{
    using namespace Inception;
    static unsigned lastBatch;
    auto directory = makeString("/tmp/chosen/"_s, ++lastBatch);
    FileSystem::makeAllDirectories(directory);
    auto path = FileSystem::pathByAppendingComponent(directory, FileSystem::pathFileName(String::fromUTF8(name)));
    auto handle = FileSystem::openFile(path, FileSystem::FileOpenMode::Truncate);
    if (!handle)
        return;
    if (handle.write({ data, length }) != std::optional<uint64_t> { length })
        return;
    receivedFiles().append(path);
}
