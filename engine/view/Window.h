#pragma once

#include "IntSize.h"
#include <wtf/Vector.h>

namespace Inception {

class View;

// A window: a sized surface with its own tabs, one of them shown. An engine
// holds several; window 1 is created by "init" and lives as long as the
// engine. Ids are never reused. A hidden window does not paint, but its pages
// keep loading and running script, as a hidden tab's do.
class Window {
public:
    static Window& create(WebCore::IntSize cssSize, float deviceScaleFactor);
    static Window* byID(unsigned);
    static const Vector<Window*>& all();
    // The window the running command or callback acts on (see WindowScope).
    static Window* current();
    // The window the person is using: at most one has focus.
    static Window* focused() { return byID(s_focused); }
    // Closes the window and its tabs after the current task; window 1 stays.
    static void close(unsigned id);

    unsigned id() const { return m_id; }
    WebCore::IntSize cssSize() const { return m_cssSize; }
    float deviceScaleFactor() const { return m_deviceScaleFactor; }
    void setSize(WebCore::IntSize cssSize, float deviceScaleFactor);
    bool isVisible() const { return m_visible; }
    void setVisible(bool);
    void setFocused(bool);

    View* activeTab() const { return m_active; }
    void setActiveTab(View* view) { m_active = view; }
    Vector<View*> tabs() const;

private:
    friend class WindowScope;
    Window(WebCore::IntSize, float);
    ~Window();

    static unsigned s_current;
    static unsigned s_focused;

    unsigned m_id;
    WebCore::IntSize m_cssSize;
    float m_deviceScaleFactor { 1 };
    bool m_visible { false };
    View* m_active { nullptr };
};

// Makes a window the current one for the scope's lifetime: the bridge installs
// one around every command, and page callbacks around what they emit, so
// events are tagged with their window and View::singleton() answers for it.
class WindowScope {
public:
    explicit WindowScope(unsigned windowID);
    explicit WindowScope(const View&);
    ~WindowScope();

private:
    unsigned m_previous;
};

} // namespace Inception
