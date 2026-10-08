#include "config.h"
#include "storage/History.h"

#include "SQLiteDatabase.h"
#include "SQLiteStatement.h"
#include "bridge/Bridge.h"
#include "storage/Profile.h"
#include <sqlite3.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/WallTime.h>
#include <wtf/text/MakeString.h>

namespace Inception::History {
using namespace WebCore;

static SQLiteDatabase* database()
{
    static NeverDestroyed<SQLiteDatabase> db;
    static bool opened;
    if (!opened) {
        opened = true;
        if (!db->open(Profile::file("history.sqlite"_s)))
            return nullptr;
        db->executeCommand("CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', visited REAL NOT NULL)"_s);
        db->executeCommand("CREATE INDEX IF NOT EXISTS visits_by_time ON visits (visited)"_s);
    }
    return db->isOpen() ? &db.get() : nullptr;
}

static bool recorded(const URL& url)
{
    return url.protocolIsInHTTPFamily();
}

void recordVisit(const URL& url)
{
    auto* db = database();
    if (!db || !recorded(url))
        return;
    if (auto statement = db->prepareStatement("INSERT INTO visits (url, visited) VALUES (?, ?)"_s)) {
        statement->bindText(1, url.string());
        statement->bindDouble(2, WallTime::now().secondsSinceEpoch().milliseconds());
        statement->step();
    }
}

void updateTitle(const URL& url, const String& title)
{
    auto* db = database();
    if (!db || !recorded(url))
        return;
    // The latest visit to this page is the one being titled.
    if (auto statement = db->prepareStatement("UPDATE visits SET title = ? WHERE id = (SELECT MAX(id) FROM visits WHERE url = ?)"_s)) {
        statement->bindText(1, title);
        statement->bindText(2, url.string());
        statement->step();
    }
}

void registerCommands()
{
    // {id, text?, limit?, before?} -> "history.result" {id, entries: [{url, title, visited}]},
    // newest first; `text` matches URL or title, `before` pages backwards (ms).
    registerCommand("history.query"_s, [](JSON::Object& args) {
        auto entries = JSON::Array::create();
        if (auto* db = database()) {
            auto text = args.getString("text"_s);
            auto pattern = makeString('%', text, '%');
            double before = args.getDouble("before"_s).value_or(std::numeric_limits<double>::max());
            int limit = std::clamp(args.getInteger("limit"_s).value_or(100), 1, 1000);
            if (auto statement = db->prepareStatement("SELECT url, title, visited FROM visits WHERE visited < ? AND (url LIKE ? OR title LIKE ?) ORDER BY visited DESC LIMIT ?"_s)) {
                statement->bindDouble(1, before);
                statement->bindText(2, pattern);
                statement->bindText(3, pattern);
                statement->bindInt(4, limit);
                while (statement->step() == SQLITE_ROW) {
                    auto entry = JSON::Object::create();
                    entry->setString("url"_s, statement->columnText(0));
                    entry->setString("title"_s, statement->columnText(1));
                    entry->setDouble("visited"_s, statement->columnDouble(2));
                    entries->pushObject(WTF::move(entry));
                }
            }
        }
        auto result = JSON::Object::create();
        result->setDouble("id"_s, args.getDouble("id"_s).value_or(0));
        result->setArray("entries"_s, WTF::move(entries));
        emitEvent("history.result"_s, WTF::move(result));
    });

    // {url?, from?, to?}: every visit to `url`, or every visit in [from, to) (ms).
    registerCommand("history.delete"_s, [](JSON::Object& args) {
        auto* db = database();
        if (!db)
            return;
        auto url = args.getString("url"_s);
        if (!url.isEmpty()) {
            if (auto statement = db->prepareStatement("DELETE FROM visits WHERE url = ?"_s)) {
                statement->bindText(1, url);
                statement->step();
            }
            return;
        }
        if (auto statement = db->prepareStatement("DELETE FROM visits WHERE visited >= ? AND visited < ?"_s)) {
            statement->bindDouble(1, args.getDouble("from"_s).value_or(0));
            statement->bindDouble(2, args.getDouble("to"_s).value_or(std::numeric_limits<double>::max()));
            statement->step();
        }
    });
}

} // namespace Inception::History
