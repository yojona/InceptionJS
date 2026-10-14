// Copies the license files from the repository root into a package directory so
// that `npm pack` ships them. Run from a package's prepack: node ../legal.mjs
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));
for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) copyFileSync(root(name), name);
