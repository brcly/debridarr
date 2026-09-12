import assert from 'node:assert/strict';
import { test } from 'node:test';
import { objectRecord } from '../src/json.js';
import { redactPath } from '../src/log.js';
import { isHex40, parseDbId, parseHex40 } from '../src/domain/ids.js';

test('objectRecord accepts plain objects and fails closed on arrays, null, and primitives', () => {
  assert.deepEqual(objectRecord({ a: 1 }), { a: 1 });
  assert.equal(objectRecord(null), undefined);
  assert.equal(objectRecord([1, 2]), undefined);
  assert.equal(objectRecord('x'), undefined);
  assert.equal(objectRecord(1), undefined);
  assert.equal(objectRecord(undefined), undefined);
});

test('redactPath hides addon keys, play tokens, and signed download links', () => {
  assert.equal(redactPath(`/addon/${'A'.repeat(43)}/manifest.json`), '/addon/[redacted]/manifest.json');
  assert.equal(redactPath('/play/secret-token'), '/play/[redacted]');
  assert.equal(redactPath('/api/v1/download/abc.def'), '/api/v1/download/[redacted]');
  assert.equal(redactPath('/health'), '/health');
});

test('parseHex40 and parseDbId accept 40-hex identities', () => {
  assert.equal(parseHex40('A'.repeat(40)), 'a'.repeat(40));
  assert.equal(isHex40('z'.repeat(40)), false);
  assert.equal(parseDbId(`db:${'B'.repeat(40)}`), 'b'.repeat(40));
  assert.equal(parseDbId('db:nope'), undefined);
});
