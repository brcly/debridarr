import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type {
  AddonAccessRepository, DownloadsRepository, IdempotencyRepository, JobsRepository, SettingsRepository, StoreAccessRepository,
} from '../src/state/repositories.js';
import type { DownloadRecord } from '../src/downloads/store.js';
import type { PrepareTransferRequest } from '../src/application/types.js';
import { TTL } from '../src/security/addon.js';
import { JsonSettingsStore } from '../src/state/json/settings.js';
import { JsonDownloadsStore } from '../src/state/json/downloads.js';
import { JsonStoreAccess } from '../src/state/json/access.js';
import { JsonAddonAccess } from '../src/state/json/addon.js';
import { JsonIdempotencyStore } from '../src/state/json/idempotency.js';
import { JsonJobsStore } from '../src/state/json/jobs.js';
import { openDatabase } from '../src/state/sqlite/db.js';
import { SqliteSettingsStore } from '../src/state/sqlite/settings.js';
import { SqliteDownloadsStore } from '../src/state/sqlite/downloads.js';
import { SqliteStoreAccess } from '../src/state/sqlite/access.js';
import { SqliteAddonAccess } from '../src/state/sqlite/addon.js';
import { SqliteIdempotencyStore } from '../src/state/sqlite/idempotency.js';
import { SqliteJobsStore } from '../src/state/sqlite/jobs.js';
import { tmpDir } from './helpers.js';

// Exercises the four repository interfaces against both drivers with the same
// assertions, so behaviour parity between src/state/json and src/state/sqlite
// is proven directly rather than assumed.

async function dir(t: TestContext): Promise<string> {
  const path = await tmpDir(t, 'debridarr-state');
  return path;
}

const record = (over: Partial<DownloadRecord> = {}): DownloadRecord => ({
  origin: 'search', infoHash: 'a'.repeat(40), name: 'The Matrix (1999)', media: { imdbId: 'tt0133093', type: 'movie' },
  fileIndex: 0, fileName: 'The.Matrix.1999/movie.mkv', bytes: 8_000_000_000,
  addedAt: 1_700_000_000_000, expiresAt: 1_700_000_000_000 + 2_592_000_000, kept: false, ...over,
});

const prepareRequest = (over: Partial<PrepareTransferRequest> = {}): PrepareTransferRequest => ({
  source: { infoHash: 'b'.repeat(40) }, origin: 'search', name: 'The Matrix (1999)', bytes: 8_000_000_000, ...over,
});

interface Drivers {
  settings: () => Promise<SettingsRepository>;
  downloads: () => Promise<DownloadsRepository>;
  storeAccess: () => Promise<StoreAccessRepository>;
  addonAccess: () => Promise<AddonAccessRepository>;
  idempotency: () => Promise<IdempotencyRepository>;
  jobs: () => Promise<JobsRepository>;
}

function jsonDriver(dataDir: string): Drivers {
  return {
    settings: () => JsonSettingsStore.open(dataDir, {}),
    downloads: () => JsonDownloadsStore.open(dataDir),
    storeAccess: () => JsonStoreAccess.open(dataDir),
    addonAccess: () => JsonAddonAccess.open(dataDir),
    idempotency: () => JsonIdempotencyStore.open(dataDir),
    jobs: () => JsonJobsStore.open(dataDir),
  };
}

function sqliteDriver(dataDir: string): Drivers {
  const db = openDatabase(dataDir);
  return {
    settings: async () => SqliteSettingsStore.open(db, {}),
    downloads: async () => new SqliteDownloadsStore(db),
    storeAccess: async () => SqliteStoreAccess.open(db),
    addonAccess: async () => SqliteAddonAccess.open(db),
    idempotency: async () => new SqliteIdempotencyStore(db),
    jobs: async () => new SqliteJobsStore(db),
  };
}

async function runSettingsContract(drivers: Drivers): Promise<void> {
  const settings = await drivers.settings();
  assert.deepEqual(settings.snapshot().discovery.providers, []);
  const updated = await settings.update({ discovery: { providers: [{ type: 'prowlarr', url: 'http://prowlarr.test', apiKey: 'new-key' }] } });
  assert.equal(updated.discovery.providers[0]!.apiKey, 'new-key');
  assert.equal(settings.snapshot().discovery.providers[0]!.apiKey, 'new-key');
}

