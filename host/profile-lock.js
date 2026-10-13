// Web Locks that arbitrate one profile among the documents of a site. A
// profile's files are open by one engine (or one profile service) at a time,
// so the document that holds the profile lock is the profile's host; every
// other document attaches to it or waits for the lock (host/attach.js).
//
//   inception-profile:<profile>      held by the host document
//   inception-host:<profile>:<id>    held by an attach-capable host for as long
//                                    as it lives: its presence tells another
//                                    document that attaching can work, and its
//                                    release that the host is gone
//   inception-client:<profile>:<id>  held by an attached document, so the host
//                                    and the broker learn when it goes away

export const profileLockName = (profile) => `inception-profile:${profile}`;
export const hostLockName = (profile, id) => `inception-host:${profile}:${id}`;
export const clientLockName = (profile, id) => `inception-client:${profile}:${id}`;

// Requests `name`; resolves {release()} once granted, or null when
// `ifAvailable` finds it held or `signal` aborts first. Without Web Locks
// there is nothing to arbitrate and the caller is granted at once.
function request(name, options) {
  if (!navigator.locks) return Promise.resolve({ release() {} });
  return new Promise((resolve, reject) => {
    navigator.locks.request(name, options, (lock) => {
      if (!lock) {
        resolve(null);
        return undefined;
      }
      return new Promise((release) => resolve({ release: () => release() }));
    }).catch((error) => (error?.name === 'AbortError' ? resolve(null) : reject(error)));
  });
}

// The lock if nobody holds it, otherwise null.
export function tryLock(name) {
  return request(name, { ifAvailable: true });
}

// Waits in line for the lock. Resolves null if `signal` aborts first.
export function waitLock(name, signal) {
  return request(name, signal ? { signal } : {});
}

// Resolves true when whoever holds `name` lets go (or never held it), false
// if `signal` aborts first. The lock is released again at once.
export async function whenFree(name, signal) {
  const lock = await waitLock(name, signal);
  lock?.release();
  return !!lock;
}

// Lock names that are held now and start with `prefix`.
export async function heldLocks(prefix) {
  if (!navigator.locks?.query) return [];
  const { held = [] } = await navigator.locks.query();
  return held.map((lock) => lock.name).filter((name) => name.startsWith(prefix));
}
