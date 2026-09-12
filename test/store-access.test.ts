import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { StoreAccess } from '../src/store/access.js';
import { tmpDir } from './helpers.js';

async function fixture(t: TestContext) {
  const dir = await tmpDir(t, 'debridarr-tokens');
  return { dir, access: await StoreAccess.open(dir) };
}
test('tokens are shown once, hashed on disk, durable, and independently revocable', async t => {
  const { dir, access } = await fixture(t);
  const first = await access.create({ name: 'First' });
  const second = await access.create({ name: 'Second' });
  assert.match(first.token, /^[\w-]{43}$/);
  assert.equal((await stat(join(dir, 'store.json'))).mode & 0o777, 0o600);
  assert.ok(!(await readFile(join(dir, 'store.json'), 'utf8')).includes(first.token));
  assert.ok(!JSON.stringify(access.list()).includes('digest'));
  const reopened = await StoreAccess.open(dir);
  assert.equal((await reopened.authenticate(first.token, 'local'))?.id, first.item.id);
  assert.ok((await StoreAccess.open(dir)).list()[0]!.lastUsedAt);
  await reopened.revoke(first.item.id);
  assert.equal(await reopened.authenticate(first.token, 'local'), undefined);
  assert.equal((await reopened.authenticate(second.token, 'local'))?.id, second.item.id);
});
test('failed auth is throttled by source and expires; quotas isolate tokens and release concurrency', async t => {
  const { access } = await fixture(t);
  const { token, item } = await access.create({ name: 'Limited', quotas: { concurrentRequests: 1, requestsPerMinute: 2 } });
  const other = await access.create({ name: 'Other' });
  for (let n = 0; n < 5; n++) assert.equal(await access.authenticate('invalid', 'bad', 0), undefined);
  await assert.rejects(access.authenticate(token, 'bad', 1), /busy/);
  assert.ok(await access.authenticate(token, 'good', 1));
  assert.ok(await access.authenticate(token, 'bad', 900_001));
  const release = access.enter(item, 0);
  assert.throws(() => access.enter(item, 0), /busy/);
  access.enter(other.item, 0)();
  release(); release();
  access.enter(item, 1)();
  assert.throws(() => access.enter(item, 2), /busy/);
  access.enter(item, 60_001)();
});
test('token storage rejects corrupt data, concurrent creates are serialized, and names/quotas are bounded', async t => {
  const { dir, access } = await fixture(t);
  for (const options of [{ name: '' }, { name: 'x', quotas: { concurrentRequests: 0 } }, { name: 'x', quotas: { requestsPerMinute: 1.1 } }]) await assert.rejects(access.create(options));
  await Promise.all(Array.from({ length: 10 }, (_, i) => access.create({ name: String(i) })));
  assert.equal((await StoreAccess.open(dir)).list().length, 10);
  await writeFile(join(dir, 'store.json'), '{"version":2,"tokens":[]}');
  await assert.rejects(StoreAccess.open(dir), /invalid/);
  assert.equal(await readFile(join(dir, 'store.json'), 'utf8'), '{"version":2,"tokens":[]}');
});
test('tokens default to full access, accept a narrower scope set, and reject unknown scopes', async t => {
  const { access } = await fixture(t);
  assert.deepEqual((await access.create({ name: 'Default' })).item.scopes, ['read', 'write', 'link']);
  const narrow = await access.create({ name: 'Reader', scopes: ['read'] });
  assert.deepEqual(narrow.item.scopes, ['read']);
  // Order is normalised, duplicates and unknowns are refused.
  assert.deepEqual((await access.create({ name: 'Ordered', scopes: ['link', 'read'] })).item.scopes, ['read', 'link']);
  for (const scopes of [[], ['admin'], ['read', 'read']]) await assert.rejects(access.create({ name: 'x', scopes }));
  assert.deepEqual(access.list().find(t => t.id === narrow.item.id)?.scopes, ['read']);
});
test('a schema-1 store file migrates to scoped tokens and a persisted link secret', async t => {
  const { dir } = await fixture(t);
  const secret = 'legacy-secret-value';
  const legacy = {
    version: 1,
    tokens: [{ id: 'a'.repeat(32), name: 'Legacy', createdAt: 1, lastUsedAt: null,
      quotas: { requestsPerMinute: 120, concurrentRequests: 4 }, digest: createHash('sha256').update(secret).digest('hex') }],
  };
  await writeFile(join(dir, 'store.json'), JSON.stringify(legacy));
  const access = await StoreAccess.open(dir);
  assert.deepEqual(access.list()[0]!.scopes, ['read', 'write', 'link']);
  assert.equal((await access.authenticate(secret, 'local'))?.id, 'a'.repeat(32));
  assert.equal(access.linkSecret().length, 32);
  const persisted = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'));
  assert.equal(persisted.version, 2);
  assert.match(persisted.linkSecret, /^[\w-]{43}$/);
  assert.deepEqual(persisted.tokens[0].scopes, ['read', 'write', 'link']);
});