async function runDownloadsContract(drivers: Drivers): Promise<void> {
  const downloads = await drivers.downloads();
  assert.deepEqual(downloads.list(), []);
  const saved = await downloads.upsert(record());
  assert.equal(saved.infoHash, 'a'.repeat(40));
  assert.deepEqual(downloads.get('a'.repeat(40)), saved);
  assert.equal(downloads.list().length, 1);

  const kept = await downloads.setKept('a'.repeat(40), true);
  assert.equal(kept?.kept, true);

  const renewed = await downloads.renew('a'.repeat(40), 1_800_000_000_000);
  assert.equal(renewed?.expiresAt, 1_800_000_000_000);

  await downloads.remove('a'.repeat(40));
  assert.equal(downloads.get('a'.repeat(40)), undefined);
  assert.deepEqual(downloads.list(), []);
}

async function runStoreAccessContract(drivers: Drivers): Promise<void> {
  const storeAccess = await drivers.storeAccess();
  const secret = storeAccess.linkSecret();
  assert.equal(secret.length, 32);
  assert.deepEqual(storeAccess.linkSecret(), secret);

  const { token, item } = await storeAccess.create({ name: 'CLI' });
  assert.equal(storeAccess.list().length, 1);
  assert.equal(storeAccess.list()[0]?.id, item.id);
  assert.ok(!('digest' in storeAccess.list()[0]!));

  const authed = await storeAccess.authenticate(token, '127.0.0.1');
  assert.equal(authed?.id, item.id);
  const rejected = await storeAccess.authenticate('wrong-token', '127.0.0.1');
  assert.equal(rejected, undefined);

  const release = storeAccess.enter(item);
  release();

  await storeAccess.revoke(item.id);
  assert.deepEqual(storeAccess.list(), []);
}

async function runAddonAccessContract(drivers: Drivers): Promise<void> {
  const addonAccess = await drivers.addonAccess();
  const key = addonAccess.base('https://example.test').split('/addon/')[1]!;
  assert.equal(addonAccess.valid(key), true);
  assert.equal(addonAccess.valid('x'.repeat(43)), false);

  const [id] = await addonAccess.issue([prepareRequest()], 'browse');
  assert.ok(id);
  const fetched = addonAccess.get(id!, 'browse');
  assert.deepEqual(fetched, prepareRequest());
  assert.equal(addonAccess.get(id!, 'other-source'), undefined);

  await addonAccess.rotate();
  assert.equal(addonAccess.valid(key), false);
  assert.equal(addonAccess.get(id!, 'browse'), undefined);

  const [id2] = await addonAccess.issue([prepareRequest()], 'browse');
  await addonAccess.invalidate();
  assert.equal(addonAccess.get(id2!, 'browse'), undefined);

  const [id3] = await addonAccess.issue([prepareRequest()], 'browse', 10);
  assert.equal(await addonAccess.pruneExpired(10), 0);
  assert.ok(addonAccess.get(id3!, 'browse', 10));
  assert.equal(await addonAccess.pruneExpired(10 + TTL + 1), 1);
  assert.equal(addonAccess.get(id3!, 'browse', 10), undefined);
  assert.equal(await addonAccess.pruneExpired(10 + TTL + 1), 0);
}

async function runIdempotencyContract(drivers: Drivers): Promise<void> {
  const idempotency = await drivers.idempotency();
  const now = 1_700_000_000_000;
  assert.equal(idempotency.get('tok\0key', now), undefined);

  await idempotency.put('tok\0key', { status: 201, body: { transfer: { id: 'abc' } } }, now);
  assert.deepEqual(idempotency.get('tok\0key', now), { status: 201, body: { transfer: { id: 'abc' } } });

  // A different token or key never sees another's stored response.
  assert.equal(idempotency.get('tok\0other', now), undefined);
  assert.equal(idempotency.get('other\0key', now), undefined);

  // Expired past the 24h TTL: forgotten.
  assert.equal(idempotency.get('tok\0key', now + 24 * 60 * 60 * 1000 + 1), undefined);
}

