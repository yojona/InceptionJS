#include "config.h"

#include "FontCache.h"
#include "bridge/Bridge.h"
#include "view/View.h"
#include <emscripten/em_macros.h>
#include <fontconfig/fontconfig.h>
#include <wtf/FileHandle.h>
#include <wtf/FileSystem.h>
#include <wtf/text/MakeString.h>

// Fonts the engine does not bundle in its file system image: the host loads
// them (the CJK font, the engine's fourth file) when a page needs one, at
// startup, or never, as the embedder chooses. WebCore reports each character
// it needs a fallback font for (patches/webkit/0037); the first one a lazy
// font covers asks the host for it ("font.missing" {set}). The host answers
// with the file (bridge.js: inception_font_add), which joins fontconfig, and
// text is shaped again with it.

namespace Inception {
using namespace WebCore;

enum class LazyFontState : uint8_t { Missing, Requested, Added };

static LazyFontState& cjkState()
{
    static LazyFontState state = LazyFontState::Missing;
    return state;
}

// Han, kana, Hangul, Bopomofo, and the CJK symbol, compatibility and
// fullwidth blocks: what Noto Sans CJK covers that the bundled fonts do not.
static bool isCJK(char32_t character)
{
    return (character >= 0x1100 && character <= 0x11FF)
        || (character >= 0x2E80 && character <= 0x2FDF)
        || (character >= 0x3000 && character <= 0x33FF)
        || (character >= 0x3400 && character <= 0x4DBF)
        || (character >= 0x4E00 && character <= 0x9FFF)
        || (character >= 0xA960 && character <= 0xA97F)
        || (character >= 0xAC00 && character <= 0xD7FF)
        || (character >= 0xF900 && character <= 0xFAFF)
        || (character >= 0xFE30 && character <= 0xFE4F)
        || (character >= 0xFF00 && character <= 0xFFEF)
        || (character >= 0x20000 && character <= 0x3FFFF);
}

} // namespace Inception

extern "C" void inception_font_fallback(char32_t character)
{
    using namespace Inception;
    if (cjkState() != LazyFontState::Missing || !isCJK(character))
        return;
    cjkState() = LazyFontState::Requested;
    auto data = JSON::Object::create();
    data->setString("set"_s, "cjk"_s);
    emitEvent("font.missing"_s, WTF::move(data));
}

// A lazy font from the host: written to the file system, added to
// fontconfig, and every font cache dropped so pages shape their text again.
extern "C" EMSCRIPTEN_KEEPALIVE void inception_font_add(const char* set, const uint8_t* data, size_t length)
{
    using namespace Inception;
    auto name = String::fromUTF8(set);
    if (name != "cjk"_s || cjkState() == LazyFontState::Added)
        return;
    // Under /tmp, as files from the host's picker are: the preloaded image's
    // directories take no new entries.
    auto directory = "/tmp/fonts"_s;
    FileSystem::makeAllDirectories(directory);
    auto path = FileSystem::pathByAppendingComponent(directory, makeString(name, ".ttc"_s));
    {
        auto handle = FileSystem::openFile(path, FileSystem::FileOpenMode::Truncate);
        size_t written = 0;
        while (handle && written < length) {
            auto count = handle.write({ data + written, length - written });
            if (!count || !*count)
                break;
            written += *count;
        }
        if (written != length) {
            report("error"_s, makeString("could not store the "_s, name, " font ("_s, written, " of "_s, length, " bytes)"_s));
            return;
        }
    }
    if (!FcConfigAppFontAddFile(FcConfigGetCurrent(), reinterpret_cast<const FcChar8*>(path.utf8().data()))) {
        report("error"_s, makeString("fontconfig refused the "_s, name, " font"_s));
        return;
    }
    cjkState() = LazyFontState::Added;
    FontCache::invalidateAllFontCaches();
    for (auto* view : View::all())
        view->setNeedsPaint();
    auto event = JSON::Object::create();
    event->setString("set"_s, name);
    emitEvent("font.added"_s, WTF::move(event));
}
