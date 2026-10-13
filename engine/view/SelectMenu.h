#pragma once

#include "PopupMenu.h"
#include "PopupMenuClient.h"
#include <wtf/CheckedPtr.h>

namespace Inception {

// The list of a <select>, drawn by the host: "select.show" carries the items
// and where the control is; the host answers with "select.choose".
class SelectMenu final : public WebCore::PopupMenu {
public:
    // `window`: where the select is, so that window's display draws the list.
    static Ref<SelectMenu> create(WebCore::PopupMenuClient& client, unsigned window) { return adoptRef(*new SelectMenu(client, window)); }
    ~SelectMenu();

    static void registerCommands();

private:
    SelectMenu(WebCore::PopupMenuClient&, unsigned window);

    void show(const WebCore::IntRect&, WebCore::LocalFrameView&, int selectedIndex) final;
    void hide() final;
    void updateFromElement() final;
    void disconnectClient() final { m_client = nullptr; }

    void choose(int index);
    void sendItems(const String& event, const WebCore::IntRect*, int selectedIndex);

    CheckedPtr<WebCore::PopupMenuClient> m_client;
    unsigned m_id;
    unsigned m_window;
    bool m_showing { false };
};

} // namespace Inception
