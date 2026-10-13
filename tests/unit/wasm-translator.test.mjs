import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WasmTranslator } from '../../host/wasm-translator.js';

// A stand-in for binaryen that "translates" a module into a script naming its bytes.
const stub = `export default {
  Features: { MVP: 0, MutableGlobals: 1, SignExt: 2, NontrappingFPToInt: 4, BulkMemory: 8, Multivalue: 16 },
  readBinary: (bytes) => ({ setFeatures() {}, validate: () => true, dispose() {}, emitAsmjs: () => 'function asmFunc(){return "' + Array.from(bytes).join(',') + '"}\\nvar retasmFunc' }),
};`;
const translator = () => new WasmTranslator(`data:text/javascript,${encodeURIComponent(stub)}`);
const HEADER = [0, 97, 115, 109, 1, 0, 0, 0];
const module = (...tail) => Uint8Array.from([...HEADER, ...tail]);

function fnv(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193);
  return hash >>> 0;
}

// Two different custom sections of the same length whose 32-bit FNV-1a hashes
// are equal: the kind of module pair the earlier cache key confused.
function collidingPair() {
  const seen = new Map();
  for (let n = 0; n < 1_000_000; n++) {
    const mixed = Math.imul(n, 2654435761) >>> 0;
    const bytes = module(0, 10, 1, 120, n & 255, (n >> 8) & 255, (n >> 16) & 255, mixed & 255, (mixed >> 8) & 255, (mixed >> 16) & 255, mixed >>> 24, 0);
    const key = fnv(bytes);
    const other = seen.get(key);
    if (other && other.some((b, i) => b !== bytes[i])) return [other, bytes];
    seen.set(key, bytes);
  }
  throw new Error('no collision found');
}

test('modules whose cheap hashes collide are still translated separately', async () => {
  const [first, second] = collidingPair();
  const t = translator();
  const a = await t.translate(first);
  const b = await t.translate(second);
  assert.match(a, /^ok:/);
  assert.notEqual(a, b);
  assert.equal(await t.translate(first), a);
});

test('many different modules each get their own translation', async () => {
  const t = translator();
  const replies = [];
  for (let i = 0; i < 100; i++) replies.push(await t.translate(module(0, 3, 1, 120, i)));
  assert.equal(new Set(replies).size, 100);
});
