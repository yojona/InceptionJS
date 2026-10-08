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
#include "view/Navigation.h"
#include "view/View.h"

namespace Inception {
using namespace WebCore;

// Most matches find counts; past it the host shows "1000+".
static constexpr unsigned maxFindMatches = 1000;

// "navigation.state": what the host's back and forward buttons show.
void emitNavigationState()
{
    auto* view = View::singleton();
    if (!view)
        return;
    auto& history = view->page().backForward();
    auto state = JSON::Object::create();
    state->setBoolean("canGoBack"_s, history.canGoBackOrForward(-1));
    state->setBoolean("canGoForward"_s, history.canGoBackOrForward(1));
    emitEvent("navigation.state"_s, WTF::move(state));
}

void registerNavigationCommands()
{
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
