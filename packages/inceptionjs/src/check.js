// Answers "can InceptionJS start on this page?" before booting an engine, with a
// reason for every requirement that fails.
export async function check({ relayUrl, timeout = 4000 } = {}) {
  const problems = [];
  const crossOriginIsolated = globalThis.crossOriginIsolated === true;
  if (!crossOriginIsolated)
    problems.push('The page is not cross-origin isolated: serve it with "Cross-Origin-Opener-Policy: same-origin" and "Cross-Origin-Embedder-Policy: require-corp" (or credentialless).');
  const sharedArrayBuffer = typeof SharedArrayBuffer === 'function';
  if (!sharedArrayBuffer) problems.push('SharedArrayBuffer is unavailable (it needs cross-origin isolation).');
  const webgl2 = (() => {
    try {
      return !!new OffscreenCanvas(1, 1).getContext('webgl2');
    } catch {
      return false;
    }
  })();
  if (!webgl2) problems.push('WebGL2 is unavailable: the engine falls back to software rendering.');
  let relay;
  if (relayUrl) {
    relay = await probeRelay(relayUrl, timeout);
    if (!relay.reachable) problems.push(`The relay at ${relayUrl} did not answer: ${relay.reason}.`);
  }
  // WebGL2 missing is a degradation, not a blocker.
  const ok = crossOriginIsolated && sharedArrayBuffer && (!relay || relay.reachable);
  return { ok, crossOriginIsolated, sharedArrayBuffer, webgl2, relay, problems };
}

// A relay that accepts the connection greets with its initial flow-control
// window (a CONTINUE packet for stream 0).
function probeRelay(url, timeout) {
  return new Promise((resolve) => {
    let socket;
    const done = (result) => {
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => done({ reachable: false, reason: 'timed out' }), timeout);
    try {
      socket = new WebSocket(url);
    } catch (error) {
      done({ reachable: false, reason: String(error?.message ?? error) });
      return;
    }
    socket.binaryType = 'arraybuffer';
    socket.onmessage = (e) => {
      const bytes = new Uint8Array(e.data);
      done(bytes[0] === 0x03 ? { reachable: true } : { reachable: false, reason: 'unexpected greeting' });
    };
    socket.onerror = () => done({ reachable: false, reason: 'connection failed' });
    socket.onclose = (e) => done({ reachable: false, reason: `closed (${e.code})` });
  });
}
