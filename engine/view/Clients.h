#pragma once

#include "EmptyClients.h"
#include "EmptyFrameLoaderClient.h"
#include "FileChooser.h"
#include <wtf/WeakRef.h>

namespace WebCore {
class LocalFrame;
}

namespace Inception {

class View;

class ChromeClientImpl final : public WebCore::EmptyChromeClient {
public:
    explicit ChromeClientImpl(View&);

private:
    WebCore::FloatRect windowRect() const final;
    WebCore::FloatRect pageRect() const final;

    void invalidateRootView(const WebCore::IntRect&) final;
    void invalidateContentsAndRootView(const WebCore::IntRect&) final;
    void invalidateContentsForSlowScroll(const WebCore::IntRect&) final;
    bool scheduleRenderingUpdate() final;
    void triggerRenderingUpdate() final;

    void addMessageToConsole(JSC::MessageSource, JSC::MessageLevel, const String& message, unsigned lineNumber, unsigned columnNumber, const String& sourceID) final;

    // Fullscreen is the host's: the view element itself goes fullscreen, and
    // the host reports back with "fullscreen.changed".
    bool supportsFullScreenForElement(const WebCore::Element&, bool) final { return true; }
    void enterFullScreenForElement(WebCore::Element&, WebCore::HTMLMediaElementEnums::VideoFullscreenMode, CompletionHandler<void(WebCore::ExceptionOr<void>)>&& willEnter, CompletionHandler<bool(bool)>&& didEnter) final;
    void exitFullScreenForElement(WebCore::Element*, CompletionHandler<void()>&&) final;
    void hostFullscreenChanged(bool active, const String& error);

    // Dialogs: the host shows them; the page waits for the answer, as it
    // would for a native one.
    bool canRunBeforeUnloadConfirmPanel() final { return true; }
    bool runBeforeUnloadConfirmPanel(String&& message, WebCore::LocalFrame&) final;
    void runJavaScriptAlert(WebCore::LocalFrame&, const String&) final;
    bool runJavaScriptConfirm(WebCore::LocalFrame&, const String&) final;
    bool runJavaScriptPrompt(WebCore::LocalFrame&, const String& message, const String& defaultValue, String& result) final;

    RefPtr<WebCore::PopupMenu> createPopupMenu(WebCore::PopupMenuClient&) const final;

    // The host's file picker; the chosen files are copied into the engine's
    // file system before "file.chosen" arrives.
    void runOpenPanel(WebCore::LocalFrame&, WebCore::FileChooser&) final;
    void filesChosen(bool cancelled);

    void setCursor(const WebCore::Cursor&) final;
    void setCursorHiddenUntilMouseMoves(bool) final { }

    bool isEmptyChromeClient() const final { return false; }

    RefPtr<WebCore::FileChooser> m_fileChooser;
    String m_cursor;
    CompletionHandler<void(WebCore::ExceptionOr<void>)> m_willEnterFullscreen;
    CompletionHandler<bool(bool)> m_didEnterFullscreen;
    bool m_hostFullscreen { false };
    RefPtr<WebCore::Element> m_fullscreenElement;
    WebCore::HTMLMediaElementEnums::VideoFullscreenMode m_fullscreenMode { };

    View& m_view;
};

class FrameLoaderClientImpl final : public WebCore::EmptyFrameLoaderClient {
public:
    FrameLoaderClientImpl(WebCore::FrameLoader&, WebCore::LocalFrame&, View&);

private:
    bool isEmptyFrameLoaderClient() const final { return false; }
    String userAgent(const URL&) const final;

    void dispatchDecidePolicyForNavigationAction(const WebCore::NavigationAction&, const WebCore::ResourceRequest&, const WebCore::ResourceResponse& redirectResponse, WebCore::FormState*, const String&, std::optional<WebCore::NavigationIdentifier>, std::optional<WebCore::HitTestResult>&&, bool, WebCore::NavigationUpgradeToHTTPSBehavior, WebCore::SandboxFlags, WebCore::PolicyDecisionMode, WebCore::FramePolicyFunction&&) final;
    void dispatchDecidePolicyForResponse(const WebCore::ResourceResponse&, const WebCore::ResourceRequest&, const String&, WebCore::FramePolicyFunction&&) final;
    void dispatchDecidePolicyForNewWindowAction(const WebCore::NavigationAction&, const WebCore::ResourceRequest&, WebCore::FormState*, const String&, std::optional<WebCore::HitTestResult>&&, WebCore::FramePolicyFunction&&) final;

    bool canHandleRequest(const WebCore::ResourceRequest&) const final { return true; }
    bool canShowMIMEType(const String&) const final;
    bool canShowMIMETypeAsHTML(const String&) const final { return true; }

    void committedLoad(WebCore::DocumentLoader*, const WebCore::SharedBuffer&) final;
    void transitionToCommittedForNewPage(InitializingIframe) final;

    void dispatchDidStartProvisionalLoad() final;
    void dispatchDidReceiveTitle(const WebCore::StringWithDirection&) final;
    void dispatchDidCommitLoad(std::optional<WebCore::HasInsecureContent>, std::optional<WebCore::UsedLegacyTLS>, std::optional<WebCore::WasPrivateRelayed>) final;
    void dispatchDidFailProvisionalLoad(const WebCore::ResourceError&, WebCore::WillContinueLoading, WebCore::WillInternallyHandleFailure) final;
    void dispatchDidFailLoad(const WebCore::ResourceError&) final;
    void dispatchDidFinishLoad() final;

    void dispatchDidClearWindowObjectInWorld(WebCore::DOMWrapperWorld&) final;

    bool isMainFrame() const;

    WeakRef<WebCore::LocalFrame> m_frame;
    View& m_view;
};

} // namespace Inception
