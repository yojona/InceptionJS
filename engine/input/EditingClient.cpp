#include "config.h"
#include "input/EditingClient.h"

#include "Document.h"
#include "Editor.h"
#include "EventNames.h"
#include "KeyboardEvent.h"
#include "LocalFrame.h"
#include "Node.h"
#include "PlatformKeyboardEvent.h"
#include "TextChecking.h"
#include <wtf/TZoneMallocInlines.h>

namespace Inception {
using namespace WebCore;

WTF_MAKE_TZONE_ALLOCATED_IMPL(EditorClientImpl);

static constexpr size_t maximumUndoSteps = 100;

void EditorClientImpl::registerUndoStep(UndoStep& step)
{
    if (m_undoStack.size() == maximumUndoSteps)
        m_undoStack.removeAt(0);
    m_undoStack.append(step);
    if (!m_isUndoingOrRedoing)
        m_redoStack.clear();
}

void EditorClientImpl::registerRedoStep(UndoStep& step)
{
    m_redoStack.append(step);
}

void EditorClientImpl::clearUndoRedoOperations()
{
    m_undoStack.clear();
    m_redoStack.clear();
}

void EditorClientImpl::undo()
{
    if (m_undoStack.isEmpty())
        return;
    // Unapplying registers the step as redoable.
    auto step = m_undoStack.takeLast();
    SetForScope scope(m_isUndoingOrRedoing, true);
    step->unapply();
}

void EditorClientImpl::redo()
{
    if (m_redoStack.isEmpty())
        return;
    auto step = m_redoStack.takeLast();
    SetForScope scope(m_isUndoingOrRedoing, true);
    step->reapply();
}

// The command a key press performs in editable content. The "command" key is
// Meta or Ctrl, whichever the host platform uses; both are accepted.
static ASCIILiteral editingCommandForKey(const PlatformKeyboardEvent& event)
{
    const String& key = event.key();
    bool shift = event.shiftKey();
    bool command = event.metaKey() || event.controlKey();
    bool word = event.altKey();

    if (command && !word) {
        if (equalLettersIgnoringASCIICase(key, "a"_s))
            return "SelectAll"_s;
        if (equalLettersIgnoringASCIICase(key, "c"_s))
            return "Copy"_s;
        if (equalLettersIgnoringASCIICase(key, "x"_s))
            return "Cut"_s;
        if (equalLettersIgnoringASCIICase(key, "v"_s))
            return "Paste"_s;
        if (equalLettersIgnoringASCIICase(key, "z"_s))
            return shift ? "Redo"_s : "Undo"_s;
        if (equalLettersIgnoringASCIICase(key, "y"_s))
            return "Redo"_s;
    }

    if (key == "Backspace"_s)
        return word || command ? "DeleteWordBackward"_s : "DeleteBackward"_s;
    if (key == "Delete"_s)
        return word || command ? "DeleteWordForward"_s : "DeleteForward"_s;
    if (key == "ArrowLeft"_s)
        return word ? (shift ? "MoveWordLeftAndModifySelection"_s : "MoveWordLeft"_s) : (shift ? "MoveLeftAndModifySelection"_s : "MoveLeft"_s);
    if (key == "ArrowRight"_s)
        return word ? (shift ? "MoveWordRightAndModifySelection"_s : "MoveWordRight"_s) : (shift ? "MoveRightAndModifySelection"_s : "MoveRight"_s);
    if (key == "ArrowUp"_s)
        return shift ? "MoveUpAndModifySelection"_s : "MoveUp"_s;
    if (key == "ArrowDown"_s)
        return shift ? "MoveDownAndModifySelection"_s : "MoveDown"_s;
    if (key == "Home"_s)
        return shift ? "MoveToBeginningOfLineAndModifySelection"_s : "MoveToBeginningOfLine"_s;
    if (key == "End"_s)
        return shift ? "MoveToEndOfLineAndModifySelection"_s : "MoveToEndOfLine"_s;
    return { };
}

void EditorClientImpl::handleKeyboardEvent(KeyboardEvent& event)
{
    auto* platformEvent = event.underlyingPlatformEvent();
    RefPtr node = dynamicDowncast<Node>(event.target());
    RefPtr frame = node ? node->document().frame() : nullptr;
    if (!platformEvent || !frame)
        return;
    auto& editor = frame->editor();

    if (platformEvent->type() == PlatformEvent::Type::RawKeyDown) {
        auto name = editingCommandForKey(*platformEvent);
        if (name.isNull())
            return;
        auto command = editor.command(String { name });
        // Editing commands only apply where the user can edit, except the
        // clipboard and select-all, which also work on page text.
        if ((command.isTextInsertion() || editor.canEdit() || name == "Copy"_s || name == "SelectAll"_s) && command.execute(&event))
            event.setDefaultHandled();
        return;
    }

    if (platformEvent->type() != PlatformEvent::Type::Char || !editor.canEdit())
        return;
    const String& text = platformEvent->text();
    // Enter inserts a line break on the keypress, not the keydown, so text
    // fields still see the keypress and submit their form.
    if (text == "\r"_s) {
        if (editor.command("InsertNewline"_s).execute(&event))
            event.setDefaultHandled();
        return;
    }
    if (text.isEmpty() || (text.length() == 1 && text[0] < ' '))
        return;
    if (platformEvent->metaKey() || (platformEvent->controlKey() && !platformEvent->altKey()))
        return;
    if (editor.insertText(text, &event))
        event.setDefaultHandled();
}

void EditorClientImpl::requestCheckingOfString(TextCheckingRequest& request, const VisibleSelection&)
{
    request.didCancel();
}

void EditorClientImpl::requestExtendedCheckingOfString(TextCheckingRequest& request, const VisibleSelection&)
{
    request.didCancel();
}

} // namespace Inception
