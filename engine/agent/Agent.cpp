#include "config.h"
#include "agent/Agent.h"

#include "AXObjectCache.h"
#include "AXUtilities.h"
#include "AccessibilityObject.h"
#include "ContainerNodeInlines.h"
#include "DocumentInlines.h"
#include "DocumentPage.h"
#include "DocumentView.h"
#include "Editor.h"
#include "ElementInlines.h"
#include "EventHandler.h"
#include "FocusController.h"
#include "FormState.h"
#include "FrameDestructionObserverInlines.h"
#include "FrameLoader.h"
#include "HTMLAnchorElement.h"
#include "HTMLCollection.h"
#include "HTMLFormElement.h"
#include "HTMLInputElement.h"
#include "HTMLLabelElement.h"
#include "HTMLNames.h"
#include "HTMLOptionElement.h"
#include "HTMLSelectElement.h"
#include "HTMLTableElement.h"
#include "HTMLTableRowElement.h"
#include "HTMLTextAreaElement.h"
#include "HitTestResult.h"
#include "LocalFrame.h"
#include "LocalFrameInlines.h"
#include "LocalFrameView.h"
#include "NavigationAction.h"
#include "NodeInlines.h"
#include "Page.h"
#include "ResourceRequest.h"
#include "TypedElementDescendantIteratorInlines.h"
#include "bridge/Bridge.h"
#include "input/Input.h"
#include "net/NetworkLoad.h"
#include "view/View.h"
#include <wtf/HashSet.h>
#include <wtf/MonotonicTime.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringBuilder.h>
#include <wtf/text/StringToIntegerConversion.h>
#include <unicode/uchar.h>
#include <unicode/utf16.h>
#include <wtf/unicode/CharacterNames.h>

