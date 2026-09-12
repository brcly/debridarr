import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { clientAddress, parseTrustedProxies, TrustedProxyError } from '../src/security/clientAddress.js';
import { loadConfig, ConfigurationError } from '../src/config.js';

const request = (remoteAddress: string | undefined, forwardedFor?: string | string[]): IncomingMessage => ({
  socket: { remoteAddress },
  headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
} as unknown as IncomingMessage);

const none = parseTrustedProxies(undefined);

test('with no trusted proxies the socket address is used and headers are ignored', () => {
  assert.equal(none.configured, false);
  assert.equal(clientAddress(request('203.0.113.9'), none), '203.0.113.9');
  // The forgery that makes blindly trusting the header unsafe.
  assert.equal(clientAddress(request('203.0.113.9', '1.2.3.4'), none), '203.0.113.9');
});

test('a forwarded-for from an untrusted peer is still ignored', () => {
  const trusted = parseTrustedProxies('10.0.0.1');
  assert.equal(clientAddress(request('203.0.113.9', '1.2.3.4'), trusted), '203.0.113.9');
});

test('a forwarded-for from a trusted peer supplies the client address', () => {
  const trusted = parseTrustedProxies('10.0.0.1');
  assert.equal(clientAddress(request('10.0.0.1', '203.0.113.9'), trusted), '203.0.113.9');
});

test('the right-most untrusted hop wins, so prepended entries cannot be forged', () => {
  const trusted = parseTrustedProxies('10.0.0.0/8');
  // A client sends "1.2.3.4"; two trusted hops append their own view.
  assert.equal(clientAddress(request('10.0.0.1', '1.2.3.4, 203.0.113.9, 10.0.0.2'), trusted), '203.0.113.9');
});

test('a chain of only trusted addresses falls back to the left-most', () => {
  const trusted = parseTrustedProxies('10.0.0.0/8');
  assert.equal(clientAddress(request('10.0.0.1', '10.0.0.7, 10.0.0.2'), trusted), '10.0.0.7');
});

test('a trusted peer sending no or unparseable forwarded-for falls back to the socket', () => {
  const trusted = parseTrustedProxies('10.0.0.1');
  assert.equal(clientAddress(request('10.0.0.1'), trusted), '10.0.0.1');
  assert.equal(clientAddress(request('10.0.0.1', 'not-an-ip'), trusted), '10.0.0.1');
  assert.equal(clientAddress(request('10.0.0.1', ''), trusted), '10.0.0.1');
});

test('CIDR ranges, bare addresses and IPv6 all match', () => {
  const trusted = parseTrustedProxies('10.0.0.0/8, 192.168.1.5, fc00::/7');
  assert.equal(trusted.trusts('10.255.0.1'), true);
  assert.equal(trusted.trusts('11.0.0.1'), false);
  assert.equal(trusted.trusts('192.168.1.5'), true);
  assert.equal(trusted.trusts('192.168.1.6'), false);
  assert.equal(trusted.trusts('fd12::1'), true);
  assert.equal(trusted.trusts('2001:db8::1'), false);
});

test('IPv4-mapped IPv6 peers are matched as the IPv4 address they are', () => {
  const trusted = parseTrustedProxies('10.0.0.0/8');
  assert.equal(trusted.trusts('::ffff:10.1.2.3'), true);
  assert.equal(clientAddress(request('::ffff:10.0.0.1', '::ffff:203.0.113.9'), trusted), '203.0.113.9');
  // And a plain IPv4 socket is reported unchanged.
  assert.equal(clientAddress(request('::ffff:203.0.113.9'), none), '203.0.113.9');
});

test('the loopback and private shorthands cover the usual sidecar deployments', () => {
  const loopback = parseTrustedProxies('loopback');
  assert.equal(loopback.trusts('127.0.0.1'), true);
  assert.equal(loopback.trusts('::1'), true);
  assert.equal(loopback.trusts('10.0.0.1'), false);

  const priv = parseTrustedProxies('private');
  for (const address of ['10.1.1.1', '172.16.0.1', '192.168.0.1', '127.0.0.1', 'fd00::1']) {
    assert.equal(priv.trusts(address), true, address);
  }
  assert.equal(priv.trusts('203.0.113.9'), false);
  assert.equal(priv.trusts('172.32.0.1'), false, '172.32 is outside the /12');
});

test('a missing socket address degrades to a constant rather than throwing', () => {
  assert.equal(clientAddress(request(undefined), none), 'unknown');
});

test('invalid entries are rejected at parse time', () => {
  assert.throws(() => parseTrustedProxies('nonsense'), TrustedProxyError);
  assert.throws(() => parseTrustedProxies('10.0.0.0/99'), TrustedProxyError);
  assert.throws(() => parseTrustedProxies('10.0.0.0/-1'), TrustedProxyError);
});

test('loadConfig surfaces a bad TRUSTED_PROXIES as a configuration error', () => {
  const env = { ADMIN_PASSWORD: 'a-long-enough-password', TRUSTED_PROXIES: 'nope' };
  assert.throws(() => loadConfig(env), (error: Error) => {
    assert.ok(error instanceof ConfigurationError);
    assert.match(error.message, /TRUSTED_PROXIES/);
    return true;
  });
});

test('loadConfig defaults to trusting nothing', () => {
  const config = loadConfig({ ADMIN_PASSWORD: 'a-long-enough-password' });
  assert.equal(config.trustedProxies.configured, false);
  assert.equal(loadConfig({ ADMIN_PASSWORD: 'a-long-enough-password', TRUSTED_PROXIES: 'loopback' }).trustedProxies.configured, true);
});
