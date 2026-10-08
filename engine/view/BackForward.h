#pragma once

#include "BackForwardClient.h"
#include "HistoryItem.h"
#include <wtf/Function.h>
#include <wtf/Vector.h>

namespace Inception {

// The session history of one page: what back, forward and history.go() walk.
// `didChange` runs whenever the current entry or the list changes, so the host
// can update its back and forward buttons.
class BackForwardList final : public WebCore::BackForwardClient {
public:
    static Ref<BackForwardList> create(Function<void()>&& didChange) { return adoptRef(*new BackForwardList(WTF::move(didChange))); }

    void addItem(Ref<WebCore::HistoryItem>&&) final;
    void setChildItem(WebCore::BackForwardFrameItemIdentifier, Ref<WebCore::HistoryItem>&&) final { }
    void goToItem(WebCore::HistoryItem&) final;
    Vector<Ref<WebCore::HistoryItem>> allItems(WebCore::FrameIdentifier) final { return m_entries; }
    RefPtr<WebCore::HistoryItem> itemAtIndex(int, WebCore::FrameIdentifier) final;
    unsigned backListCount() const final;
    unsigned forwardListCount() const final;
    bool containsItem(const WebCore::HistoryItem&) const final;
    void close() final { m_entries.clear(); }

private:
    explicit BackForwardList(Function<void()>&& didChange)
        : m_didChange(WTF::move(didChange))
    {
    }

    // Like other browsers, old entries fall off the back past this.
    static constexpr size_t capacity = 100;

    Vector<Ref<WebCore::HistoryItem>> m_entries;
    int m_current { -1 };
    Function<void()> m_didChange;
};

} // namespace Inception