async function runJobsContract(drivers: Drivers): Promise<void> {
  const jobs = await drivers.jobs();
  assert.deepEqual(jobs.list(), []);

  await jobs.ensure('sweep', 'sweep', 1_000);
  await jobs.ensure('sweep', 'sweep', 9_999); // second call is a no-op: the job already exists
  assert.equal(jobs.list().length, 1);
  assert.equal(jobs.list()[0]?.nextRunAt, 1_000);

  assert.equal(await jobs.claimDue(500, 5_000, 'runner-a'), undefined, 'not due yet');
  const claimed = await jobs.claimDue(1_000, 5_000, 'runner-a');
  assert.equal(claimed?.id, 'sweep');
  assert.equal(claimed?.attempts, 0);

  // Leased: a second runner cannot claim it again before the lease expires.
  assert.equal(await jobs.claimDue(1_500, 5_000, 'runner-b'), undefined);
  // Lease expired: claimable again, simulating a crashed runner's job being resumed.
  const reclaimed = await jobs.claimDue(6_001, 5_000, 'runner-b');
  assert.equal(reclaimed?.id, 'sweep');

  await jobs.reschedule('sweep', 20_000, 0, null);
  assert.equal(jobs.list()[0]?.nextRunAt, 20_000);
  assert.equal(jobs.list()[0]?.leaseUntil, null, 'reschedule clears the lease');

  await jobs.ensure('delete-retry:abc', 'delete-retry', 100, 'abc'.padEnd(40, '0'));
  const retryJob = await jobs.claimDue(100, 5_000, 'runner-a');
  assert.equal(retryJob?.payload, 'abc'.padEnd(40, '0'));
  await jobs.reschedule('delete-retry:abc', 15_100, 1, 'still expired');
  assert.equal(jobs.list().find(j => j.id === 'delete-retry:abc')?.attempts, 1);

  await jobs.remove('delete-retry:abc');
  assert.equal(jobs.list().find(j => j.id === 'delete-retry:abc'), undefined);
}

for (const [name, factory] of [
  ['json', jsonDriver],
  ['sqlite', sqliteDriver],
] as const) {
  test(`${name} driver: settings repository contract`, async t => runSettingsContract(factory(await dir(t))));
  test(`${name} driver: downloads repository contract`, async t => runDownloadsContract(factory(await dir(t))));
  test(`${name} driver: store access repository contract`, async t => runStoreAccessContract(factory(await dir(t))));
  test(`${name} driver: addon access repository contract`, async t => runAddonAccessContract(factory(await dir(t))));
  test(`${name} driver: idempotency repository contract`, async t => runIdempotencyContract(factory(await dir(t))));
  test(`${name} driver: jobs repository contract`, async t => runJobsContract(factory(await dir(t))));
}

test('sqlite driver: idempotency survives closing and reopening the database (restart)', async t => {
  const dataDir = await dir(t);
  const db1 = openDatabase(dataDir);
  const repo1 = new SqliteIdempotencyStore(db1);
  await repo1.put('tok\0key', { status: 202, body: { transfer: { id: 'xyz' } } }, 1_700_000_000_000);
  db1.close();

  const db2 = openDatabase(dataDir);
  const repo2 = new SqliteIdempotencyStore(db2);
  assert.deepEqual(repo2.get('tok\0key', 1_700_000_000_000), { status: 202, body: { transfer: { id: 'xyz' } } });
});

test('sqlite driver: a job claimed just before a crash is resumed, not lost, after restart', async t => {
  const dataDir = await dir(t);
  const db1 = openDatabase(dataDir);
  const repo1 = new SqliteJobsStore(db1);
  await repo1.ensure('sweep', 'sweep', 1_000);
  const claimed = await repo1.claimDue(1_000, 30_000, 'runner-a');
  assert.equal(claimed?.id, 'sweep');
  db1.close(); // crash: the job never gets rescheduled or released

  const db2 = openDatabase(dataDir);
  const repo2 = new SqliteJobsStore(db2);
  assert.equal(await repo2.claimDue(1_010, 30_000, 'runner-b'), undefined, 'still leased');
  const resumed = await repo2.claimDue(31_001, 30_000, 'runner-b');
  assert.equal(resumed?.id, 'sweep');
});

test('json driver: concurrent jobs and idempotency writes survive reopening (restart)', async t => {
  const jsonDir = await dir(t);
  const jobs = await JsonJobsStore.open(jsonDir);
  const idempotency = await JsonIdempotencyStore.open(jsonDir);
  await Promise.all([
    jobs.ensure('delete-retry:abc', 'deleteRetry', 5_000, 'abc'),
    jobs.ensure('delete-retry:def', 'deleteRetry', 6_000, 'def'),
    idempotency.put('key-1', { status: 201, body: '{"id":"t1"}' }, 1_000),
    idempotency.put('key-2', { status: 202, body: '{"id":"t2"}' }, 1_001),
  ]);

  const reopenedJobs = await JsonJobsStore.open(jsonDir);
  const reopenedIdempotency = await JsonIdempotencyStore.open(jsonDir);
  assert.deepEqual(reopenedJobs.list().map(row => row.id).sort(), ['delete-retry:abc', 'delete-retry:def']);
  assert.equal(reopenedIdempotency.get('key-1', 1_001)?.status, 201);
  assert.equal(reopenedIdempotency.get('key-2', 1_001)?.status, 202);
});
