#include "config.h"
#include "view/Clients.h"
#include "view/SiteLock.h"

#include "CertificateInfo.h"
#include "CertificateSummary.h"
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
#include "LinkIcon.h"
#include "LinkIconCollector.h"
#include "LinkIconType.h"
#include "Chrome.h"
#include "LocalFrameInlines.h"
#include "WindowFeatures.h"
#include "MediaProducer.h"
#include "NavigationAction.h"
#include "UserGestureIndicator.h"
#include "LocalFrameView.h"
#include "MIMETypeRegistry.h"
#include "ResourceError.h"
#include "ResourceRequest.h"
#include "ResourceResponse.h"
#include "SharedBuffer.h"
#include "UserAgent.h"
#include "agent/Agent.h"
#include "bridge/Bridge.h"
#include "modules/Modules.h"
#include "net/Download.h"
#include "storage/History.h"
#include "view/SelectMenu.h"
#include "view/Navigation.h"
#include "view/View.h"
#include "view/Window.h"
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
}

static ChromeClientImpl& chromeClient(View& view)
{
    return static_cast<ChromeClientImpl&>(view.page().chrome().client());
}

static bool s_popupsOpenWindows;

void setPopupsOpenWindows(bool windows)
{
    s_popupsOpenWindows = windows;
}