namespace Inception::Agent {
using namespace WebCore;

// What one snapshot may carry; the host can ask for fewer nodes.
static constexpr unsigned defaultMaxNodes = 3000;
static constexpr unsigned maxMaxNodes = 20000;
static constexpr unsigned maxDepth = 200;
static constexpr unsigned maxNameLength = 300;
static constexpr unsigned maxTextLength = 2000;
static constexpr unsigned maxValueLength = 1000;
static constexpr unsigned defaultExtractLength = 100000;
// Refs issued before the set is cleared; older ones then read as unknown.
static constexpr unsigned maxIssuedRefs = 500000;
// How long the risks approved for an action stay approved: long enough for
// what the action sets off (a submit a script runs after a delay), and no
// longer, so a later script cannot ride on an old approval.
static constexpr Seconds approvalLifetime = 10_s;

struct State {
    bool agentInControl { false };
    HashSet<String> approved;
    MonotonicTime approvedUntil;
    HashSet<uint64_t> issued;
};

static State& state()
{
    static NeverDestroyed<State> instance;
    return instance;
}

static void reply(int id, Ref<JSON::Object>&& result)
{
    result->setInteger("id"_s, id);
    emitEvent("agent.result"_s, WTF::move(result));
}

static Ref<JSON::Object> failure(ASCIILiteral code, const String& message)
{
    auto error = JSON::Object::create();
    error->setString("code"_s, code);
    error->setString("message"_s, message);
    auto result = JSON::Object::create();
    result->setObject("error"_s, WTF::move(error));
    return result;
}

static void fail(int id, ASCIILiteral code, const String& message)
{
    reply(id, failure(code, message));
}

// Whitespace runs become one space; the result is trimmed and capped.
static String clean(const String& text, unsigned limit)
{
    if (text.isEmpty())
        return text;
    StringBuilder builder;
    bool pendingSpace = false;
    for (unsigned i = 0; i < text.length(); ++i) {
        char16_t c = text[i];
        if (isASCIIWhitespace(c) || c == noBreakSpace) {
            pendingSpace = !builder.isEmpty();
            continue;
        }
        if (builder.length() >= limit) {
            builder.append(horizontalEllipsis);
            break;
        }
        if (pendingSpace) {
            builder.append(' ');
            pendingSpace = false;
        }
        builder.append(c);
    }
    return builder.toString();
}

// `name` without `part` (a field's own value or placeholder, which the
// accessible name of a field inside its label repeats) and without bullets.
static String without(const String& name, const String& part)
{
    auto result = part.isEmpty() ? name : makeStringByReplacingAll(name, part, emptyString());
    StringBuilder builder;
    for (unsigned i = 0; i < result.length(); ++i) {
        if (result[i] != bullet && result[i] != blackCircle)
            builder.append(result[i]);
    }
    return clean(builder.toString(), maxNameLength);
}

// --- refs -------------------------------------------------------------------
// A ref is the engine's own identity for a DOM node, so it survives
// re-snapshots and changes around the node. Only refs a snapshot or an extract
// handed out are accepted.

static String refFor(Node& node)
{
    auto id = node.nodeIdentifier().toRawValue();
    auto& issued = state().issued;
    if (issued.size() >= maxIssuedRefs)
        issued.clear();
    issued.add(id);
    return makeString('e', id);
}

static RefPtr<Node> resolve(const String& ref, ASCIILiteral& error)
{
    auto raw = ref.startsWith('e') ? parseInteger<uint64_t>(StringView(ref).substring(1)) : std::nullopt;
    if (!raw || !NodeIdentifier::isValidIdentifier(*raw) || !state().issued.contains(*raw)) {
        error = "no_such_ref"_s;
        return nullptr;
    }
    RefPtr node = Node::fromIdentifier(NodeIdentifier { *raw });
    auto* view = View::singleton();
    if (!node || !node->isConnected() || !view || node->document().page() != &view->page()) {
        error = "stale_ref"_s;
        return nullptr;
    }
    return node;
}

static RefPtr<Element> elementFor(Node& node)
{
    if (RefPtr element = dynamicDowncast<Element>(node))
        return element;
    return node.parentElement();
}

// --- fields and risk ---------------------------------------------------------

enum class Field : uint8_t { None, Password, Payment };

static ASCIILiteral fieldName(Field field)
{
    switch (field) {
    case Field::Password:
        return "password"_s;
    case Field::Payment:
        return "payment"_s;
    case Field::None:
        break;
    }
    return { };
}

static bool mentionsPayment(const String& text)
{
    for (auto word : { "cc-"_s, "card"_s, "cvv"_s, "cvc"_s, "csc"_s, "securitycode"_s, "security-code"_s, "security code"_s, "expir"_s, "iban"_s }) {
        if (text.containsIgnoringASCIICase(word))
            return true;
    }
    return false;
}

// Password and payment fields: the agent types into them only with the
// embedder's approval, and never reads their values back.
static Field fieldKind(const Element& element)
{
    RefPtr input = dynamicDowncast<HTMLInputElement>(element);
    if (input && input->isPasswordField())
        return Field::Password;
    if (!input && !is<HTMLTextAreaElement>(element) && !is<HTMLSelectElement>(element))
        return Field::None;
    String autocomplete = element.attributeWithoutSynchronization(HTMLNames::autocompleteAttr);
    if (autocomplete.containsIgnoringASCIICase("password"_s) || autocomplete.containsIgnoringASCIICase("one-time-code"_s))
        return Field::Password;
    if (autocomplete.containsIgnoringASCIICase("cc-"_s))
        return Field::Payment;
    if (input && !input->isTextField())
        return Field::None;
    auto mentions = [&](const QualifiedName& attribute) {
        return mentionsPayment(element.attributeWithoutSynchronization(attribute));
    };
    if (mentions(HTMLNames::nameAttr) || mentions(HTMLNames::idAttr) || mentions(HTMLNames::placeholderAttr) || mentions(HTMLNames::aria_labelAttr))
        return Field::Payment;
    return Field::None;
}

// What submitting `form` risks: payment or login when it carries such fields,
// a plain navigation for GET, a submission otherwise.
static ASCIILiteral formRisk(HTMLFormElement& form)
{
    bool password = false;
    bool payment = false;
    for (auto& listed : form.copyListedElementsVector()) {
        auto kind = fieldKind(listed->asHTMLElement());
        password |= kind == Field::Password;
        payment |= kind == Field::Payment;
    }
    if (payment)
        return "payment"_s;
    if (password)
        return "login"_s;
    return form.isMethodPost() ? "submit"_s : "navigate"_s;
}

// A password or payment field with something in it anywhere in the page: a
// click may send it, so the host weighs any click there at that risk.
static Field filledSecrets(Document& document)
{
    Field found = Field::None;
    for (auto& input : descendantsOfType<HTMLInputElement>(document)) {
        if (input.value()->isEmpty())
            continue;
        auto kind = fieldKind(input);
        if (kind == Field::Payment)
            return kind;
        if (kind == Field::Password)
            found = kind;
    }
    return found;
}

static bool approved(StringView risk)
{
    auto& current = state();
    return MonotonicTime::now() < current.approvedUntil && current.approved.contains(risk.toString());
}

static void emitBlocked(ASCIILiteral action, ASCIILiteral risk, const URL& url)
{
    auto data = JSON::Object::create();
    data->setString("action"_s, action);
    data->setString("risk"_s, risk);
    data->setString("url"_s, url.string());
    emitEvent("agent.blocked"_s, WTF::move(data));
}

bool allowsNavigation(const NavigationAction& action, const ResourceRequest& request, FormState* formState)
{
    if (!state().agentInControl || !formState)
        return true;
    if (action.type() != NavigationType::FormSubmitted && action.type() != NavigationType::FormResubmitted)
        return true;
    auto risk = formRisk(formState->form());
    if (risk == "navigate"_s || approved(risk))
        return true;
    emitBlocked("submit"_s, risk, request.url());
    return false;
}

bool allowsDownload(const URL& url)
{
    if (!state().agentInControl || approved("download"_s))
        return true;
    emitBlocked("download"_s, "download"_s, url);
    return false;
}

// --- snapshot ---------------------------------------------------------------

// Containers that only group or style: without a name of their own they are
// left out and their children take their place.
static bool isTransparent(AccessibilityRole role)
{
    switch (role) {
    case AccessibilityRole::Code:
    case AccessibilityRole::Deletion:
    case AccessibilityRole::Emphasis:
    case AccessibilityRole::FrameHost:
    case AccessibilityRole::Generic:
    case AccessibilityRole::Group:
    case AccessibilityRole::Ignored:
    case AccessibilityRole::Inline:
    case AccessibilityRole::Insertion:
    case AccessibilityRole::Label:
    case AccessibilityRole::LocalFrame:
    case AccessibilityRole::Mark:
    case AccessibilityRole::Paragraph:
    case AccessibilityRole::Presentational:
    case AccessibilityRole::RubyInline:
    case AccessibilityRole::ScrollArea:
    case AccessibilityRole::Strong:
    case AccessibilityRole::Subscript:
    case AccessibilityRole::Superscript:
    case AccessibilityRole::SVGRoot:
    case AccessibilityRole::TextGroup:
    case AccessibilityRole::Time:
    case AccessibilityRole::Unknown:
        return true;
    default:
        return false;
    }
}

// Parts of controls and decorations an agent never needs.
static bool isOmitted(AccessibilityRole role)
{
    switch (role) {
    case AccessibilityRole::Column:
    case AccessibilityRole::LineBreak:
    case AccessibilityRole::ListMarker:
    case AccessibilityRole::MenuListPopup:
    case AccessibilityRole::ScrollBar:
    case AccessibilityRole::SliderThumb:
    case AccessibilityRole::SpinButtonPart:
    // Tables also expose their columns and header row again, as extra parents
    // of the same cells.
    case AccessibilityRole::TableHeaderContainer:
        return true;
    default:
        return false;
    }
}

static bool isInteractive(AccessibilityObject& object)
{
    switch (object.role()) {
    case AccessibilityRole::Button:
    case AccessibilityRole::Checkbox:
    case AccessibilityRole::ColorWell:
    case AccessibilityRole::ComboBox:
    case AccessibilityRole::DateTime:
    case AccessibilityRole::Link:
    case AccessibilityRole::ListBox:
    case AccessibilityRole::ListBoxOption:
    case AccessibilityRole::MenuItem:
    case AccessibilityRole::MenuItemCheckbox:
    case AccessibilityRole::MenuItemRadio:
    case AccessibilityRole::MenuListOption:
    case AccessibilityRole::PopUpButton:
    case AccessibilityRole::RadioButton:
    case AccessibilityRole::SearchField:
    case AccessibilityRole::Slider:
    case AccessibilityRole::SpinButton:
    case AccessibilityRole::Summary:
    case AccessibilityRole::Switch:
    case AccessibilityRole::Tab:
    case AccessibilityRole::TextArea:
    case AccessibilityRole::TextField:
    case AccessibilityRole::ToggleButton:
    case AccessibilityRole::TreeItem:
        return true;
    case AccessibilityRole::WebArea:
        return false;
    default:
        return object.canSetFocusAttribute();
    }
}

static String roleName(AccessibilityObject& object)
{
    switch (object.role()) {
    case AccessibilityRole::StaticText:
        return "text"_s;
    case AccessibilityRole::WebArea:
        return "document"_s;
    case AccessibilityRole::PopUpButton:
        return "combobox"_s;
    default:
        break;
    }
    auto role = object.computedRoleString();
    if (!role.isEmpty())
        return role;
    return roleToString(object.role()).convertToASCIILowercase();
}

static bool hasValue(AccessibilityRole role)
{
    switch (role) {
    case AccessibilityRole::ColorWell:
    case AccessibilityRole::ComboBox:
    case AccessibilityRole::DateTime:
    case AccessibilityRole::Meter:
    case AccessibilityRole::PopUpButton:
    case AccessibilityRole::ProgressIndicator:
    case AccessibilityRole::SearchField:
    case AccessibilityRole::Slider:
    case AccessibilityRole::SpinButton:
    case AccessibilityRole::TextArea:
    case AccessibilityRole::TextField:
        return true;
    default:
        return false;
    }
}

static bool hasSelectedState(AccessibilityRole role)
{
    switch (role) {
    case AccessibilityRole::GridCell:
    case AccessibilityRole::ListBoxOption:
    case AccessibilityRole::MenuListOption:
    case AccessibilityRole::Row:
    case AccessibilityRole::Tab:
    case AccessibilityRole::TreeItem:
        return true;
    default:
        return false;
    }
}

static IntRect boundsOf(AccessibilityObject& object)
{
    RefPtr frameView = object.documentFrameView();
    if (!frameView)
        return { };
    return frameView->contentsToRootView(snappedIntRect(object.elementRect()));
}

class Snapshot {
public:
    Snapshot(unsigned maxNodes, IntPoint scroll)
        : m_maxNodes(maxNodes)
        , m_scroll(scroll)
    {
    }

