import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COOKIE_NAME, cookieValue, Sessions, sessionCookie } from '../src/admin/auth.js';

test('sessions expire, revoke, and do not survive process/session-manager restart', async () => {
  let now = 0;
  const sessions = new Sessions('password', () => now);
  const result = await sessions.login('password', 'address');
  assert.ok(typeof result === 'object');
  assert.equal(sessions.get(result.token)?.csrfToken, result.session.csrfToken);
  assert.equal(new Sessions('password').get(result.token), undefined);
  now = 12 * 60 * 60 * 1000;
  assert.equal(sessions.get(result.token), undefined);
  const next = await sessions.login('password', 'address');
  assert.ok(typeof next === 'object');
  sessions.delete(next.token);
  assert.equal(sessions.get(next.token), undefined);
  assert.match(sessionCookie('token', true), /HttpOnly; SameSite=Strict; Max-Age=43200; Secure/);
  assert.match(sessionCookie('', false, true), /Max-Age=0$/);
});

test('CSRF tokens are validated as fixed-size hexadecimal values', async () => {
  const sessions = new Sessions('password');
  const result = await sessions.login('password', 'address');
  assert.ok(typeof result === 'object');
  const { validCsrf } = await import('../src/admin/auth.js');
  assert.equal(validCsrf(result.session.csrfToken, result.session.csrfToken), true);
  assert.equal(validCsrf('wrong', result.session.csrfToken), false);
  assert.equal(validCsrf('0'.repeat(64), result.session.csrfToken), false);
});

test('cookieValue matches the named cookie and ignores malformed siblings', () => {
  assert.equal(cookieValue(undefined, COOKIE_NAME), '');
  assert.equal(cookieValue(`${COOKIE_NAME}=abc`, COOKIE_NAME), 'abc');
  assert.equal(cookieValue(`other=1; ${COOKIE_NAME}=abc; extra=2`, COOKIE_NAME), 'abc');
  assert.equal(cookieValue(`=broken; ${COOKIE_NAME}=abc`, COOKIE_NAME), 'abc');
  assert.equal(cookieValue('not_a_pair; foo', COOKIE_NAME), '');
  assert.equal(cookieValue(`${COOKIE_NAME}="quoted"`, COOKIE_NAME), 'quoted');
  assert.equal(cookieValue(`prefix-${COOKIE_NAME}=nope; ${COOKIE_NAME}=yes`, COOKIE_NAME), 'yes');
});

test('failed logins are throttled and recover after the window', async () => {
  let now = 0;
  const sessions = new Sessions('password', () => now);
  for (let i = 0; i < 5; i++) assert.equal(await sessions.login('wrong', 'address'), 'invalid');
  assert.equal(await sessions.login('password', 'address'), 'throttled');
  now = 15 * 60 * 1000;
  assert.ok(typeof (await sessions.login('password', 'address')) === 'object');
});
