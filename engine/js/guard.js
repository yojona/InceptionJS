// A content engine has no files and no network of its own (link/Link.h): its
// C++ never mounts the origin-private file system or opens the relay. This
// makes that hold for an engine whose code was subverted too. The host tells
// each thread of a content engine its role ({inceptionRole: 'content'}) before
// the thread instantiates the engine, and the thread then instantiates it with
// the file system and socket imports replaced by ones that throw, so no code
// in that engine can reach them. The host does the same for the engine's
// main-thread instance (host/runtime.js, lockImports).
addToLibrary({
  $inceptionGuard: { role: null },
  $inceptionGuard__postset: `
    if (ENVIRONMENT_IS_PTHREAD) {
      self.addEventListener('message', (e) => {
        const role = e.data && e.data.inceptionRole;
        if (typeof role === 'string' && !inceptionGuard.role) inceptionGuard.role = role;
      });
      Module['instantiateWasm'] = (imports, receive) => {
        if (inceptionGuard.role === 'content') {
          for (const table of Object.values(imports)) {
            for (const [key, value] of Object.entries(table)) {
              if (typeof value === 'function' && /^(__wasmfs_opfs_|_inception_tcp_|inception_has_opfs$)/.test(value.name))
                table[key] = () => { throw new Error('a content engine has no files or network of its own'); };
            }
          }
        }
        const instance = new WebAssembly.Instance(wasmModule, imports);
        receive(instance, wasmModule);
        return {};
      };
    }
  `,
});
