import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appFixture } from './app-fixture.js';

test('a request id is generated when absent, echoed back, and included in the generic error body', async t => {
  const f = await appFixture(t, { prefix: 'debridarr-reqid-' });
  const response = await fetch(`${f.base}/no-such-route`);
  assert.equal(response.status, 404);
  const id = response.headers.get('x-request-id');
  assert.match(id ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'generated id is a UUID');
  const body = await response.json();
  assert.equal(body.requestId, id);
});

test('a valid client-supplied X-Request-Id is echoed back verbatim and used in the error body', async t => {
  const f = await appFixture(t, { prefix: 'debridarr-reqid-echo-' });
  const response = await fetch(`${f.base}/no-such-route`, { headers: { 'X-Request-Id': 'client-supplied-id-123' } });
  assert.equal(response.headers.get('x-request-id'), 'client-supplied-id-123');
  assert.equal((await response.json()).requestId, 'client-supplied-id-123');
});

test('an invalid or oversized X-Request-Id is replaced with a generated one, not trusted verbatim', async t => {
  const f = await appFixture(t, { prefix: 'debridarr-reqid-invalid-' });
  // A raw newline/control character can't even be constructed through fetch()'s
  // Headers (and the HTTP wire parser would reject it too); these are the
  // shapes a well-formed-but-hostile header value can actually take.
  for (const bad of ['has spaces', 'a'.repeat(200), '']) {
    const response = await fetch(`${f.base}/no-such-route`, { headers: bad ? { 'X-Request-Id': bad } : {} });
    const id = response.headers.get('x-request-id');
    assert.notEqual(id, bad);
    assert.match(id ?? '', /^[0-9a-f-]{36}$/);
  }
});

test('the native API error body (sendApiError) also carries the request id', async t => {
  const f = await appFixture(t, { prefix: 'debridarr-reqid-apiv1-' });
  const response = await fetch(`${f.base}/api/v1/transfers`);
  assert.equal(response.status, 401);
  const id = response.headers.get('x-request-id');
  assert.ok(id);
  const body = await response.json();
  assert.equal(body.error.code, 'unauthorized');
  assert.equal(body.requestId, id);
});
