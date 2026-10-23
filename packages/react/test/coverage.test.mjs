// The component keeps up with the element: every event the view dispatches
// has a handler prop, and every attribute it reads has a prop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const viewTypes = read('../../inceptionjs/types/index.d.ts');
const reactSource = read('../src/index.js');
const reactTypes = read('../index.d.ts');
const viewSource = read('../../../host/inception-view.js');

const block = (source, start) => source.slice(source.indexOf(start), source.indexOf('\n}', source.indexOf(start)));

test('every event of InceptionViewEventMap has a handler prop', () => {
  const events = [...block(viewTypes, 'export interface InceptionViewEventMap').matchAll(/^ {2}'?([a-z.]+)'?:/gm)].map((m) => m[1]);
  assert.ok(events.length > 30);
  const handled = new Set([...block(reactSource, 'const EVENTS').matchAll(/: '([a-z.]+)'/g)].map((m) => m[1]));
  const typed = new Set([...block(reactTypes, 'export interface InceptionViewProps').matchAll(/Handler<'([a-z.]+)'>/g)].map((m) => m[1]));
  assert.deepEqual(events.filter((name) => !handled.has(name)), [], 'missing in EVENTS');
  assert.deepEqual(events.filter((name) => !typed.has(name)), [], 'missing in index.d.ts');
});

test('every attribute the element reads has a prop', () => {
  const read = new Set([...viewSource.matchAll(/(?:get|has)Attribute\('([a-z-]+)'\)/g)].map((m) => m[1]));
  read.delete('tabindex');
  const mapped = new Set([...(block(reactSource, 'const ATTRIBUTES') + block(reactSource, 'const OFF_ATTRIBUTES')).matchAll(/: '([a-z-]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...read].filter((name) => !mapped.has(name)), []);
});
