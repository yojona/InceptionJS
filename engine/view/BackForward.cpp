#include "config.h"
#include "view/BackForward.h"

namespace Inception {
using namespace WebCore;

void BackForwardList::addItem(Ref<HistoryItem>&& item)
{
    // A new entry drops everything forward of the current one.
    if (m_current + 1 < static_cast<int>(m_entries.size()))
        m_entries.shrink(m_current + 1);
    m_entries.append(WTF::move(item));
    if (m_entries.size() > capacity)
        m_entries.removeAt(0);
    m_current = m_entries.size() - 1;
    m_didChange();
}

void BackForwardList::goToItem(HistoryItem& item)
{
    for (size_t i = 0; i < m_entries.size(); ++i) {
        if (m_entries[i].ptr() == &item) {
            m_current = i;
            m_didChange();
            return;
        }
    }
}

RefPtr<HistoryItem> BackForwardList::itemAtIndex(int index, FrameIdentifier)
{
    int at = m_current + index;
    if (at < 0 || at >= static_cast<int>(m_entries.size()))
        return nullptr;
    return m_entries[at].ptr();
}

unsigned BackForwardList::backListCount() const
{
    return m_current > 0 ? m_current : 0;
}

unsigned BackForwardList::forwardListCount() const
{
    return m_current < 0 ? 0 : m_entries.size() - 1 - m_current;
}

bool BackForwardList::containsItem(const HistoryItem& item) const
{
    return m_entries.containsIf([&](auto& entry) { return entry.ptr() == &item; });
}

} // namespace Inception
