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

// One browsing view (a tab): a WebCore Page with its main frame, sized in CSS
// pixels and painted at the host's device pixel ratio. Frames are produced on
// demand: any invalidation or rendering-update request asks the host for the
// next animation frame, and that frame updates rendering and paints.
//
// An engine holds several tabs; one is active. Only the active tab paints and
// takes input; the others keep loading and running script, hidden.
class View {
public:
    static View& create(WebCore::IntSize cssSize, float deviceScaleFactor);
    // The active tab.
    static View* singleton();

    // A new hidden tab the size of the active one; "tab.created" tells the host.
    static View& createTab(unsigned openerID = 0);
    static View* byID(unsigned);
    static const Vector<View*>& all();
    // Shows this tab and hides the one that was active ("tab.activated").
    static void activate(unsigned id);
    // Closes the tab after the current task; the last tab is never closed.
    static void close(unsigned id);

    unsigned id() const { return m_id; }
    bool isActive() const { return singleton() == this; }

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

private:
    View(WebCore::IntSize, float);
    ~View();
    void setVisible(bool);

    unsigned m_id;
    RefPtr<WebCore::Page> m_page;
    WebCore::IntSize m_cssSize;
    float m_deviceScaleFactor { 1 };
    bool m_needsPaint { true };
    unsigned m_paintedFrames { 0 };
    String m_userAgent;
};

} // namespace Inception
