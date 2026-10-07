#pragma once

#include "IntSize.h"
#include <wtf/RefPtr.h>
#include <wtf/URL.h>

namespace WebCore {
class LocalFrame;
class Page;
}

namespace Inception {

// One browsing view: a WebCore Page with its main frame, sized in CSS pixels and
// painted at the host's device pixel ratio. Frames are produced on demand: any
// invalidation or rendering-update request asks the host for the next
// animation frame, and that frame updates rendering and paints.
class View {
public:
    static View& create(WebCore::IntSize cssSize, float deviceScaleFactor);
    static View* singleton();

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

    RefPtr<WebCore::Page> m_page;
    WebCore::IntSize m_cssSize;
    float m_deviceScaleFactor { 1 };
    bool m_needsPaint { true };
    unsigned m_paintedFrames { 0 };
    String m_userAgent;
};

} // namespace Inception
