#include "config.h"
#include "view/Preferences.h"

#include "CommonVM.h"
#include "Page.h"
#include "Settings.h"
#include "bridge/Bridge.h"
#include "view/View.h"
#include <JavaScriptCore/JSDateMath.h>
#include <JavaScriptCore/VM.h>
#include <wtf/DateMath.h>
#include <wtf/Language.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/StringBuilder.h>

namespace Inception {
using namespace WebCore;

static String& acceptLanguageValue()
{
    static NeverDestroyed<String> value;
    return value;
}

const String& acceptLanguage()
{
    return acceptLanguageValue();
}

static void setLanguages(const Vector<String>& languages)
{
    overrideUserPreferredLanguages(languages);
    StringBuilder header;
    for (size_t i = 0; i < languages.size() && i < 10; ++i) {
        if (i)
            header.append(',');
        header.append(languages[i]);
        if (i)
            header.append(";q=0."_s, 10 - i);
    }
    acceptLanguageValue() = header.toString();
}

static ForcedAccessibilityValue forced(std::optional<bool> value)
{
    if (!value)
        return ForcedAccessibilityValue::System;
    return *value ? ForcedAccessibilityValue::On : ForcedAccessibilityValue::Off;
}

// {colorScheme: "light"|"dark", reducedMotion, contrast: "more"|"no-preference",
// languages: [...], timeZone}. Absent fields keep their value.
void applyPreferences(JSON::Object& args)
{
    auto* view = View::singleton();
    if (!view)
        return;
    Ref page = view->page();
    auto& settings = page->settings();
    bool accessibilityChanged = false;

    auto colorScheme = args.getString("colorScheme"_s);
    if (!colorScheme.isNull())
        page->setUseColorAppearance(colorScheme == "dark"_s, false);
    if (auto reducedMotion = args.getBoolean("reducedMotion"_s)) {
        settings.setForcedPrefersReducedMotionAccessibilityValue(forced(*reducedMotion));
        accessibilityChanged = true;
    }
    auto contrast = args.getString("contrast"_s);
    if (!contrast.isNull()) {
        settings.setForcedPrefersContrastAccessibilityValue(forced(contrast == "more"_s));
        accessibilityChanged = true;
    }
    if (accessibilityChanged)
        page->accessibilitySettingsDidChange();

    if (auto list = args.getArray("languages"_s)) {
        Vector<String> languages;
        for (auto& language : *list) {
            auto value = language->asString();
            if (!value.isEmpty())
                languages.append(value);
        }
        if (!languages.isEmpty())
            setLanguages(languages);
    }

    auto timeZone = args.getString("timeZone"_s);
    if (!timeZone.isEmpty() && WTF::setTimeZoneOverride(timeZone))
        commonVM().dateCache.resetIfNecessarySlow();
}

void registerPreferenceCommands()
{
    registerCommand("preferences"_s, applyPreferences);
}

} // namespace Inception
