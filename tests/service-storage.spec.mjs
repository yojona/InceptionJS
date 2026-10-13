import { expect, test } from '@playwright/test';

// localStorage and IndexedDB of a profile with a service: the data and the
// files live in the service; content engines share them, hear each other's
// changes, and lose nothing when either side crashes.
const harness = (page, method, ...args) => page.evaluate(([method, args]) => window.harness[method](...args), [method, args]);
const evaluate = (page, index, source) => harness(page, 'evaluate', index, source);

async function open(page, contents = 2) {
  await page.goto('/tests/fixtures/profile-service.html');
  await page.waitForFunction(() => window.harness);
  await harness(page, 'startService');
  const indexes = [];
  for (let i = 0; i < contents; i++) indexes.push(await addContent(page));
  return indexes;
}

async function addContent(page, url = 'https://example.com/') {
  const index = await harness(page, 'startContent');
  await harness(page, 'connect', index);
  await harness(page, 'navigate', index, url);
  return index;
}

async function run(page, index, source, timeout = 30_000) {
  const key = `r${Math.random().toString(36).slice(2)}`;
  await evaluate(page, index, `window.${key} = undefined; (async () => { ${source} })().then((v) => { window.${key} = JSON.stringify({ value: v }); }, (e) => { window.${key} = JSON.stringify({ error: String(e && (e.name + ': ' + e.message) || e) }); }); "started"`);
  let text = 'undefined';
  await expect.poll(async () => (text = await evaluate(page, index, `String(window.${key})`)), { timeout }).not.toBe('undefined');
  return JSON.parse(text);
}

// Script helpers every page gets: promises over IndexedDB requests.
const IDB = `
  const done = (request) => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const finished = (transaction) => new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error); });
  const openDB = (name, version, upgrade) => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result, request.transaction);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => { window.blocked = (window.blocked ?? 0) + 1; };
  });
`;

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.harness?.stop()).catch(() => {});
});

test('localStorage is one map per origin across content engines, with storage events', async ({ page }) => {
  const [first, second] = await open(page);
  await evaluate(page, second, 'window.events = []; addEventListener("storage", (e) => events.push([e.key, e.oldValue, e.newValue, e.url])); localStorage.length');
  await evaluate(page, first, 'window.events = []; addEventListener("storage", (e) => events.push(e.key)); localStorage.setItem("color", "teal"); "ok"');
  await expect.poll(() => evaluate(page, second, 'JSON.stringify(events)')).toBe(JSON.stringify([['color', null, 'teal', 'https://example.com/']]));
  expect(await evaluate(page, second, 'localStorage.getItem("color")')).toBe('teal');
  // The engine that wrote hears nothing of its own change.
  expect(await evaluate(page, first, 'JSON.stringify(events)')).toBe('[]');
  // Strings come back exactly, lone surrogates included.
  await evaluate(page, second, 'localStorage.setItem("odd", "a\\uD800b\\u00e9\\u{1F600}"); localStorage.removeItem("color"); "ok"');
  await expect.poll(() => evaluate(page, first, 'localStorage.getItem("color") === null && localStorage.getItem("odd") === "a\\uD800b\\u00e9\\u{1F600}"')).toBe('true');
  // A third engine that never looked reads the current map.
  const third = await addContent(page, 'https://example.com/?third');
  expect(await evaluate(page, third, 'JSON.stringify(Object.entries(localStorage))')).toBe(JSON.stringify([['odd', 'a\uD800bé\u{1F600}']]));
  // clear() reaches everyone.
  await evaluate(page, third, 'localStorage.clear(); "ok"');
  await expect.poll(() => evaluate(page, first, 'localStorage.length')).toBe('0');
  await expect.poll(() => evaluate(page, second, 'localStorage.length')).toBe('0');
});

test('writes that cross in flight end the same everywhere, and the quota holds', async ({ page }) => {
  const [first, second] = await open(page);
  await evaluate(page, first, 'localStorage.length');
  await evaluate(page, second, 'localStorage.length');
  await Promise.all([
    evaluate(page, first, 'for (let i = 0; i < 200; i++) localStorage.setItem("k", "first " + i); "ok"'),
    evaluate(page, second, 'for (let i = 0; i < 200; i++) localStorage.setItem("k", "second " + i); "ok"'),
  ]);
  const third = await addContent(page, 'https://example.com/?third');
  const final = await evaluate(page, third, 'localStorage.getItem("k")');
  expect(['first 199', 'second 199']).toContain(final);
  await expect.poll(() => evaluate(page, first, 'localStorage.getItem("k")')).toBe(final);
  await expect.poll(() => evaluate(page, second, 'localStorage.getItem("k")')).toBe(final);
  const quota = await run(page, first, `try { localStorage.setItem('big', 'x'.repeat(6 * 1024 * 1024)); return 'stored'; } catch (e) { return e.name; }`);
  expect(quota.value).toBe('QuotaExceededError');
});

