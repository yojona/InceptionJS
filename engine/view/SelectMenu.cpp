#include "config.h"
#include "view/SelectMenu.h"

#include "FontCascade.h"
#include "IntRect.h"
#include "LocalFrameView.h"
#include "PopupMenuClient.h"
#include "PopupMenuStyle.h"
#include "bridge/Bridge.h"
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>

namespace Inception {
using namespace WebCore;

static HashMap<unsigned, SelectMenu*>& menus()
{
    static NeverDestroyed<HashMap<unsigned, SelectMenu*>> menus;
    return menus;
}

SelectMenu::SelectMenu(PopupMenuClient& client, unsigned window)
    : m_client(&client)
    , m_window(window)
{
    static unsigned lastID;
    m_id = ++lastID;
    menus().add(m_id, this);
}

SelectMenu::~SelectMenu()
{
    menus().remove(m_id);
}

void SelectMenu::sendItems(const String& event, const IntRect* rect, int selectedIndex)
{
    auto data = JSON::Object::create();
    data->setInteger("id"_s, m_id);
    data->setInteger("window"_s, m_window);
    if (rect) {
        auto box = JSON::Object::create();
        box->setInteger("x"_s, rect->x());
        box->setInteger("y"_s, rect->y());
        box->setInteger("width"_s, rect->width());
        box->setInteger("height"_s, rect->height());
        data->setObject("rect"_s, WTF::move(box));
    }
    data->setInteger("selected"_s, selectedIndex);
    auto style = m_client->menuStyle();
    data->setDouble("fontSize"_s, style.font().size());
    data->setBoolean("rtl"_s, style.textDirection() == TextDirection::RTL);
    auto items = JSON::Array::create();
    for (int i = 0; i < m_client->listSize(); ++i) {
        auto item = JSON::Object::create();
        item->setString("kind"_s, m_client->itemIsSeparator(i) ? "separator"_s : m_client->itemIsLabel(i) ? "group"_s : "option"_s);
        item->setString("label"_s, m_client->itemText(i));
        item->setBoolean("disabled"_s, !m_client->itemIsEnabled(i));
        auto toolTip = m_client->itemToolTip(i);
        if (!toolTip.isEmpty())
            item->setString("title"_s, toolTip);
        items->pushObject(WTF::move(item));
    }
    data->setArray("items"_s, WTF::move(items));
    emitEvent(event, WTF::move(data));
}

void SelectMenu::show(const IntRect& rect, LocalFrameView& view, int selectedIndex)
{
    if (!m_client)
        return;
    m_showing = true;
    auto box = view.contentsToRootView(rect);
    sendItems("select.show"_s, &box, selectedIndex);
}

void SelectMenu::hide()
{
    if (!m_showing)
        return;
    m_showing = false;
    auto data = JSON::Object::create();
    data->setInteger("id"_s, m_id);
    data->setInteger("window"_s, m_window);
    emitEvent("select.hide"_s, WTF::move(data));
    if (m_client)
        m_client->popupDidHide();
}

void SelectMenu::updateFromElement()
{
    if (m_showing && m_client)
        sendItems("select.update"_s, nullptr, m_client->popupSelectedIndex());
}

// -1 when the menu was dismissed without a choice.
void SelectMenu::choose(int index)
{
    if (!m_showing)
        return;
    m_showing = false;
    Ref protectedThis { *this };
    if (!m_client)
        return;
    m_client->popupDidHide();
    if (index >= 0 && m_client && index < m_client->listSize())
        m_client->valueChanged(index);
}

void SelectMenu::registerCommands()
{
    // {id, index}
    registerCommand("select.choose"_s, [](JSON::Object& args) {
        if (auto* menu = menus().get(args.getInteger("id"_s).value_or(0)))
            menu->choose(args.getInteger("index"_s).value_or(-1));
    });
}

} // namespace Inception