void ChromeClientImpl::registerCommands()
{
    // {active, error?}: to the tab of the window that asked for fullscreen
    // or holds it, else the window's shown tab.
    registerCommand("fullscreen.changed"_s, [](JSON::Object& args) {
        auto* window = Window::current();
        if (!window)
            return;
        View* target = window->activeTab();
        for (auto* view : window->tabs()) {
            if (chromeClient(*view).awaitsHostFullscreen())
                target = view;
        }
        if (target)
            chromeClient(*target).hostFullscreenChanged(args.getBoolean("active"_s).value_or(false), args.getString("error"_s));
    });
    // {cancelled}: to the window's tab whose file chooser is open.
    registerCommand("file.chosen"_s, [](JSON::Object& args) {
        auto* window = Window::current();
        if (!window)
            return;
        for (auto* view : window->tabs()) {
            if (chromeClient(*view).choosingFiles()) {
                chromeClient(*view).filesChosen(args.getBoolean("cancelled"_s).value_or(false));
                return;
            }
        }
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
    WindowScope scope(m_view);
    askHost("alert"_s, dialogData(frame, message));
}

bool ChromeClientImpl::runJavaScriptConfirm(LocalFrame& frame, const String& message)
{
    WindowScope scope(m_view);
    auto reply = askHost("confirm"_s, dialogData(frame, message));
    return reply && reply->asBoolean().value_or(false);
}

bool ChromeClientImpl::runJavaScriptPrompt(LocalFrame& frame, const String& message, const String& defaultValue, String& result)
{
    auto data = dialogData(frame, message);
    data->setString("defaultValue"_s, defaultValue);
    WindowScope scope(m_view);
    auto reply = askHost("prompt"_s, WTF::move(data));
    if (!reply || reply->type() != JSON::Value::Type::String)
        return false;
    result = reply->asString();
    return true;
}

bool ChromeClientImpl::runBeforeUnloadConfirmPanel(String&& message, LocalFrame& frame)
{
    WindowScope scope(m_view);
    auto reply = askHost("beforeunload"_s, dialogData(frame, message));
    return !reply || reply->asBoolean().value_or(true);
}

RefPtr<PopupMenu> ChromeClientImpl::createPopupMenu(PopupMenuClient& client) const
{
    return SelectMenu::create(client, m_view.window().id());
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
    data->setBoolean("userGesture"_s, UserGestureIndicator::processingUserGesture());
    WindowScope scope(m_view);
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
    WindowScope scope(m_view);
    emitEvent("fullscreen"_s, WTF::move(data));
}

void ChromeClientImpl::exitFullScreenForElement(Element* element, CompletionHandler<void()>&& completion)
{
    if (element)
        element->document().fullscreen().willExitFullscreen();
    if (m_hostFullscreen) {
        auto data = JSON::Object::create();
        data->setBoolean("active"_s, false);
        WindowScope scope(m_view);
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

RefPtr<Page> ChromeClientImpl::createWindow(LocalFrame&, const String& openedMainFrameName, const WindowFeatures& features, const NavigationAction& action)
{
    auto data = JSON::Object::create();
    data->setInteger("opener"_s, m_view.id());
    data->setString("url"_s, action.url().string());
    if (!openedMainFrameName.isEmpty())
        data->setString("name"_s, openedMainFrameName);
    // WebCore lets every window.open() through to here (View.cpp turns its
    // own blocker off) so a blocked one can be reported: without the person's
    // input nothing opens, and the host hears of it.
    if (!UserGestureIndicator::processingUserGesture()) {
        data->setInteger("tab"_s, m_view.id());
        data->setBoolean("userGesture"_s, false);
        WindowScope scope(m_view);
        emitEvent("tab.popupblocked"_s, WTF::move(data));
        return nullptr;
    }
    data->setBoolean("userGesture"_s, true);
    if (s_popupsOpenWindows) {
        // A new window, hidden until a display shows it, sized as asked or
        // as the opener's.
        auto& opener = m_view.window();
        IntSize size {
            features.width ? std::clamp(static_cast<int>(*features.width), 100, 8192) : opener.cssSize().width(),
            features.height ? std::clamp(static_cast<int>(*features.height), 100, 8192) : opener.cssSize().height(),
        };
        auto& window = Window::create(size, opener.deviceScaleFactor());
        auto& tab = View::createFirst(window);
        data->setInteger("window"_s, window.id());
        data->setInteger("tab"_s, tab.id());
        data->setInteger("openerWindow"_s, opener.id());
        emitEvent("window.opened"_s, WTF::move(data));
        return &tab.page();
    }
    auto& tab = View::createTab(m_view.id());
    data->setInteger("tab"_s, tab.id());
    emitEvent("tab.opened"_s, WTF::move(data));
    return &tab.page();
}

// The page asked to show the window it opened: the host decides whether it
// becomes the active tab.
void ChromeClientImpl::show()
{
    auto data = JSON::Object::create();
    data->setInteger("tab"_s, m_view.id());
    emitEvent("tab.show"_s, WTF::move(data));
}

void ChromeClientImpl::closeWindow()
{
    // The last tab of a window other than window 1 takes its window along.
    auto& window = m_view.window();
    if (window.id() != 1 && window.tabs().size() == 1)
        Window::close(window.id());
    else
        View::close(m_view.id());
}

// window.focus(): only the person may move focus, so the embedder decides
// ("tab.focus" for a hidden tab, "window.focus" for another window).
void ChromeClientImpl::focus()
{
    auto data = JSON::Object::create();
    if (!m_view.isActive()) {
        data->setInteger("tab"_s, m_view.id());
        emitEvent("tab.focus"_s, WTF::move(data));
    } else if (Window::focused() != &m_view.window()) {
        data->setInteger("window"_s, m_view.window().id());
        emitEvent("window.focus"_s, WTF::move(data));
    }
}

void ChromeClientImpl::isPlayingMediaDidChange(MediaProducerMediaStateFlags state)
{
    bool audible = state.contains(MediaProducerMediaState::IsPlayingAudio);
    if (audible == m_audible)
        return;
    m_audible = audible;
    auto data = JSON::Object::create();
    data->setInteger("tab"_s, m_view.id());
    data->setBoolean("audible"_s, audible);
    emitEvent("tab.audible"_s, WTF::move(data));
}

void ChromeClientImpl::setCursor(const Cursor& cursor)
{
    String css = cssCursor(cursor.type());
    if (css == m_cursor)
        return;
    m_cursor = css;
    auto data = JSON::Object::create();
    data->setString("cursor"_s, css);
    WindowScope scope(m_view);
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
    WindowScope scope(m_view);
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
    WindowScope scope(m_view);
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

void FrameLoaderClientImpl::dispatchDecidePolicyForNavigationAction(const NavigationAction& action, const ResourceRequest& request, const ResourceResponse&, FormState* formState, const String&, std::optional<NavigationIdentifier>, std::optional<HitTestResult>&&, bool, NavigationUpgradeToHTTPSBehavior, SandboxFlags, PolicyDecisionMode, FramePolicyFunction&& function)
{
    if (!Agent::allowsNavigation(m_view, action, request, formState)) {
        function(PolicyAction::Ignore);
        return;
    }
    // isolation 'site': another site's page opens in an engine of its own (a
    // redirect to one too: this check runs again for every hop).
    if (isMainFrame() && !SiteLock::keeps(request.url())) {
        function(PolicyAction::Ignore);
        auto& requester = action.requester();
        WindowScope scope(m_view);
        SiteLock::reportCrossSite(m_view.id(), request, requester ? requester->securityOrigin->toString() : String { }, action.processingUserGesture());
        return;
    }
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
    if (request.url().protocolIsInHTTPFamily() && Agent::allowsDownload(m_view, request.url())) {
        bool userGesture = UserGestureIndicator::processingUserGesture();
        RefPtr loader = m_frame->loader().policyDocumentLoader();
        if (!loader)
            loader = m_frame->loader().provisionalDocumentLoader();
        if (loader)
            userGesture |= loader->triggeringAction().processingUserGesture();
        Download::start(request, downloadAttribute, userGesture);
    }
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
    if (request.url().protocolIsInHTTPFamily() && Agent::allowsDownload(m_view, request.url()))
        Download::start(request, suggestedName, UserGestureIndicator::processingUserGesture());
}

// target=_blank and the like: WebCore opens a new tab through createWindow,
// and the host decides what to do with it. Pop-ups without a user gesture are
// already blocked by WebCore.
void FrameLoaderClientImpl::dispatchDecidePolicyForNewWindowAction(const NavigationAction& action, const ResourceRequest& request, FormState* formState, const String&, std::optional<HitTestResult>&&, FramePolicyFunction&& function)
{
    function(Agent::allowsNavigation(m_view, action, request, formState) ? PolicyAction::Use : PolicyAction::Ignore);
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
    data->setInteger("tab"_s, m_view.id());
    data->setBoolean("loading"_s, true);
    emitEvent("loading"_s, WTF::move(data));
}

void FrameLoaderClientImpl::dispatchDidReceiveTitle(const StringWithDirection& title)
{
    if (!isMainFrame())
        return;
    auto data = JSON::Object::create();
    data->setInteger("tab"_s, m_view.id());
    data->setString("title"_s, title.string);
    emitEvent("title"_s, WTF::move(data));
    if (RefPtr loader = m_frame->loader().documentLoader())
        History::updateTitle(loader->url(), title.string);
}

// "security.state": what the host's own UI shows about the connection of the
// page now shown (security plan S3): the scheme, and the server certificate
// the engine verified, when there was one.
static void emitSecurityState(View& view, DocumentLoader& loader)
{
    auto& url = loader.url();
    auto data = JSON::Object::create();
    data->setInteger("tab"_s, view.id());
    data->setString("url"_s, url.string());
    data->setString("scheme"_s, url.protocol().toString());
    data->setBoolean("secure"_s, url.protocolIs("https"_s) || url.protocolIs("wss"_s));
    auto& response = loader.response();
    if (!response.httpVersion().isEmpty())
        data->setString("httpVersion"_s, response.httpVersion());
    if (auto& info = response.certificateInfo(); info && !info->isEmpty()) {
        auto certificate = JSON::Object::create();
        if (auto summary = info->summary()) {
            certificate->setString("subject"_s, summary->subject);
            // Milliseconds since the epoch, as Date takes them.
            certificate->setDouble("validFrom"_s, summary->validFrom.milliseconds());
            certificate->setDouble("validUntil"_s, summary->validUntil.milliseconds());
            auto names = JSON::Array::create();
            for (auto& name : summary->dnsNames)
                names->pushString(name);
            certificate->setArray("dnsNames"_s, WTF::move(names));
        }
        certificate->setInteger("verificationError"_s, info->verificationError());
        certificate->setInteger("chainLength"_s, info->certificateChain().size());
        data->setObject("certificate"_s, WTF::move(certificate));
    }
    emitEvent("security.state"_s, WTF::move(data));
}

void FrameLoaderClientImpl::dispatchDidCommitLoad(std::optional<HasInsecureContent>, std::optional<UsedLegacyTLS>, std::optional<WasPrivateRelayed>)
{
    if (!isMainFrame())
        return;
    auto data = JSON::Object::create();
    data->setInteger("tab"_s, m_view.id());
    RefPtr loader = m_frame->loader().documentLoader();
    auto& url = loader->url();
    data->setString("url"_s, url.string());
    emitEvent("navigate"_s, WTF::move(data));
    emitSecurityState(m_view, *loader);
    History::recordVisit(url);
    // A new document starts with its loader's title, empty until its <title>
    // is parsed; WebKit only reports titles that are set, so without this a
    // page with none would keep the previous page's.
    auto title = JSON::Object::create();
    title->setInteger("tab"_s, m_view.id());
    title->setString("title"_s, loader->title().string);
    emitEvent("title"_s, WTF::move(title));
}

static void emitLoadFinished(View& view, const ResourceError* error)
{
    auto data = JSON::Object::create();
    data->setInteger("tab"_s, view.id());
    data->setBoolean("loading"_s, false);
    if (error && !error->isCancellation()) {
        data->setString("error"_s, error->localizedDescription());
        data->setString("failedURL"_s, error->failingURL().string());
        // The server's certificate did not verify: the host shows its own
        // error, and there is no way past it.
        if (error->isCertificationVerificationError())
            data->setString("errorKind"_s, "certificate"_s);
    }
    emitEvent("loading"_s, WTF::move(data));
}

void FrameLoaderClientImpl::dispatchDidFailProvisionalLoad(const ResourceError& error, WillContinueLoading, WillInternallyHandleFailure)
{
    if (isMainFrame())
        emitLoadFinished(m_view, &error);
}

LocalFrame* FrameLoaderClientImpl::dispatchCreatePage(const NavigationAction& action, NewFrameOpenerPolicy)
{
    RefPtr page = m_frame->page();
    if (!page)
        return nullptr;
    RefPtr newPage = page->chrome().createWindow(m_frame.get(), { }, { }, action);
    return newPage ? dynamicDowncast<LocalFrame>(newPage->mainFrame()) : nullptr;
}

void FrameLoaderClientImpl::dispatchShow()
{
    if (RefPtr page = m_frame->page())
        page->chrome().show();
}

// The page's icons ("tab.icons"), largest first; the host picks one and
// fetches it as it sees fit.
void FrameLoaderClientImpl::emitIcons()
{
    RefPtr document = m_frame->document();
    if (!document)
        return;
    auto icons = LinkIconCollector { Ref { *document } }.iconsOfTypes({ LinkIconType::Favicon, LinkIconType::TouchIcon, LinkIconType::TouchPrecomposedIcon });
    auto list = JSON::Array::create();
    for (auto& icon : icons) {
        auto entry = JSON::Object::create();
        entry->setString("url"_s, icon.url.string());
        if (icon.size)
            entry->setInteger("size"_s, *icon.size);
        if (!icon.mimeType.isEmpty())
            entry->setString("type"_s, icon.mimeType);
        list->pushObject(WTF::move(entry));
    }
    // A site without <link rel=icon> still has the conventional one.
    if (!list->length() && document->url().protocolIsInHTTPFamily()) {
        auto entry = JSON::Object::create();
        entry->setString("url"_s, URL { document->url(), "/favicon.ico"_s }.string());
        list->pushObject(WTF::move(entry));
    }
    auto data = JSON::Object::create();
    data->setInteger("tab"_s, m_view.id());
    data->setArray("icons"_s, WTF::move(list));
    emitEvent("tab.icons"_s, WTF::move(data));
}

void FrameLoaderClientImpl::dispatchDidFailLoad(const ResourceError& error)
{
    if (isMainFrame())
        emitLoadFinished(m_view, &error);
}

void FrameLoaderClientImpl::dispatchDidFinishLoad()
{
    if (isMainFrame()) {
        emitLoadFinished(m_view, nullptr);
        emitIcons();
    }
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