test('IndexedDB is one database server for every content engine', async ({ page }) => {
  const [first, second] = await open(page);
  const written = await run(page, first, `${IDB}
    const db = await openDB('shared', 1, (db) => {
      const store = db.createObjectStore('items', { keyPath: 'id' });
      store.createIndex('byName', 'name', { unique: false });
      db.createObjectStore('keys');
    });
    const t = db.transaction(['items', 'keys'], 'readwrite');
    t.objectStore('items').put({ id: 1, name: 'one', blob: new Uint8Array([1, 2, 3]) });
    t.objectStore('items').put({ id: 2, name: 'two', when: new Date(86400000) });
    t.objectStore('items').put({ id: 3, name: 'two', nested: { list: [1, 'a', null] } });
    const keys = t.objectStore('keys');
    keys.put('array key', [1, 'b', [2]]);
    keys.put('date key', new Date(1000));
    keys.put('binary key', new Uint8Array([9, 8]).buffer);
    await finished(t);
    db.close();
    return 'written';`);
  expect(written.value).toBe('written');
  const read = await run(page, second, `${IDB}
    const db = await openDB('shared', 1);
    const t = db.transaction(['items', 'keys']);
    const items = t.objectStore('items');
    const one = await done(items.get(1));
    const twos = await done(items.index('byName').getAll('two'));
    const count = await done(items.count());
    const cursor = [];
    await new Promise((resolve) => { items.openCursor(null, 'prev').onsuccess = (e) => { const c = e.target.result; if (!c) return resolve(); cursor.push(c.key); c.continue(); }; });
    const keys = await done(t.objectStore('keys').getAllKeys());
    db.close();
    return { one: [one.name, Array.from(one.blob)], twos: twos.map((r) => r.id), when: twos[0].when.getTime(), nested: twos[1].nested, count, cursor, keys: keys.map((k) => k instanceof ArrayBuffer ? Array.from(new Uint8Array(k)) : k instanceof Date ? k.getTime() : k) };`);
  expect(read.value).toEqual({
    one: ['one', [1, 2, 3]],
    twos: [2, 3],
    when: 86400000,
    nested: { list: [1, 'a', null] },
    count: 3,
    cursor: [3, 2, 1],
    // Key order: dates, then binary, then arrays.
    keys: [1000, [9, 8], [1, 'b', [2]]],
  });
  const databases = await run(page, second, `return (await indexedDB.databases()).map((d) => [d.name, d.version]);`);
  expect(databases.value).toEqual([['shared', 1]]);
});

test('a Blob stored in a record by one engine reads in another', async ({ page }) => {
  const [first, second] = await open(page);
  await run(page, first, `${IDB}
    const db = await openDB('blobs', 1, (db) => db.createObjectStore('s'));
    const t = db.transaction('s', 'readwrite');
    t.objectStore('s').put({ file: new Blob(['blob text'], { type: 'text/plain' }), name: 'note' }, 'k');
    await finished(t);
    db.close();
    return 'stored';`);
  const read = await run(page, second, `${IDB}
    const db = await openDB('blobs', 1);
    const record = await done(db.transaction('s').objectStore('s').get('k'));
    db.close();
    return [record.name, record.file.type, await record.file.text()];`);
  expect(read.value).toEqual(['note', 'text/plain', 'blob text']);
});

test('a version change in one engine reaches connections open in another', async ({ page }) => {
  const [first, second] = await open(page);
  await run(page, first, `${IDB}
    window.db = await openDB('versions', 1, (db) => db.createObjectStore('s'));
    window.changes = [];
    db.onversionchange = (e) => { changes.push([e.oldVersion, e.newVersion]); db.close(); };
    return 'open';`);
  const upgraded = await run(page, second, `${IDB}
    const db = await openDB('versions', 2, (db) => db.createObjectStore('t'));
    const names = Array.from(db.objectStoreNames);
    db.close();
    return [db.version, names];`);
  expect(upgraded.value).toEqual([2, ['s', 't']]);
  expect(await evaluate(page, first, 'JSON.stringify(changes)')).toBe('[[1,2]]');
});

test('a content engine that crashes mid-transaction does not hold the database', async ({ page }) => {
  const [first, second] = await open(page);
  await run(page, first, `${IDB}
    window.db = await openDB('held', 1, (db) => db.createObjectStore('s'));
    const t = db.transaction('s', 'readwrite');
    const store = t.objectStore('s');
    store.put('never committed', 'k');
    // Requests one after another keep it from committing.
    const keepAlive = () => { store.get('x').onsuccess = keepAlive; };
    keepAlive();
    return 'pending';`);
  await harness(page, 'crashContent', first);
  const upgraded = await run(page, second, `${IDB}
    const db = await openDB('held', 2, (db) => db.createObjectStore('t'));
    const value = await done(db.transaction('s').objectStore('s').get('k'));
    db.close();
    return [db.version, value ?? null];`);
  expect(upgraded.value).toEqual([2, null]);
});

test('storage outlives a service crash: open databases close, data is there after the restart', async ({ page }) => {
  const [first] = await open(page, 1);
  await run(page, first, `${IDB}
    localStorage.setItem('kept', 'yes');
    window.db = await openDB('durable', 1, (db) => db.createObjectStore('s'));
    const t = db.transaction('s', 'readwrite');
    t.objectStore('s').put('stored', 'k');
    await finished(t);
    window.dbClosed = false;
    db.onclose = () => { dbClosed = true; };
    return 'ok';`);
  const restarted = page.evaluate(() => window.harness.waitRestart());
  await harness(page, 'crashService');
  await expect.poll(() => evaluate(page, first, 'String(dbClosed)')).toBe('true');
  await restarted;
  await harness(page, 'connect', first);
  // A document loaded after the restart uses the new service.
  await harness(page, 'navigate', first, 'https://example.com/?again');
  const after = await run(page, first, `${IDB}
    const db = await openDB('durable', 1);
    const value = await done(db.transaction('s').objectStore('s').get('k'));
    db.close();
    return [localStorage.getItem('kept'), value];`);
  expect(after.value).toEqual(['yes', 'stored']);
});
