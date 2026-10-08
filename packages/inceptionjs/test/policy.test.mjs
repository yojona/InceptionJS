import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressRange, connectRefusal, nameRefusal } from '../src/server/policy.js';

test('public addresses pass, special ranges are named', () => {
  assert.equal(addressRange('93.184.215.14'), null);
  assert.equal(addressRange('2606:2800:21f:cb07:6820:80da:af6b:8b2c'), null);
  for (const [address, range] of [
    ['127.0.0.1', 'loopback'], ['10.1.2.3', 'private'], ['172.20.0.1', 'private'], ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'], ['100.100.1.1', 'carrier-grade NAT'], ['0.0.0.0', 'unspecified'],
    ['::1', 'loopback'], ['::', 'unspecified'], ['::ffff:127.0.0.1', 'loopback'], ['::ffff:7f00:1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'], ['fd7a:115c:a1e0::1', 'unique-local'], ['fe80::1', 'link-local'],
    ['64:ff9b::a00:1', 'private'], ['2002:7f00:1::', 'loopback'], ['ff02::1', 'multicast'],
  ]) assert.equal(addressRange(address), range, address);
});

test('only web ports, loopback only to dev ports in dev', () => {
  assert.equal(connectRefusal('93.184.215.14', 443), null);
  assert.equal(connectRefusal('93.184.215.14', 22), 'port 22');
  assert.equal(connectRefusal('127.0.0.1', 8085), 'loopback');
  const dev = { dev: true, devPorts: new Set([8085]) };
  assert.equal(connectRefusal('127.0.0.1', 8085, dev), null);
  assert.equal(connectRefusal('127.0.0.1', 22, dev), 'loopback port 22');
});

test('private names and direct IPs are refused outside dev', () => {
  assert.equal(nameRefusal('example.com'), null);
  assert.ok(nameRefusal('localhost'));
  assert.ok(nameRefusal('printer.local'));
  assert.ok(nameRefusal('box.tail1234.ts.net'));
  assert.ok(nameRefusal('1.2.3.4'));
  assert.equal(nameRefusal('localhost', { dev: true }), null);
});