    unsigned count() const { return m_count; }
    bool truncated() const { return m_truncated; }

    // Appends what `object` contributes to `out`: its own node, or, for a
    // transparent container, its children.
    void add(AccessibilityObject& object, JSON::Array& out, unsigned depth)
    {
        if (m_count >= m_maxNodes) {
            m_truncated = true;
            return;
        }
        auto role = object.role();
        if (depth > maxDepth || isOmitted(role))
            return;
        bool interactive = isInteractive(object);
        auto name = nameOf(object);
        if (role == AccessibilityRole::ScrollArea || (isTransparent(role) && name.isEmpty() && !interactive)) {
            addChildren(object, out, depth);
            return;
        }

        auto node = JSON::Object::create();
        ++m_count;
        if (RefPtr domNode = object.node())
            node->setString("ref"_s, refFor(*domNode));
        node->setString("role"_s, roleName(object));
        if (interactive)
            node->setBoolean("interactive"_s, true);

        RefPtr element = object.element();
        auto field = element ? fieldKind(*element) : Field::None;
        if (field != Field::None)
            node->setString("field"_s, fieldName(field));
        auto states = JSON::Array::create();
        bool valued = false;
        if (field != Field::None) {
            // Neither the value nor its masked form may reach the agent.
            RefPtr input = dynamicDowncast<HTMLInputElement>(element.get());
            String raw = input ? static_cast<const String&>(input->value()) : object.stringValue();
            if (!raw.isEmpty())
                states->pushString("filled"_s);
            name = without(without(name, raw), object.stringValue());
        } else if (hasValue(role)) {
            auto value = role == AccessibilityRole::Slider || role == AccessibilityRole::Meter || role == AccessibilityRole::ProgressIndicator
                ? String::number(object.valueForRange())
                : clean(object.stringValue(), maxValueLength);
            valued = !value.isEmpty();
            if (valued) {
                node->setString("value"_s, value);
                name = without(name, value);
            }
        }
        if ((role == AccessibilityRole::TextField || role == AccessibilityRole::TextArea || role == AccessibilityRole::SearchField) && !valued) {
            auto placeholder = clean(object.placeholderValue(), maxNameLength);
            if (!placeholder.isEmpty() && placeholder != name) {
                node->setString("placeholder"_s, placeholder);
                name = without(name, placeholder);
            }
        }
        if (!name.isEmpty())
            node->setString("name"_s, name);
        if (role == AccessibilityRole::Heading) {
            if (unsigned level = object.headingLevel())
                node->setInteger("level"_s, level);
        }
        if (role == AccessibilityRole::Link) {
            auto url = object.url();
            if (!url.isEmpty())
                node->setString("href"_s, url.string());
        }

        if (interactive && !object.isEnabled())
            states->pushString("disabled"_s);
        if (object.supportsCheckedState()) {
            switch (object.checkboxOrRadioValue()) {
            case AccessibilityButtonState::On:
                states->pushString("checked"_s);
                break;
            case AccessibilityButtonState::Mixed:
                states->pushString("mixed"_s);
                break;
            case AccessibilityButtonState::Off:
                states->pushString("unchecked"_s);
                break;
            }
        }
        if (object.supportsExpanded())
            states->pushString(object.isExpanded() ? "expanded"_s : "collapsed"_s);
        if (object.supportsPressed() && object.isPressed())
            states->pushString("pressed"_s);
        if (hasSelectedState(role) && object.isSelected())
            states->pushString("selected"_s);
        if (interactive && object.isRequired())
            states->pushString("required"_s);
        if (object.isFocused())
            states->pushString("focused"_s);

        auto bounds = boundsOf(object);
        // Text placed off the page's left or top edge is a common way to hide
        // it from people while machines still read it.
        if (role == AccessibilityRole::StaticText && (bounds.maxX() + m_scroll.x() <= 0 || bounds.maxY() + m_scroll.y() <= 0))
            states->pushString("offpage"_s);
        if (states->length())
            node->setArray("states"_s, WTF::move(states));
        auto box = JSON::Array::create();
        box->pushInteger(bounds.x());
        box->pushInteger(bounds.y());
        box->pushInteger(bounds.width());
        box->pushInteger(bounds.height());
        node->setArray("box"_s, WTF::move(box));

        if (role != AccessibilityRole::StaticText) {
            auto children = JSON::Array::create();
            addChildren(object, children, depth + 1);
            auto tidied = tidy(children, name);
            // An unnamed node with one line of text (a cell, a list item) reads
            // as that text.
            RefPtr only = tidied->length() == 1 ? tidied->get(0)->asObject() : nullptr;
            if (name.isEmpty() && !interactive && only && only->getString("role"_s) == "text"_s && !only->getArray("states"_s))
                node->setString("name"_s, only->getString("name"_s));
            else if (tidied->length())
                node->setArray("children"_s, WTF::move(tidied));
        }
        out.pushObject(WTF::move(node));
    }

private:
    void addChildren(AccessibilityObject& object, JSON::Array& out, unsigned depth)
    {
        auto children = object.unignoredChildren();
        for (auto& child : children) {
            if (RefPtr childObject = dynamicDowncast<AccessibilityObject>(child.get()))
                add(*childObject, out, depth);
        }
    }

    static String nameOf(AccessibilityObject& object)
    {
        switch (object.role()) {
        case AccessibilityRole::StaticText:
            return clean(object.stringValue(), maxTextLength);
        case AccessibilityRole::WebArea:
            if (RefPtr document = object.document())
                return clean(document->title(), maxNameLength);
            return { };
        default:
            return clean(object.computedLabel(), maxNameLength);
        }
    }

    // Adjacent text runs (split by inline elements that were left out) become
    // one, and text that only repeats its parent's name is dropped.
    static bool sameLine(JSON::Object& a, JSON::Object& b)
    {
        auto span = [](JSON::Object& node) -> std::pair<int, int> {
            auto box = node.getArray("box"_s);
            if (!box || box->length() < 4)
                return { 0, 0 };
            int y = box->get(1)->asInteger().value_or(0);
            return { y, y + box->get(3)->asInteger().value_or(0) };
        };
        auto [top, bottom] = span(a);
        auto [otherTop, otherBottom] = span(b);
        int overlap = std::min(bottom, otherBottom) - std::max(top, otherTop);
        return overlap > std::min(bottom - top, otherBottom - otherTop) / 2;
    }

