// Development aid: a timestamped trace of every media and EME operation the
// host performs for the engine (debug page: ?medialog=1). Off by default.
let enabled = false;
const started = performance.now();

export function setMediaLog(on) {
  enabled = !!on;
}

export function mediaLog(...parts) {
  if (!enabled) return;
  const time = ((performance.now() - started) / 1000).toFixed(3).padStart(8);
  console.info(`[medialog ${time}]`, ...parts.map((part) => (typeof part === 'string' ? part : brief(part))));
}

// Long values (init data, license messages, URLs) are cut; byte payloads show
// their size only.
function brief(value) {
  return JSON.stringify(value, (key, v) => {
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return `<${v.byteLength} bytes>`;
    if (typeof v === 'string' && v.length > 120) return `${v.slice(0, 60)}...<${v.length} chars>`;
    return v;
  });
}
