#pragma once

#include "BackForwardClient.h"
#include "HistoryItem.h"
#include <wtf/Function.h>
#include <wtf/Vector.h>

namespace Inception {

// The session history of one page: what back, forward and history.go() walk.
// `didChange` runs whenever the current entry or the list changes, so the host
// can update its back and forward buttons; `added` says a new entry was made
// (which drops those forward of it).
class BackForwardList final : public WebCore::BackForwardClient {
public:
    static Ref<BackForwardList> create(Function<void(bool added)>&& didChange) { return adoptRef(*new BackForwardList(WTF::move(didChange))); }

    void addItem(Ref<WebCore::HistoryItem>&&) final;
    void setChildItem(WebCore::BackForwardFrameItemIdentifier, Ref<WebCore::HistoryItem>&&) final { }
    void goToItem(WebCore::HistoryItem&) final;
    Vector<Ref<WebCore::HistoryItem>> allItems(WebCore::FrameIdentifier) final { return m_entries; }
    RefPtr<WebCore::HistoryItem> itemAtIndex(int, WebCore::FrameIdentifier) final;
    unsigned backListCount() const final;
    unsigned forwardListCount() const final;
    bool containsItem(const WebCore::HistoryItem&) const final;
    void close() final { m_entries.clear(); }

    const Vector<Ref<WebCore::HistoryItem>>& entries() const { return m_entries; }
    int current() const { return m_current; }

private:
    explicit BackForwardList(Function<void(bool added)>&& didChange)
        : m_didChange(WTF::move(didChange))
    {
    }

    // Like other browsers, old entries fall off the back past this.
    static constexpr size_t capacity = 100;

    Vector<Ref<WebCore::HistoryItem>> m_entries;
    int m_current { -1 };
    Function<void(bool added)> m_didChange;
};

} // namespace Inception
