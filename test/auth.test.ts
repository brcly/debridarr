import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sessions, sessionCookie } from '../src/admin/auth.js';

test('sessions expire, revoke, and do not survive process/session-manager restart', () => {
  let now = 0;
  const sessions = new Sessions('password', () => now);
  const result = sessions.login('password', 'address');
  assert.ok(typeof result === 'object');
  assert.equal(sessions.get(result.token)?.csrfToken, result.session.csrfToken);
  assert.equal(new Sessions('password').get(result.token), undefined);
  now = 12 * 60 * 60 * 1000;
  assert.equal(sessions.get(result.token), undefined);
  const next = sessions.login('password', 'address');
  assert.ok(typeof next === 'object');
  sessions.delete(next.token);
  assert.equal(sessions.get(next.token), undefined);
  assert.match(sessionCookie('token', true), /HttpOnly; SameSite=Strict; Max-Age=43200; Secure/);
  assert.match(sessionCookie('', false, true), /Max-Age=0$/);
});

test('failed logins are throttled and recover after the window', () => {
  let now = 0;
  const sessions = new Sessions('password', () => now);
  for (let i = 0; i < 5; i++) assert.equal(sessions.login('wrong', 'address'), 'invalid');
  assert.equal(sessions.login('password', 'address'), 'throttled');
  now = 15 * 60 * 1000;
  assert.ok(typeof sessions.login('password', 'address') === 'object');
});
