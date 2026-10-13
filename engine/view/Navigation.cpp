#include "config.h"

#include "BackForwardController.h"
#include "Editor.h"
#include "FindOptions.h"
#include "FrameLoader.h"
#include "FrameLoaderTypes.h"
#include "FrameSelection.h"
#include "LocalFrame.h"
#include "LocalFrameInlines.h"
#include "Page.h"
#include "bridge/Bridge.h"
#include "view/BackForward.h"
#include "view/Navigation.h"
#include "view/SiteLock.h"
#include "view/View.h"
#include "view/Window.h"

namespace Inception {
using namespace WebCore;

// Most matches find counts; past it the host shows "1000+".
static constexpr unsigned maxFindMatches = 1000;

// "navigation.state": what the host's back and forward buttons show. A
// site-locked engine also sends its entries ({url, title}), the current one's
// index and whether it was just `added`: the host keeps the window's history
// across the engines of the sites it visits.
void emitNavigationState(bool added)
{
    auto* view = View::singleton();
    if (!view)
        return;
    auto& history = view->page().backForward();
    auto state = JSON::Object::create();
    state->setInteger("tab"_s, view->id());
    state->setBoolean("canGoBack"_s, history.canGoBackOrForward(-1));
    state->setBoolean("canGoForward"_s, history.canGoBackOrForward(1));
    if (SiteLock::active()) {
        auto& list = static_cast<BackForwardList&>(history.client());
        auto entries = JSON::Array::create();
        for (auto& item : list.entries()) {
            auto entry = JSON::Object::create();
            entry->setString("url"_s, item->url().string());
            entry->setString("title"_s, item->title());
            entries->pushObject(WTF::move(entry));
        }
        state->setArray("entries"_s, WTF::move(entries));
        state->setInteger("index"_s, list.current());
        state->setBoolean("added"_s, added);
    }
    emitEvent("navigation.state"_s, WTF::move(state));
}

// The tab a command names, if it belongs to the command's window: a window
// never acts on another window's tabs.
static View* tabOfCurrentWindow(JSON::Object& args)
{
    auto* view = View::byID(args.getInteger("tab"_s).value_or(0));
    if (!view)
        return nullptr;
    if (&view->window() != Window::current()) {
        auto data = JSON::Object::create();
        data->setString("reason"_s, "the tab belongs to another window"_s);
        emitEvent("bad-command"_s, WTF::move(data));
        return nullptr;
    }
    return view;
}

void registerNavigationCommands()
{
    // {url?, activate?} -> "tab.created" {tab}; then "tab.activated" if asked.
    registerCommand("tab.create"_s, [](JSON::Object& args) {
        auto* window = Window::current();
        if (!View::singleton() || !window)
            return;
        auto& tab = View::createTab(*window);
        auto url = args.getString("url"_s);
        if (!url.isEmpty())
            tab.load(URL { url });
        if (args.getBoolean("activate"_s).value_or(true))
            View::activate(tab.id());
    });
    // {tab}
    registerCommand("tab.activate"_s, [](JSON::Object& args) {
        if (auto* view = tabOfCurrentWindow(args))
            View::activate(view->id());
    });
    // {tab} -> "tab.closed" {tab}; a window's last tab stays.
    registerCommand("tab.close"_s, [](JSON::Object& args) {
        if (auto* view = tabOfCurrentWindow(args))
            View::close(view->id());
    });

    registerCommand("back"_s, [](JSON::Object&) {
        if (auto* view = View::singleton())
            view->page().backForward().goBack();
    });
    registerCommand("forward"_s, [](JSON::Object&) {
        if (auto* view = View::singleton())
            view->page().backForward().goForward();
    });
    // {bypassCache}
    registerCommand("reload"_s, [](JSON::Object& args) {
        auto* view = View::singleton();
        RefPtr frame = view ? view->mainFrame() : nullptr;
        if (!frame)
            return;
        OptionSet<ReloadOption> options;
        if (args.getBoolean("bypassCache"_s).value_or(false))
            options.add(ReloadOption::FromOrigin);
        frame->loader().reload(options, true);
    });
    registerCommand("stop"_s, [](JSON::Object&) {
        auto* view = View::singleton();
        if (RefPtr frame = view ? view->mainFrame() : nullptr)
            frame->loader().stopForUserCancel();
    });

    // {text, backwards, caseSensitive} -> "find.result" {text, found, matches}.
    // Repeating the same text moves to the next match; matches stay highlighted
    // until "find.clear".
    registerCommand("find"_s, [](JSON::Object& args) {
        auto* view = View::singleton();
        if (!view)
            return;
        auto& page = view->page();
        auto text = args.getString("text"_s);
        OptionSet<FindOption> options { FindOption::WrapAround };
        if (!args.getBoolean("caseSensitive"_s).value_or(false))
            options.add(FindOption::CaseInsensitive);
        if (args.getBoolean("backwards"_s).value_or(false))
            options.add(FindOption::Backwards);
        page.unmarkAllTextMatches();
        unsigned matches = text.isEmpty() ? 0 : page.markAllMatchesForText(text, options, true, maxFindMatches);
        bool found = !text.isEmpty() && page.findString(text, options).range.has_value();
        auto result = JSON::Object::create();
        result->setString("text"_s, text);
        result->setBoolean("found"_s, found);
        result->setInteger("matches"_s, matches);
        emitEvent("find.result"_s, WTF::move(result));
        view->setNeedsPaint();
    });
    registerCommand("find.clear"_s, [](JSON::Object&) {
        auto* view = View::singleton();
        if (!view)
            return;
        view->page().unmarkAllTextMatches();
        if (RefPtr frame = view->mainFrame())
            frame->selection().clear();
        view->setNeedsPaint();
    });

    // {factor}: page zoom, 1 = 100%.
    registerCommand("zoom"_s, [](JSON::Object& args) {
        auto* view = View::singleton();
        RefPtr frame = view ? view->mainFrame() : nullptr;
        if (!frame)
            return;
        float factor = std::clamp(args.getDouble("factor"_s).value_or(1), 0.25, 5.0);
        frame->setPageZoomFactor(factor);
        auto state = JSON::Object::create();
        state->setDouble("factor"_s, factor);
        emitEvent("zoom"_s, WTF::move(state));
    });
}

} // namespace Inception
