// Short-lived relay tokens. The embedder's backend signs one per session with a
// secret it shares with the relay; the page passes it to the relay in the
// WebSocket URL (`?token=`), since browsers cannot set headers on WebSockets.
//
// Format: v1.<payload>.<signature>, both base64url; the signature is
// HMAC-SHA256 over "v1.<payload>". Payload: {sub, origin, iat, exp}.

import { createHmac, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

const encode = (data) => Buffer.from(data).toString('base64url');
const sign = (secret, body) => createHmac('sha256', secret).update(body).digest('base64url');

export function requireSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new TypeError('the relay secret must be a string of at least 32 characters');
}

/** A token valid for `ttlSeconds` (default 5 minutes, at most a day). */
export function signRelayToken({ secret, subject = '', origin = '', ttlSeconds = 300, now = Date.now() } = {}) {
  requireSecret(secret);
  if (!(ttlSeconds > 0 && ttlSeconds <= 86_400)) throw new RangeError('ttlSeconds must be between 1 and 86400');
  const iat = Math.floor(now / 1000);
  const payload = encode(JSON.stringify({ sub: String(subject), origin: String(origin), iat, exp: iat + Math.floor(ttlSeconds) }));
  const body = `${VERSION}.${payload}`;
  return `${body}.${sign(secret, body)}`;
}

export class RelayTokenError extends Error {}

/**
 * The token's payload when it is authentic, unexpired and, if `origin` is
 * given and the token names one, issued for that origin. Throws otherwise.
 */
export function verifyRelayToken(token, { secret, origin, now = Date.now(), leewaySeconds = 30 } = {}) {
  requireSecret(secret);
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || parts[0] !== VERSION) throw new RelayTokenError('malformed token');
  const body = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(secret, body));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new RelayTokenError('bad signature');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new RelayTokenError('malformed payload');
  }
  const seconds = Math.floor(now / 1000);
  if (!(payload.exp + leewaySeconds >= seconds)) throw new RelayTokenError('expired');
  if (payload.iat - leewaySeconds > seconds) throw new RelayTokenError('issued in the future');
  if (origin && payload.origin && payload.origin !== origin) throw new RelayTokenError('issued for another origin');
  return payload;
}
