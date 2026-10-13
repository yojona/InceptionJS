#include "config.h"
#include "view/Window.h"

#include "FocusController.h"
#include "Page.h"
#include "agent/Agent.h"
#include "bridge/Bridge.h"
#include "gfx/Renderer.h"
#include "view/View.h"
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>

namespace Inception {
using namespace WebCore;

unsigned Window::s_current;
unsigned Window::s_focused;

static Vector<Window*>& windows()
{
    static NeverDestroyed<Vector<Window*>> list;
    return list;
}

Window& Window::create(IntSize cssSize, float deviceScaleFactor)
{
    auto* window = new Window(cssSize, deviceScaleFactor);
    windows().append(window);
    return *window;
}

Window::Window(IntSize cssSize, float deviceScaleFactor)
    : m_cssSize(cssSize)
    , m_deviceScaleFactor(deviceScaleFactor)
{
    static unsigned lastID;
    m_id = ++lastID;
}

Window::~Window() = default;

Window* Window::byID(unsigned id)
{
    if (!id)
        return nullptr;
    for (auto* window : windows()) {
        if (window->id() == id)
            return window;
    }
    return nullptr;
}

const Vector<Window*>& Window::all()
{
    return windows();
}

Window* Window::current()
{
    return byID(s_current);
}

Vector<View*> Window::tabs() const
{
    Vector<View*> result;
    for (auto* view : View::all()) {
        if (&view->window() == this)
            result.append(view);
    }
    return result;
}

void Window::setSize(IntSize cssSize, float deviceScaleFactor)
{
    m_cssSize = cssSize;
    m_deviceScaleFactor = deviceScaleFactor;
}

void Window::setVisible(bool visible)
{
    if (visible == m_visible)
        return;
    m_visible = visible;
    if (!m_active)
        return;
    m_active->setVisible(visible);
    if (visible)
        m_active->setNeedsPaint();
}

// One window has focus at a time: focusing one takes it from the others.
void Window::setFocused(bool focused)
{
    if (focused && s_focused != m_id) {
        if (auto* previous = Window::focused()) {
            if (auto* view = previous->activeTab()) {
                auto& focus = view->page().focusController();
                focus.setActive(false);
                focus.setFocused(false);
            }
        }
        s_focused = m_id;
    } else if (!focused && s_focused == m_id)
        s_focused = 0;
}

void Window::close(unsigned id)
{
    if (id == 1 || !byID(id))
        return;
    // Script may be running in one of its tabs (window.close()).
    RunLoop::mainSingleton().dispatch([id] {
        auto* window = byID(id);
        if (!window)
            return;
        WindowScope scope(id);
        for (auto* view : window->tabs())
            View::destroy(*view);
        if (s_focused == id)
            s_focused = 0;
        Renderer::singleton().releaseSurface(id);
        Agent::windowClosed(id);
        windows().removeFirst(window);
        delete window;
        auto data = JSON::Object::create();
        data->setInteger("window"_s, id);
        emitEvent("window.closed"_s, WTF::move(data));
    });
}

WindowScope::WindowScope(unsigned windowID)
    : m_previous(Window::s_current)
{
    Window::s_current = windowID;
}

WindowScope::WindowScope(const View& view)
    : WindowScope(view.window().id())
{
}

WindowScope::~WindowScope()
{
    Window::s_current = m_previous;
}

} // namespace Inception