    static Ref<JSON::Array> tidy(JSON::Array& items, const String& parentName)
    {
        auto result = JSON::Array::create();
        RefPtr<JSON::Object> previousText;
        for (size_t i = 0; i < items.length(); ++i) {
            RefPtr item = items.get(i)->asObject();
            if (!item)
                continue;
            bool isText = item->getString("role"_s) == "text"_s && !item->getArray("states"_s);
            if (!isText) {
                previousText = nullptr;
                result->pushObject(item.releaseNonNull());
                continue;
            }
            auto text = item->getString("name"_s);
            if (!parentName.isEmpty() && parentName.contains(text))
                continue;
            if (previousText && sameLine(*previousText, *item)) {
                auto joined = previousText->getString("name"_s);
                bool glued = text.isEmpty() || u_ispunct(text[0]);
                previousText->setString("name"_s, glued ? makeString(joined, text) : makeString(joined, ' ', text));
                continue;
            }
            previousText = item;
            result->pushObject(item.releaseNonNull());
        }
        return result;
    }

    unsigned m_maxNodes;
    IntPoint m_scroll;
    unsigned m_count { 0 };
    bool m_truncated { false };
};

static RefPtr<LocalFrame> activeMainFrame()
{
    auto* view = View::singleton();
    return view ? view->mainFrame() : nullptr;
}

// {id, maxNodes?} -> {url, title, viewport, nodes, count, truncated}
static void snapshot(int id, JSON::Object& args)
{
    RefPtr frame = activeMainFrame();
    RefPtr document = frame ? frame->document() : nullptr;
    RefPtr frameView = frame ? frame->view() : nullptr;
    if (!document || !frameView)
        return fail(id, "not_ready"_s, "no page is loaded"_s);

    // Off until an agent first looks: building and updating the tree costs.
    AXObjectCache::enableAccessibility();
    document->updateLayoutIgnorePendingStylesheets();
    CheckedPtr cache = document->axObjectCache();
    if (!cache)
        return fail(id, "not_ready"_s, "the page has no accessibility tree yet"_s);
    cache->performDeferredCacheUpdate(ForceLayout::Yes);
    RefPtr root = dynamicDowncast<AccessibilityObject>(cache->rootObjectForFrame(*frame));
    if (!root)
        return fail(id, "not_ready"_s, "the page has no accessibility tree yet"_s);

    unsigned maxNodes = std::clamp<int>(args.getInteger("maxNodes"_s).value_or(defaultMaxNodes), 1, maxMaxNodes);
    auto scroll = frameView->scrollPosition();
    Snapshot builder(maxNodes, scroll);
    auto nodes = JSON::Array::create();
    builder.add(*root, nodes, 0);

    auto result = JSON::Object::create();
    result->setString("url"_s, document->url().string());
    result->setString("title"_s, clean(document->title(), maxNameLength));
    auto viewport = JSON::Object::create();
    viewport->setInteger("width"_s, View::singleton()->cssSize().width());
    viewport->setInteger("height"_s, View::singleton()->cssSize().height());
    viewport->setInteger("scrollX"_s, scroll.x());
    viewport->setInteger("scrollY"_s, scroll.y());
    result->setObject("viewport"_s, WTF::move(viewport));
    result->setArray("nodes"_s, WTF::move(nodes));
    result->setInteger("count"_s, builder.count());
    result->setBoolean("truncated"_s, builder.truncated());
    reply(id, WTF::move(result));
}

// --- describe ---------------------------------------------------------------

static RefPtr<Element> focusedElement()
{
    auto* view = View::singleton();
    RefPtr frame = view ? view->page().focusController().focusedOrMainFrame() : nullptr;
    RefPtr document = frame ? frame->document() : nullptr;
    return document ? document->focusedElement() : nullptr;
}

static bool isEditable(Element& element)
{
    bool readOnly = element.hasAttributeWithoutSynchronization(HTMLNames::readonlyAttr);
    if (RefPtr input = dynamicDowncast<HTMLInputElement>(element))
        return input->isTextField() && !input->isDisabledFormControl() && !readOnly;
    if (RefPtr textArea = dynamicDowncast<HTMLTextAreaElement>(element))
        return !textArea->isDisabledFormControl() && !readOnly;
    return element.hasEditableStyle();
}

static RefPtr<HTMLFormElement> formOf(Element& element)
{
    if (RefPtr control = dynamicDowncast<HTMLFormControlElement>(element))
        return control->form();
    return nullptr;
}

// What the host needs to weigh an action's risk before it asks the policy:
// {ref, tag, field, link, download, submits, formRisk, editable, secrets}.
static Ref<JSON::Object> describe(Element& element)
{
    auto result = JSON::Object::create();
    result->setString("ref"_s, refFor(element));
    result->setString("tag"_s, element.localName().convertToASCIILowercase());
    if (auto field = fieldKind(element); field != Field::None)
        result->setString("field"_s, fieldName(field));
    for (RefPtr<Element> ancestor = &element; ancestor; ancestor = ancestor->parentElement()) {
        if (RefPtr anchor = dynamicDowncast<HTMLAnchorElement>(*ancestor)) {
            auto href = anchor->href();
            if (!href.isEmpty()) {
                result->setString("link"_s, href.string());
                result->setBoolean("download"_s, anchor->hasAttributeWithoutSynchronization(HTMLNames::downloadAttr));
            }
            break;
        }
    }
    RefPtr control = dynamicDowncast<HTMLFormControlElement>(element);
    bool submits = control && control->isSubmitButton() && formOf(element);
    result->setBoolean("submits"_s, submits);
    if (RefPtr form = formOf(element))
        result->setString("formRisk"_s, formRisk(*form));
    result->setBoolean("editable"_s, isEditable(element));
    if (auto secrets = filledSecrets(element.document()); secrets != Field::None)
        result->setString("secrets"_s, fieldName(secrets));
    return result;
}

// --- input ------------------------------------------------------------------

static void mouse(ASCIILiteral type, IntPoint point)
{
    auto args = JSON::Object::create();
    args->setString("type"_s, type);
    args->setDouble("x"_s, point.x());
    args->setDouble("y"_s, point.y());
    if (type != "move"_s) {
        args->setInteger("button"_s, 0);
        args->setInteger("clickCount"_s, 1);
    }
    dispatchMouse(args.get());
}

static void click(IntPoint point)
{
    mouse("move"_s, point);
    mouse("down"_s, point);
    mouse("up"_s, point);
}

static void key(ASCIILiteral type, const String& name, const String& code, int keyCode, const String& text, int modifiers)
{
    auto args = JSON::Object::create();
    args->setString("type"_s, type);
    args->setString("key"_s, name);
    args->setString("code"_s, code);
    args->setInteger("keyCode"_s, keyCode);
    args->setString("text"_s, text);
    args->setInteger("modifiers"_s, modifiers);
    dispatchKey(args.get());
}

struct NamedKey {
    ASCIILiteral name;
    ASCIILiteral code;
    int keyCode;
    ASCIILiteral text;
};

static const NamedKey* namedKey(const String& name)
{
    static const NamedKey keys[] = {
        { "Enter"_s, "Enter"_s, 13, "\r"_s },
        { "Tab"_s, "Tab"_s, 9, ""_s },
        { "Escape"_s, "Escape"_s, 27, ""_s },
        { "Backspace"_s, "Backspace"_s, 8, ""_s },
        { "Delete"_s, "Delete"_s, 46, ""_s },
        { "Insert"_s, "Insert"_s, 45, ""_s },
        { "ArrowLeft"_s, "ArrowLeft"_s, 37, ""_s },
        { "ArrowUp"_s, "ArrowUp"_s, 38, ""_s },
        { "ArrowRight"_s, "ArrowRight"_s, 39, ""_s },
        { "ArrowDown"_s, "ArrowDown"_s, 40, ""_s },
        { "Home"_s, "Home"_s, 36, ""_s },
        { "End"_s, "End"_s, 35, ""_s },
        { "PageUp"_s, "PageUp"_s, 33, ""_s },
        { "PageDown"_s, "PageDown"_s, 34, ""_s },
        { "F1"_s, "F1"_s, 112, ""_s }, { "F2"_s, "F2"_s, 113, ""_s }, { "F3"_s, "F3"_s, 114, ""_s },
        { "F4"_s, "F4"_s, 115, ""_s }, { "F5"_s, "F5"_s, 116, ""_s }, { "F6"_s, "F6"_s, 117, ""_s },
        { "F7"_s, "F7"_s, 118, ""_s }, { "F8"_s, "F8"_s, 119, ""_s }, { "F9"_s, "F9"_s, 120, ""_s },
        { "F10"_s, "F10"_s, 121, ""_s }, { "F11"_s, "F11"_s, 122, ""_s }, { "F12"_s, "F12"_s, 123, ""_s },
    };
    for (auto& key : keys) {
        if (equalIgnoringASCIICase(name, key.name))
            return &key;
    }
    return nullptr;
}

// One key, by DOM key name ("Enter", "a", " ") with held modifiers (the
// host's bits: Shift 1, Control 2, Alt 4, Meta 8). Characters with Control or
// Meta held are shortcuts and produce no text.
static bool pressKey(const String& name, int modifiers)
{
    if (auto* named = namedKey(name)) {
        key("down"_s, named->name, named->code, named->keyCode, named->text, modifiers);
        key("up"_s, named->name, named->code, named->keyCode, emptyString(), modifiers);
        return true;
    }
    if (equalLettersIgnoringASCIICase(name, "space"_s))
        return pressKey(" "_s, modifiers);
    if (name.isEmpty() || name.length() > 2)
        return false;
    char16_t c = name[0];
    String code;
    int keyCode = 0;
    if (isASCIIAlpha(c)) {
        keyCode = toASCIIUpper(c);
        code = makeString("Key"_s, static_cast<char>(toASCIIUpper(c)));
    } else if (isASCIIDigit(c)) {
        keyCode = c;
        code = makeString("Digit"_s, static_cast<char>(c));
    } else if (c == ' ') {
        keyCode = 32;
        code = "Space"_s;
    }
    bool shortcut = modifiers & (2 | 8);
    key("down"_s, name, code, keyCode, shortcut ? emptyString() : name, modifiers);
    key("up"_s, name, code, keyCode, emptyString(), modifiers);
    return true;
}

static Ref<JSON::Object> pointResult(IntPoint point)
{
    auto result = JSON::Object::create();
    auto position = JSON::Object::create();
    position->setInteger("x"_s, point.x());
    position->setInteger("y"_s, point.y());
    result->setObject("point"_s, WTF::move(position));
    return result;
}

// A short description of what covers a target, so the agent can pick that
// instead (a cookie banner, a modal).
static Ref<JSON::Object> coverResult(Node* cover)
{
    auto result = failure("not_actionable"_s, "something else is drawn over the target"_s);
    if (RefPtr element = cover ? elementFor(*cover) : nullptr) {
        auto covering = JSON::Object::create();
        covering->setString("ref"_s, refFor(*element));
        covering->setString("tag"_s, element->localName().convertToASCIILowercase());
        covering->setString("text"_s, clean(element->innerText(), maxNameLength));
        result->setObject("cover"_s, WTF::move(covering));
    }
    return result;
}

static constexpr OptionSet<HitTestRequest::Type> hitType { HitTestRequest::Type::ReadOnly, HitTestRequest::Type::Active, HitTestRequest::Type::DisallowUserAgentShadowContent, HitTestRequest::Type::AllowChildFrameContent };

// The element a click at `point` (view coordinates) would reach.
static RefPtr<Element> elementAt(IntPoint point)
{
    RefPtr frame = activeMainFrame();
    RefPtr frameView = frame ? frame->view() : nullptr;
    if (!frameView)
        return nullptr;
    frame->document()->updateLayoutIgnorePendingStylesheets();
    auto result = frame->eventHandler().hitTestResultAtPoint(frameView->rootViewToContents(point), hitType);
    RefPtr hit = result.innerNonSharedNode();
    return hit ? elementFor(*hit) : nullptr;
}

// Where a person would click `element`: scrolled into view, inside its
// visible part, and only where a hit test lands on it (or on a label for it),
// not on something drawn over it.
static std::optional<IntPoint> clickPoint(Element& element, RefPtr<Node>& cover, ASCIILiteral& error)
{
    RefPtr frame = activeMainFrame();
    RefPtr frameView = frame ? frame->view() : nullptr;
    if (!frameView) {
        error = "not_ready"_s;
        return std::nullopt;
    }
    element.document().updateLayoutIgnorePendingStylesheets();
    element.scrollIntoViewIfNeeded(true);
    frame->document()->updateLayoutIgnorePendingStylesheets();

    auto box = element.boundingBoxInRootViewCoordinates();
    box.intersect(IntRect({ }, View::singleton()->cssSize()));
    if (box.isEmpty()) {
        error = "not_visible"_s;
        return std::nullopt;
    }
    int quarterX = box.width() / 4;
    int quarterY = box.height() / 4;
    IntPoint candidates[] = {
        box.center(),
        { box.x() + quarterX, box.y() + quarterY },
        { box.maxX() - quarterX - 1, box.y() + quarterY },
        { box.x() + quarterX, box.maxY() - quarterY - 1 },
        { box.maxX() - quarterX - 1, box.maxY() - quarterY - 1 },
    };
    for (auto point : candidates) {
        auto result = frame->eventHandler().hitTestResultAtPoint(frameView->rootViewToContents(point), hitType);
        RefPtr hit = result.innerNonSharedNode();
        if (!hit)
            continue;
        if (hit.get() == &element || hit->isShadowIncludingDescendantOf(element))
            return point;
        RefPtr hitElement = elementFor(*hit);
        for (RefPtr<Element> ancestor = hitElement; ancestor; ancestor = ancestor->parentElement()) {
            if (RefPtr label = dynamicDowncast<HTMLLabelElement>(*ancestor)) {
                if (label->control().get() == &element)
                    return point;
                break;
            }
        }
        cover = hit;
    }
    error = "not_actionable"_s;
    return std::nullopt;
}

static void ensurePageFocus()
{
    auto& focus = View::singleton()->page().focusController();
    if (!focus.isActive())
        focus.setActive(true);
    if (!focus.isFocused())
        focus.setFocused(true);
}

// Refuses typing into a secret field unless its risk was approved.
static ASCIILiteral guardField(Element& element)
{
    auto field = fieldKind(element);
    if (field == Field::Password && !approved("login"_s))
        return "login"_s;
    if (field == Field::Payment && !approved("payment"_s))
        return "payment"_s;
    return { };
}

static Ref<JSON::Object> deniedResult(ASCIILiteral risk)
{
    auto result = failure("denied_by_policy"_s, makeString("typing into this field needs the embedder's approval for "_s, risk));
    result->setString("risk"_s, risk);
    return result;
}

// Types `text` into the focused field, one key at a time, as a person would.
// Stops if the page moves focus elsewhere meanwhile.
static Ref<JSON::Object> typeText(const String& text)
{
    RefPtr target = focusedElement();
    if (!target || !isEditable(*target))
        return failure("not_editable"_s, "no editable field has focus"_s);
    if (auto risk = guardField(*target); !risk.isNull())
        return deniedResult(risk);
    unsigned typed = 0;
    for (unsigned i = 0; i < text.length(); ++i) {
        if (focusedElement() != target) {
            auto result = failure("focus_changed"_s, "the page moved focus while typing"_s);
            result->setInteger("typed"_s, typed);
            return result;
        }
        char16_t c = text[i];
        if (c == '\n')
            pressKey("Enter"_s, 0);
        else if (c != '\r') {
            unsigned length = U16_IS_LEAD(c) && i + 1 < text.length() && U16_IS_TRAIL(text[i + 1]) ? 2 : 1;
            auto character = text.substring(i, length);
            int keyCode = isASCIIAlpha(c) ? toASCIIUpper(c) : isASCIIDigit(c) ? c : c == ' ' ? 32 : 0;
            key("down"_s, character, emptyString(), keyCode, character, 0);
            key("up"_s, character, emptyString(), keyCode, emptyString(), 0);
            i += length - 1;
        }
        ++typed;
    }
    auto result = JSON::Object::create();
    result->setInteger("typed"_s, typed);
    return result;
}

static Ref<JSON::Object> selectOption(HTMLSelectElement& select, const String& wanted)
{
    if (select.isDisabledFormControl())
        return failure("not_actionable"_s, "the list is disabled"_s);
    auto options = JSON::Array::create();
    for (unsigned i = 0; i < select.length(); ++i) {
        RefPtr option = select.item(i);
        if (!option)
            continue;
        if (option->value() == wanted || equalIgnoringASCIICase(clean(option->label(), maxNameLength), clean(wanted, maxNameLength))) {
            select.optionSelectedByUser(option->index(), true, select.multiple());
            auto result = JSON::Object::create();
            result->setString("selected"_s, clean(option->label(), maxNameLength));
            return result;
        }
        options->pushString(clean(option->label(), maxNameLength));
    }
    auto result = failure("no_such_option"_s, "no option has that value or label"_s);
    result->setArray("options"_s, WTF::move(options));
    return result;
}

// {id, action, ref?, x?, y?, text?, value?, key?, modifiers?, deltaX?,
// deltaY?, allow?: [risk]} -> {ok...} or an error.
static void act(int id, JSON::Object& args)
{
    auto* view = View::singleton();
    if (!view || !view->mainFrame())
        return fail(id, "not_ready"_s, "no page is loaded"_s);
    if (!state().agentInControl)
        return fail(id, "control_held"_s, "the person has control of the view"_s);

    auto& current = state();
    current.approved.clear();
    if (auto allow = args.getArray("allow"_s)) {
        for (size_t i = 0; i < allow->length(); ++i)
            current.approved.add(allow->get(i)->asString());
    }
    current.approvedUntil = MonotonicTime::now() + approvalLifetime;
    ensurePageFocus();

    auto action = args.getString("action"_s);
    auto refString = args.getString("ref"_s);
    RefPtr<Element> element;
    if (!refString.isEmpty()) {
        ASCIILiteral error;
        RefPtr node = resolve(refString, error);
        if (!node)
            return fail(id, error, makeString("no live node for ref "_s, refString));
        element = elementFor(*node);
        if (!element)
            return fail(id, "not_actionable"_s, "the ref has no element"_s);
    }

    auto clickElement = [&](Element& target) -> std::optional<IntPoint> {
        RefPtr<Node> cover;
        ASCIILiteral error;
        auto point = clickPoint(target, cover, error);
        if (point)
            click(*point);
        else if (error == "not_actionable"_s)
            reply(id, coverResult(cover.get()));
        else
            fail(id, error, "the target is not on screen"_s);
        return point;
    };

    if (action == "click"_s) {
        if (!element) {
            IntPoint point { args.getInteger("x"_s).value_or(-1), args.getInteger("y"_s).value_or(-1) };
            if (!IntRect({ }, view->cssSize()).contains(point))
                return fail(id, "not_visible"_s, "the point is outside the view"_s);
            click(point);
            return reply(id, pointResult(point));
        }
        if (auto point = clickElement(*element))
            reply(id, pointResult(*point));
        return;
    }

    if (action == "hover"_s) {
        if (!element)
            return fail(id, "invalid_params"_s, "hover needs a ref"_s);
        RefPtr<Node> cover;
        ASCIILiteral error;
        auto point = clickPoint(*element, cover, error);
        if (!point)
            return fail(id, error, "the target cannot be hovered"_s);
        mouse("move"_s, *point);
        return reply(id, pointResult(*point));
    }

    if (action == "type"_s || action == "fill"_s) {
        if (element) {
            if (auto risk = guardField(*element); !risk.isNull())
                return reply(id, deniedResult(risk));
            if (focusedElement() != element && !clickElement(*element))
                return;
        }
        if (action == "fill"_s) {
            RefPtr target = focusedElement();
            if (!target || !isEditable(*target))
                return fail(id, "not_editable"_s, "no editable field has focus"_s);
            if (auto risk = guardField(*target); !risk.isNull())
                return reply(id, deniedResult(risk));
            RefPtr frame = target->document().frame();
            if (!frame)
                return fail(id, "not_ready"_s, "the field's frame is gone"_s);
            frame->editor().command("SelectAll"_s).execute();
            frame->editor().command("DeleteBackward"_s).execute();
        }
        return reply(id, typeText(args.getString("text"_s)));
    }

    if (action == "press"_s) {
        if (element && focusedElement() != element && !clickElement(*element))
            return;
        // "Control+Shift+a": modifiers first, the key last.
        auto combination = args.getString("key"_s);
        int modifiers = 0;
        auto parts = combination.split('+');
        if (combination.endsWith('+') && combination.length() > 1)
            parts.append("+"_s);
        if (parts.isEmpty())
            return fail(id, "invalid_params"_s, "press needs a key"_s);
        for (size_t i = 0; i + 1 < parts.size(); ++i) {
            auto& part = parts[i];
            if (equalLettersIgnoringASCIICase(part, "shift"_s))
                modifiers |= 1;
            else if (equalLettersIgnoringASCIICase(part, "control"_s) || equalLettersIgnoringASCIICase(part, "ctrl"_s))
                modifiers |= 2;
            else if (equalLettersIgnoringASCIICase(part, "alt"_s))
                modifiers |= 4;
            else if (equalLettersIgnoringASCIICase(part, "meta"_s) || equalLettersIgnoringASCIICase(part, "command"_s))
                modifiers |= 8;
            else
                return fail(id, "invalid_params"_s, makeString("unknown modifier "_s, part));
        }
        if (!pressKey(parts.last(), modifiers))
            return fail(id, "invalid_params"_s, makeString("unknown key "_s, parts.last()));
        return reply(id, JSON::Object::create());
    }

    if (action == "select"_s) {
        RefPtr select = dynamicDowncast<HTMLSelectElement>(element.get());
        if (!select) {
            if (RefPtr option = dynamicDowncast<HTMLOptionElement>(element.get()))
                select = option->ownerSelectElement();
        }
        if (!select)
            return fail(id, "not_actionable"_s, "select needs the ref of a list (a select element)"_s);
        select->scrollIntoViewIfNeeded(true);
        return reply(id, selectOption(*select, args.getString("value"_s)));
    }

    if (action == "scroll"_s) {
        if (element) {
            element->scrollIntoViewIfNeeded(true);
            return reply(id, JSON::Object::create());
        }
        auto size = view->cssSize();
        auto wheel = JSON::Object::create();
        wheel->setDouble("x"_s, args.getDouble("x"_s).value_or(size.width() / 2));
        wheel->setDouble("y"_s, args.getDouble("y"_s).value_or(size.height() / 2));
        wheel->setDouble("deltaX"_s, args.getDouble("deltaX"_s).value_or(0));
        wheel->setDouble("deltaY"_s, args.getDouble("deltaY"_s).value_or(size.height() * 0.8));
        wheel->setInteger("deltaMode"_s, 0);
        dispatchWheel(wheel.get());
        return reply(id, JSON::Object::create());
    }

    fail(id, "invalid_params"_s, makeString("unknown action "_s, action));
}

// --- extract ----------------------------------------------------------------

static Ref<JSON::Array> extractLinks(Document& document, unsigned limit)
{
    auto links = JSON::Array::create();
    Ref collection = document.links();
    for (unsigned i = 0; i < collection->length() && links->length() < limit; ++i) {
        RefPtr anchor = dynamicDowncast<HTMLAnchorElement>(collection->item(i));
        // Links nobody can see are a common carrier for instructions aimed at
        // agents.
        if (!anchor || !anchor->renderer())
            continue;
        auto link = JSON::Object::create();
        link->setString("ref"_s, refFor(*anchor));
        link->setString("text"_s, clean(anchor->innerText(), maxNameLength));
        link->setString("href"_s, anchor->href().string());
        links->pushObject(WTF::move(link));
    }
    return links;
}

static Ref<JSON::Object> fieldDescription(Element& element, AXObjectCache* cache)
{
    auto field = JSON::Object::create();
    field->setString("ref"_s, refFor(element));
    field->setString("tag"_s, element.localName().convertToASCIILowercase());
    if (is<HTMLInputElement>(element))
    {
        String type = element.attributeWithoutSynchronization(HTMLNames::typeAttr);
        field->setString("type"_s, type.isEmpty() ? "text"_s : type.convertToASCIILowercase());
    }
    String name = element.attributeWithoutSynchronization(HTMLNames::nameAttr);
    if (!name.isEmpty())
        field->setString("name"_s, name);
    if (RefPtr object = cache ? cache->getOrCreate(element) : nullptr) {
        auto label = clean(object->computedLabel(), maxNameLength);
        if (RefPtr input = dynamicDowncast<HTMLInputElement>(element))
            label = without(without(label, input->value()), element.attributeWithoutSynchronization(HTMLNames::placeholderAttr));
        label = without(label, object->stringValue());
        if (!label.isEmpty())
            field->setString("label"_s, label);
    }
    auto kind = fieldKind(element);
    if (kind != Field::None) {
        field->setString("field"_s, fieldName(kind));
        RefPtr input = dynamicDowncast<HTMLInputElement>(element);
        field->setBoolean("filled"_s, input && !input->value()->isEmpty());
    } else if (RefPtr input = dynamicDowncast<HTMLInputElement>(element)) {
        if (input->isCheckbox() || input->isRadioButton())
            field->setBoolean("checked"_s, input->checked());
        else
            field->setString("value"_s, clean(input->value(), maxValueLength));
    } else if (RefPtr textArea = dynamicDowncast<HTMLTextAreaElement>(element))
        field->setString("value"_s, textArea->value()->left(maxValueLength));
    else if (RefPtr select = dynamicDowncast<HTMLSelectElement>(element)) {
        auto options = JSON::Array::create();
        for (unsigned i = 0; i < select->length(); ++i) {
            if (RefPtr option = select->item(i)) {
                options->pushString(clean(option->label(), maxNameLength));
                if (option->selected())
                    field->setString("value"_s, clean(option->label(), maxNameLength));
            }
        }
        field->setArray("options"_s, WTF::move(options));
    }
    if (element.hasAttributeWithoutSynchronization(HTMLNames::requiredAttr))
        field->setBoolean("required"_s, true);
    return field;
}

// Forms and their fields, plus a last entry without "action" for fields that
// belong to no form (common in script-driven pages).
static Ref<JSON::Array> extractForms(Document& document)
{
    AXObjectCache::enableAccessibility();
    CheckedPtr cache = document.axObjectCache();
    auto forms = JSON::Array::create();
    Vector<std::pair<Ref<HTMLFormElement>, Ref<JSON::Array>>> grouped;
    auto loose = JSON::Array::create();
    for (auto& control : descendantsOfType<HTMLFormControlElement>(document)) {
        if (!control.renderer())
            continue;
        if (RefPtr input = dynamicDowncast<HTMLInputElement>(control); input && input->isInputTypeHidden())
            continue;
        auto field = fieldDescription(control, cache.get());
        RefPtr form = control.form();
        if (!form) {
            loose->pushObject(WTF::move(field));
            continue;
        }
        auto index = grouped.findIf([&](auto& entry) { return entry.first.ptr() == form.get(); });
        if (index == notFound) {
            grouped.append(std::make_pair(form.releaseNonNull(), JSON::Array::create()));
            index = grouped.size() - 1;
        }
        grouped[index].second->pushObject(WTF::move(field));
    }
    for (auto& [form, fields] : grouped) {
        auto entry = JSON::Object::create();
        entry->setString("ref"_s, refFor(form));
        entry->setString("action"_s, form->action());
        entry->setString("method"_s, form->method());
        entry->setString("risk"_s, formRisk(form));
        entry->setArray("fields"_s, fields.copyRef());
        forms->pushObject(WTF::move(entry));
    }
    if (loose->length()) {
        auto entry = JSON::Object::create();
        entry->setArray("fields"_s, WTF::move(loose));
        forms->pushObject(WTF::move(entry));
    }
    return forms;
}

static Ref<JSON::Array> extractTables(Document& document)
{
    constexpr unsigned maxTables = 50;
    constexpr unsigned maxRows = 500;
    constexpr unsigned maxCells = 50;
    auto tables = JSON::Array::create();
    for (auto& table : descendantsOfType<HTMLTableElement>(document)) {
        if (tables->length() >= maxTables)
            break;
        if (!table.renderer())
            continue;
        auto rows = JSON::Array::create();
        Ref rowCollection = table.rows();
        for (unsigned i = 0; i < rowCollection->length() && i < maxRows; ++i) {
            RefPtr row = dynamicDowncast<HTMLTableRowElement>(rowCollection->item(i));
            if (!row)
                continue;
            auto cells = JSON::Array::create();
            Ref cellCollection = row->cells();
            for (unsigned j = 0; j < cellCollection->length() && j < maxCells; ++j) {
                if (RefPtr cell = cellCollection->item(j))
                    cells->pushString(clean(cell->innerText(), maxTextLength));
            }
            rows->pushArray(WTF::move(cells));
        }
        auto entry = JSON::Object::create();
        entry->setString("ref"_s, refFor(table));
        entry->setArray("rows"_s, WTF::move(rows));
        tables->pushObject(WTF::move(entry));
    }
    return tables;
}

// {id, kind: 'text'|'links'|'forms'|'tables', maxLength?}
static void extract(int id, JSON::Object& args)
{
    RefPtr frame = activeMainFrame();
    RefPtr document = frame ? frame->document() : nullptr;
    if (!document)
        return fail(id, "not_ready"_s, "no page is loaded"_s);
    document->updateLayoutIgnorePendingStylesheets();
    auto kind = args.getString("kind"_s);
    unsigned limit = std::max(1, args.getInteger("maxLength"_s).value_or(defaultExtractLength));
    auto result = JSON::Object::create();
    result->setString("url"_s, document->url().string());
    result->setString("title"_s, clean(document->title(), maxNameLength));
    if (kind == "text"_s) {
        RefPtr body = document->bodyOrFrameset();
        auto text = body ? body->innerText() : String { };
        result->setBoolean("truncated"_s, text.length() > limit);
        result->setString("text"_s, text.left(limit));
    } else if (kind == "links"_s)
        result->setArray("links"_s, extractLinks(*document, std::min(limit, 5000u)));
    else if (kind == "forms"_s)
        result->setArray("forms"_s, extractForms(*document));
    else if (kind == "tables"_s)
        result->setArray("tables"_s, extractTables(*document));
    else
        return fail(id, "invalid_params"_s, makeString("unknown kind "_s, kind));
    reply(id, WTF::move(result));
}

// --- probe ------------------------------------------------------------------

// {id, ref?, text?, selector?} -> {url, loading, loads, ref?: 'missing'|
// 'attached'|'visible', text?: bool, selector?: 'missing'|'attached'|'visible'}
static ASCIILiteral presence(Element* element)
{
    if (!element || !element->isConnected())
        return "missing"_s;
    auto box = element->renderer() ? element->boundingBoxInRootViewCoordinates() : IntRect { };
    return box.isEmpty() ? "attached"_s : "visible"_s;
}

static void probe(int id, JSON::Object& args)
{
    RefPtr frame = activeMainFrame();
    RefPtr document = frame ? frame->document() : nullptr;
    if (!document)
        return fail(id, "not_ready"_s, "no page is loaded"_s);
    auto result = JSON::Object::create();
    result->setString("url"_s, document->url().string());
    result->setBoolean("loading"_s, frame->loader().isLoading());
    result->setInteger("loads"_s, NetworkLoad::inFlight());
    auto ref = args.getString("ref"_s);
    if (!ref.isEmpty()) {
        ASCIILiteral error;
        RefPtr node = resolve(ref, error);
        RefPtr element = node ? elementFor(*node) : nullptr;
        if (element)
            document->updateLayoutIgnorePendingStylesheets();
        result->setString("ref"_s, error == "no_such_ref"_s ? "unknown"_s : presence(element.get()));
    }
    auto text = args.getString("text"_s);
    if (!text.isEmpty()) {
        RefPtr body = document->bodyOrFrameset();
        result->setBoolean("text"_s, body && body->innerText().containsIgnoringASCIICase(text));
    }
    auto selector = args.getString("selector"_s);
    if (!selector.isEmpty()) {
        auto found = document->querySelector(selector);
        if (found.hasException())
            return fail(id, "invalid_params"_s, "the selector is not valid"_s);
        RefPtr element = found.releaseReturnValue();
        if (element)
            document->updateLayoutIgnorePendingStylesheets();
        result->setString("selector"_s, presence(element.get()));
        if (element)
            result->setString("selectorRef"_s, refFor(*element));
    }
    reply(id, WTF::move(result));
}

void registerCommands()
{
    registerCommand("agent.snapshot"_s, [](JSON::Object& args) {
        snapshot(args.getInteger("id"_s).value_or(0), args);
    });
    registerCommand("agent.act"_s, [](JSON::Object& args) {
        act(args.getInteger("id"_s).value_or(0), args);
    });
    registerCommand("agent.extract"_s, [](JSON::Object& args) {
        extract(args.getInteger("id"_s).value_or(0), args);
    });
    registerCommand("agent.probe"_s, [](JSON::Object& args) {
        probe(args.getInteger("id"_s).value_or(0), args);
    });
    // {id, ref?, x?, y?}: the ref's element, the one at a point, or the
    // focused one.
    registerCommand("agent.describe"_s, [](JSON::Object& args) {
        int id = args.getInteger("id"_s).value_or(0);
        auto refString = args.getString("ref"_s);
        auto x = args.getInteger("x"_s);
        auto y = args.getInteger("y"_s);
        RefPtr<Element> element;
        if (refString.isEmpty() && x && y)
            element = elementAt({ *x, *y });
        else if (refString.isEmpty())
            element = focusedElement();
        else {
            ASCIILiteral error;
            RefPtr node = resolve(refString, error);
            if (!node)
                return fail(id, error, makeString("no live node for ref "_s, refString));
            element = elementFor(*node);
        }
        if (!element) {
            auto result = JSON::Object::create();
            if (RefPtr frame = activeMainFrame(); frame && frame->document()) {
                if (auto secrets = filledSecrets(*frame->document()); secrets != Field::None)
                    result->setString("secrets"_s, fieldName(secrets));
            }
            return reply(id, WTF::move(result));
        }
        reply(id, describe(*element));
    });
    // {agent: bool}: who drives the view. Taking control back clears any
    // approval still running.
    registerCommand("agent.control"_s, [](JSON::Object& args) {
        auto& current = state();
        current.agentInControl = args.getBoolean("agent"_s).value_or(false);
        current.approved.clear();
        current.approvedUntil = { };
    });
}

} // namespace Inception::Agent
