// Whether the engine's thread can keep its profile in the origin private file
// system. Some browsers expose the API but fail it: Safari in a private window
// (and automation contexts without a persistent store) rejects the first
// request with an "unknown transient reason". The probe does what the engine
// needs, a synchronous access handle in a worker, so the engine can fall back
// to memory instead of crashing at start.
const PROBE = `
(async () => {
  try {
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle('.inception-probe', { create: true });
    const handle = await file.createSyncAccessHandle();
    handle.close();
    postMessage(true);
  } catch {
    postMessage(false);
  }
})();
`;

let result;

export function probeOpfs() {
  result ??= new Promise((resolve) => {
    if (typeof navigator.storage?.getDirectory !== 'function' || typeof Worker !== 'function') return resolve(false);
    const url = URL.createObjectURL(new Blob([PROBE], { type: 'text/javascript' }));
    const worker = new Worker(url);
    const finish = (ok) => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(ok === true);
    };
    const timer = setTimeout(finish, 5000, false);
    worker.onmessage = (e) => finish(e.data);
    worker.onerror = () => finish(false);
  });
  return result;
}
