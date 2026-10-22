import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signRelayToken, verifyRelayToken } from '../src/server/token.js';

const secret = 'a'.repeat(40);

test('a signed token verifies and carries its claims', () => {
  const token = signRelayToken({ secret, subject: 'user-1', origin: 'https://app.example' });
  const payload = verifyRelayToken(token, { secret, origin: 'https://app.example' });
  assert.equal(payload.sub, 'user-1');
  assert.ok(payload.exp > payload.iat);
});

test('tampered, expired, foreign-origin and short-secret tokens are refused', () => {
  const token = signRelayToken({ secret, origin: 'https://app.example', ttlSeconds: 60, now: 0 });
  assert.throws(() => verifyRelayToken(token, { secret, now: 10 * 60_000 }), /expired/);
  const fresh = signRelayToken({ secret, origin: 'https://app.example' });
  assert.throws(() => verifyRelayToken(fresh.slice(0, -2) + 'xx', { secret }), /signature/);
  assert.throws(() => verifyRelayToken(fresh, { secret: 'b'.repeat(40) }), /signature/);
  assert.throws(() => verifyRelayToken(fresh, { secret, origin: 'https://evil.example' }), /origin/);
  assert.throws(() => verifyRelayToken(fresh, { secret }), /without one/);
  assert.equal(verifyRelayToken(signRelayToken({ secret }), { secret }).origin, '');
  assert.throws(() => signRelayToken({ secret: 'short' }), /32/);
});
