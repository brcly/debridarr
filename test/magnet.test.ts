import assert from 'node:assert/strict';
import { test } from 'node:test';
import { magnetInfoHash, toMagnet } from '../src/downloads/magnet.js';

test('magnetInfoHash reads hex and base32 btih and ignores the rest', () => {
  const hex = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(magnetInfoHash(`magnet:?xt=urn:btih:${hex}&dn=Something`), hex);
  assert.equal(magnetInfoHash(`magnet:?xt=urn:btih:${hex.toUpperCase()}`), hex);
  // a 32-char base32 btih decodes to 40 hex chars
  const decoded = magnetInfoHash('magnet:?xt=urn:btih:AERSIRUJRXHU7ARSIRUJRXHU7AJDINLH');
  assert.match(decoded ?? '', /^[a-f0-9]{40}$/);
  assert.equal(magnetInfoHash('magnet:?xt=urn:ed2k:abc'), undefined);
  assert.equal(magnetInfoHash('not a magnet'), undefined);
  assert.equal(magnetInfoHash('magnet:?xt=urn:btih:tooshort'), undefined);
});

test('toMagnet builds a btih magnet with an optional display name', () => {
  assert.equal(toMagnet('abc'), 'magnet:?xt=urn:btih:abc');
  assert.equal(toMagnet('abc', 'The Movie (2020)'), 'magnet:?xt=urn:btih:abc&dn=The%20Movie%20(2020)');
});
