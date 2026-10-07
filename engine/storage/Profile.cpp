#include "config.h"
#include "storage/Profile.h"

#include "SecurityOriginData.h"
#include <wtf/FileSystem.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringBuilder.h>

namespace Inception::Profile {
using namespace WebCore;

static String& rootPath()
{
    static NeverDestroyed<String> path { "/inception/default"_s };
    return path;
}

// Profile names become directory names; anything else is replaced.
static String sanitize(const String& name)
{
    StringBuilder builder;
    for (auto character : StringView(name).codeUnits())
        builder.append(isASCIIAlphanumeric(character) || character == '-' || character == '_' ? static_cast<char16_t>(character) : '_');
    return builder.isEmpty() ? "default"_s : builder.toString();
}

void select(const String& name, bool fresh)
{
    rootPath() = makeString("/inception/"_s, sanitize(name));
    if (fresh)
        FileSystem::deleteNonEmptyDirectory(rootPath());
    FileSystem::makeAllDirectories(rootPath());
}

const String& root()
{
    return rootPath();
}

String originDirectory(const SecurityOriginData& origin)
{
    auto path = FileSystem::pathByAppendingComponent(rootPath(), origin.databaseIdentifier());
    FileSystem::makeAllDirectories(path);
    return path;
}

String file(const String& name)
{
    return FileSystem::pathByAppendingComponent(rootPath(), name);
}

} // namespace Inception::Profile
