#include "config.h"
#include "input/Input.h"

#include "CompositionHighlight.h"
#include "CompositionUnderline.h"
#include "Editor.h"
#include "EventHandler.h"
#include "LocalFrameInlines.h"
#include "HandleUserInputEventResult.h"
#include "FocusController.h"
#include "Document.h"
#include "DocumentView.h"
#include "HitTestResult.h"
#include "HTMLAnchorElement.h"
#include "LocalFrameView.h"
#include "LocalFrame.h"
#include "Page.h"
#include "PlatformKeyboardEvent.h"
#include "PlatformMouseEvent.h"
#include "PlatformWheelEvent.h"
#include "ScrollingCoordinatorTypes.h"
#include "bridge/Bridge.h"
#include "view/View.h"
#include <wtf/MonotonicTime.h>

namespace Inception {
using namespace WebCore;

// Bit values the host sends in "modifiers".
enum ModifierBit : int { Shift = 1, Control = 2, Alt = 4, Meta = 8, CapsLock = 16 };

static OptionSet<PlatformEvent::Modifier> modifiersFrom(JSON::Object& args)
{
    int bits = args.getInteger("modifiers"_s).value_or(0);
    OptionSet<PlatformEvent::Modifier> modifiers;
    if (bits & Shift)
        modifiers.add(PlatformEvent::Modifier::ShiftKey);
    if (bits & Control)
        modifiers.add(PlatformEvent::Modifier::ControlKey);
    if (bits & Alt)
        modifiers.add(PlatformEvent::Modifier::AltKey);
    if (bits & Meta)
        modifiers.add(PlatformEvent::Modifier::MetaKey);
    if (bits & CapsLock)
        modifiers.add(PlatformEvent::Modifier::CapsLockKey);
    return modifiers;
}

static RefPtr<LocalFrame> mainFrame()
{
    auto* view = View::singleton();
    return view ? view->mainFrame() : nullptr;
}

static RefPtr<LocalFrame> focusedFrame()
{
    auto* view = View::singleton();
    RefPtr<Page> page = view ? &view->page() : nullptr;
    return page ? page->focusController().focusedOrMainFrame() : nullptr;
}

static MouseButton buttonFrom(int button)
{
    switch (button) {
    case 0:
        return MouseButton::Left;
    case 1:
        return MouseButton::Middle;
    case 2:
        return MouseButton::Right;
    default:
        return MouseButton::None;
    }
}

// The page did not take the context menu itself: tell the host what is under
// the pointer, and it shows a menu of its own ("contextmenu").
static void emitContextMenu(LocalFrame& frame, const DoublePoint& position)
{
    RefPtr view = frame.view();
    if (!view)
        return;
    auto point = view->windowToContents(flooredIntPoint(position));
    constexpr OptionSet<HitTestRequest::Type> hitType { HitTestRequest::Type::ReadOnly, HitTestRequest::Type::Active, HitTestRequest::Type::DisallowUserAgentShadowContent, HitTestRequest::Type::AllowChildFrameContent };
    auto result = frame.eventHandler().hitTestResultAtPoint(point, hitType);
    auto data = JSON::Object::create();
    data->setDouble("x"_s, position.x());
    data->setDouble("y"_s, position.y());
    if (auto link = result.absoluteLinkURL(); !link.isEmpty()) {
        data->setString("link"_s, link.string());
        data->setString("linkText"_s, result.textContent());
    }
    if (auto image = result.absoluteImageURL(); !image.isEmpty())
        data->setString("image"_s, image.string());
    if (auto media = result.absoluteMediaURL(); !media.isEmpty())
        data->setString("media"_s, media.string());
    RefPtr focused = focusedFrame();
    auto selection = focused ? focused->editor().selectedText() : String { };
    if (!selection.isEmpty())
        data->setString("selection"_s, selection);
    data->setBoolean("editable"_s, result.isContentEditable());
    if (RefPtr document = frame.document())
        data->setString("pageURL"_s, document->url().string());
    emitEvent("contextmenu"_s, WTF::move(data));
}

// {type: "down"|"up"|"move", x, y, button, clickCount, modifiers}
static void handleMouse(JSON::Object& args)
{
    RefPtr frame = mainFrame();
    if (!frame)
        return;
    auto type = args.getString("type"_s);
    DoublePoint position { args.getDouble("x"_s).value_or(0), args.getDouble("y"_s).value_or(0) };
    int clickCount = args.getInteger("clickCount"_s).value_or(0);
    auto modifiers = modifiersFrom(args);
    auto button = buttonFrom(args.getInteger("button"_s).value_or(-1));

    PlatformEvent::Type eventType = PlatformEvent::Type::MouseMoved;
    if (type == "down"_s)
        eventType = PlatformEvent::Type::MousePressed;
    else if (type == "up"_s)
        eventType = PlatformEvent::Type::MouseReleased;
    else if (type == "move"_s) {
        // A move reports the button still held, for drags and selections.
        bool pressed = args.getBoolean("pressed"_s).value_or(false);
        button = pressed ? buttonFrom(args.getInteger("button"_s).value_or(0)) : MouseButton::None;
    }

    PlatformMouseEvent event(position, position, button, eventType, clickCount, modifiers, MonotonicTime::now(), 0, SyntheticClickType::NoTap);
    auto& handler = frame->eventHandler();
    switch (eventType) {
    case PlatformEvent::Type::MousePressed:
        handler.handleMousePressEvent(event);
        // As on macOS and Linux, the context menu follows the press; a page
        // that handles "contextmenu" itself keeps the host's menu away.
        if (button == MouseButton::Right && !handler.sendContextMenuEvent(event))
            emitContextMenu(*frame, position);
        break;
    case PlatformEvent::Type::MouseReleased:
        handler.handleMouseReleaseEvent(event);
        break;
    default:
        handler.mouseMoved(event);
        break;
    }
}

// {x, y, deltaX, deltaY, deltaMode, modifiers}, deltas as in DOM WheelEvent
// (positive Y scrolls down).
static void handleWheel(JSON::Object& args)
{
    RefPtr frame = mainFrame();
    if (!frame)
        return;
    IntPoint position { static_cast<int>(args.getDouble("x"_s).value_or(0)), static_cast<int>(args.getDouble("y"_s).value_or(0)) };
    float deltaX = args.getDouble("deltaX"_s).value_or(0);
    float deltaY = args.getDouble("deltaY"_s).value_or(0);
    // Lines and pages arrive in their own units; WebCore wants pixels.
    switch (args.getInteger("deltaMode"_s).value_or(0)) {
    case 1:
        deltaX *= 40;
        deltaY *= 40;
        break;
    case 2:
        deltaX *= View::singleton()->cssSize().width();
        deltaY *= View::singleton()->cssSize().height();
        break;
    default:
        break;
    }
    auto modifiers = modifiersFrom(args);
    // WebCore's wheel deltas point the other way from DOM's.
    PlatformWheelEvent event(position, position, -deltaX, -deltaY, -deltaX / 40, -deltaY / 40, PlatformWheelEventGranularity::ScrollByPixelWheelEvent,
        modifiers.contains(PlatformEvent::Modifier::ShiftKey), modifiers.contains(PlatformEvent::Modifier::ControlKey),
        modifiers.contains(PlatformEvent::Modifier::AltKey), modifiers.contains(PlatformEvent::Modifier::MetaKey));
    frame->eventHandler().handleWheelEvent(event, { WheelEventProcessingSteps::SynchronousScrolling, WheelEventProcessingSteps::BlockingDOMEventDispatch });
}

// {type: "down"|"up", key, code, keyCode, text, repeat, modifiers}, from DOM
// KeyboardEvent. A keydown becomes WebCore's RawKeyDown followed, when it
// produces text, by a Char (the keypress).
static void handleKey(JSON::Object& args)
{
    RefPtr frame = mainFrame();
    if (!frame)
        return;
    auto type = args.getString("type"_s);
    auto key = args.getString("key"_s);
    auto code = args.getString("code"_s);
    auto text = args.getString("text"_s);
    int keyCode = args.getInteger("keyCode"_s).value_or(0);
    bool repeat = args.getBoolean("repeat"_s).value_or(false);
    bool keypad = code.startsWith("Numpad"_s);
    auto modifiers = modifiersFrom(args);
    PlatformKeyboardEvent::setCurrentModifierState(modifiers);

    auto& handler = frame->eventHandler();
    if (type == "up"_s) {
        PlatformKeyboardEvent event(PlatformEvent::Type::KeyUp, text, text, key, code, { }, keyCode, repeat, keypad, false, modifiers, MonotonicTime::now());
        handler.keyEvent(event);
        return;
    }

    PlatformKeyboardEvent event(PlatformEvent::Type::KeyDown, text, text, key, code, { }, keyCode, repeat, keypad, false, modifiers, MonotonicTime::now());
    auto rawKeyDown = event;
    rawKeyDown.disambiguateKeyDownEvent(PlatformEvent::Type::RawKeyDown);
    bool handled = handler.keyEvent(rawKeyDown);
    if (handled || text.isEmpty())
        return;
    auto charEvent = event;
    charEvent.disambiguateKeyDownEvent(PlatformEvent::Type::Char);
    handler.keyEvent(charEvent);
}

// {focused: bool}: the view gained or lost focus in the host page.
static void handleFocus(JSON::Object& args)
{
    auto* view = View::singleton();
    if (!view)
        return;
    bool focused = args.getBoolean("focused"_s).value_or(false);
    auto& focus = view->page().focusController();
    focus.setActive(focused);
    focus.setFocused(focused);
    if (focused && !focus.focusedFrame()) {
        if (RefPtr frame = mainFrame())
            focus.setFocusedFrame(frame.get());
    }
}

void registerInputCommands()
{
    // Text from the host's input method: dead keys, accents, IME. "ime.set"
    // {text, selectionStart, selectionEnd} shows a composition in progress,
    // "ime.commit" {text} ends it with its final text (or inserts text when
    // nothing was being composed), "ime.cancel" drops it.
    registerCommand("ime.set"_s, [](JSON::Object& args) {
        RefPtr frame = focusedFrame();
        if (!frame)
            return;
        auto text = args.getString("text"_s);
        unsigned start = args.getInteger("selectionStart"_s).value_or(text.length());
        unsigned end = args.getInteger("selectionEnd"_s).value_or(start);
        Vector<CompositionUnderline> underlines { CompositionUnderline { 0, text.length(), CompositionUnderlineColor::TextColor, Color::black, false } };
        frame->editor().setComposition(text, underlines, { }, { }, start, end);
    });
    registerCommand("ime.commit"_s, [](JSON::Object& args) {
        if (RefPtr frame = focusedFrame())
            frame->editor().confirmComposition(args.getString("text"_s));
    });
    registerCommand("ime.cancel"_s, [](JSON::Object&) {
        if (RefPtr frame = focusedFrame())
            frame->editor().cancelComposition();
    });

    // {command}: an editing command on the focused frame, e.g. "Paste" once
    // the host has delivered its clipboard.
    registerCommand("edit"_s, [](JSON::Object& args) {
        if (RefPtr frame = focusedFrame())
            frame->editor().command(args.getString("command"_s)).execute();
    });

    registerCommand("mouse"_s, handleMouse);
    registerCommand("wheel"_s, handleWheel);
    registerCommand("key"_s, handleKey);
    registerCommand("focus"_s, handleFocus);
}

} // namespace Inception
