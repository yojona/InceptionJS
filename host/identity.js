// The user agent the engine announces: WebKit, in the standard Safari-
// compatible form, on the platform the host really runs on, with a trailing
// InceptionJS token so sites can tell it apart without breaking UA sniffing.

export const ENGINE_VERSION = '0.1';

const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0';
const TOKEN = `InceptionJS/${ENGINE_VERSION}`;

function hostPlatform() {
  const hint = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
  const ua = navigator.userAgent;
  if (/iphone|ipod/i.test(ua)) return 'iphone';
  // iPadOS reports a Mac; touch tells them apart.
  if (/ipad/i.test(ua) || (/mac/.test(hint) && navigator.maxTouchPoints > 1)) return 'ipad';
  if (/android/i.test(ua) || hint === 'android') return 'android';
  if (/mac/.test(hint)) return 'mac';
  if (/win/.test(hint)) return 'windows';
  return 'linux';
}

export function defaultUserAgent() {
  switch (hostPlatform()) {
  case 'mac': return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${WEBKIT} Safari/605.1.15 ${TOKEN}`;
  case 'windows': return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${WEBKIT} Safari/605.1.15 ${TOKEN}`;
  case 'iphone': return `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) ${WEBKIT} Mobile/15E148 Safari/604.1 ${TOKEN}`;
  case 'ipad': return `Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) ${WEBKIT} Mobile/15E148 Safari/604.1 ${TOKEN}`;
  case 'android': return `Mozilla/5.0 (Linux; Android 10; K) ${WEBKIT} Mobile Safari/605.1.15 ${TOKEN}`;
  default: return `Mozilla/5.0 (X11; Linux x86_64) ${WEBKIT} Safari/605.1.15 ${TOKEN}`;
  }
}
