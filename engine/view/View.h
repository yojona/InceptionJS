#pragma once

#include "IntSize.h"
#include <wtf/RefPtr.h>
#include <wtf/URL.h>
#include <wtf/Vector.h>

namespace WebCore {
class LocalFrame;
class Page;
}

namespace Inception {

class Window;

// One browsing view (a tab): a WebCore Page with its main frame, sized in CSS
// pixels and painted at the host's device pixel ratio. Frames are produced on
// demand: any invalidation or rendering-update request asks the host for the
// next animation frame of its window, and that frame updates rendering and
// paints.
//
// Every tab belongs to one window (view/Window.h), and each window shows one
// of its tabs. Only a window's active tab paints and takes input; the others
// keep loading and running script, hidden.
class View {
public:
    // Window 1 and its first tab, at "init".
    static View& create(WebCore::IntSize cssSize, float deviceScaleFactor);
    // The first tab of a window made after "init"; no "tab.created" for it.
    static View& createFirst(Window&);
    // The active tab of the current window (view/Window.h), or of the focused
    // window outside any scope.
    static View* singleton();

    // A new hidden tab in the opener's window (else the current one), the size
    // of that window; "tab.created" tells the host.
    static View& createTab(unsigned openerID = 0);
    // The same in a given window.
    static View& createTab(Window&, unsigned openerID = 0);
    static View* byID(unsigned);
    static View* fromPage(const WebCore::Page*);
    static const Vector<View*>& all();
    // Shows this tab and hides the one its window showed ("tab.activated").
    static void activate(unsigned id);
    // Closes the tab after the current task; a window's last tab is closed
    // only with its window.
    static void close(unsigned id);
    // Closes a tab now, for a window that is closing.
    static void destroy(View&);

    unsigned id() const { return m_id; }
    Window& window() const { return *m_window; }
    bool isActive() const;

    void load(const URL&);
    void resize(WebCore::IntSize cssSize, float deviceScaleFactor);

    WebCore::IntSize cssSize() const { return m_cssSize; }
    float deviceScaleFactor() const { return m_deviceScaleFactor; }
    WebCore::Page& page() { return *m_page; }
    WebCore::LocalFrame* mainFrame() const;

    // Empty: the engine's default.
    void setUserAgent(const String& userAgent) { m_userAgent = userAgent; }
    const String& userAgent() const { return m_userAgent; }

    void setNeedsPaint();
    void requestFrame();
    void frame();

    void setVisible(bool);

private:
    View(Window&, WebCore::IntSize, float);
    ~View();

    unsigned m_id;
    Window* m_window;
    RefPtr<WebCore::Page> m_page;
    WebCore::IntSize m_cssSize;
    float m_deviceScaleFactor { 1 };
    bool m_needsPaint { true };
    unsigned m_paintedFrames { 0 };
    String m_userAgent;
};

} // namespace Inception
