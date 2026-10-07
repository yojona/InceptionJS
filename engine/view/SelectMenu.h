#pragma once

#include "PopupMenu.h"
#include "PopupMenuClient.h"
#include <wtf/CheckedPtr.h>

namespace Inception {

// The list of a <select>, drawn by the host: "select.show" carries the items
// and where the control is; the host answers with "select.choose".
class SelectMenu final : public WebCore::PopupMenu {
public:
    static Ref<SelectMenu> create(WebCore::PopupMenuClient& client) { return adoptRef(*new SelectMenu(client)); }
    ~SelectMenu();

    static void registerCommands();

private:
    explicit SelectMenu(WebCore::PopupMenuClient&);

    void show(const WebCore::IntRect&, WebCore::LocalFrameView&, int selectedIndex) final;
    void hide() final;
    void updateFromElement() final;
    void disconnectClient() final { m_client = nullptr; }

    void choose(int index);
    void sendItems(const String& event, const WebCore::IntRect*, int selectedIndex);

    CheckedPtr<WebCore::PopupMenuClient> m_client;
    unsigned m_id;
    bool m_showing { false };
};

} // namespace Inception
