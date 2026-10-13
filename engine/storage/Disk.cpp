#include "config.h"
#include "storage/Disk.h"

#include <emscripten/em_js.h>
#include <emscripten/wasmfs.h>
#include <sqlite3.h>
#include <sys/stat.h>

// Origin private file system is available to this worker.
EM_JS(int, inception_has_opfs, (), {
    return typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function' ? 1 : 0;
});

namespace Inception::Disk {

static bool s_persistent;

bool mount(Storage storage)
{
    // Directories the libraries write to; empty directories are not part of
    // the preloaded file system image.
    for (auto* path : { "/tmp", "/var", "/var/cache", "/var/cache/fontconfig" })
        mkdir(path, 0777);

    // SQLite: exclusive locking, so WAL needs no shared-memory mapping.
    if (auto* vfs = sqlite3_vfs_find("unix-excl"))
        sqlite3_vfs_register(vfs, 1);

    struct stat info;
    if (!stat("/inception", &info))
        return s_persistent;
    if (storage == Storage::Persistent && inception_has_opfs()) {
        if (auto backend = wasmfs_create_opfs_backend(); backend && !wasmfs_create_directory("/inception", 0777, backend)) {
            s_persistent = true;
            return true;
        }
    }
    mkdir("/inception", 0777);
    return false;
}

bool isPersistent()
{
    return s_persistent;
}

} // namespace Inception::Disk
