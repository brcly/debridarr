import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DownloadsStore, type DownloadRecord } from '../src/downloads/store.js';

const record = (over: Partial<DownloadRecord> = {}): DownloadRecord => ({
  infoHash: 'a'.repeat(40), name: 'The Matrix (1999)', imdbId: 'tt0133093', type: 'movie',
  fileIndex: 0, fileName: 'The.Matrix.1999/movie.mkv', bytes: 8_000_000_000,
  addedAt: 1_700_000_000_000, expiresAt: 1_700_000_000_000 + 2_592_000_000, kept: false, ...over,
});

async function dir(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'debridarr-dl-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('seeds an empty file, then persists upserts and removals across reopen', async t => {
  const path = await dir(t);
  const store = await DownloadsStore.open(path);
  assert.deepEqual(store.list(), []);
  assert.equal((await stat(join(path, 'downloads.json'))).mode & 0o777, 0o600);

  await store.upsert(record());
  await store.upsert(record({ infoHash: 'B'.repeat(40), name: 'Later', addedAt: 1_700_000_100_000, imdbId: 'tt0111161', type: 'series', season: 1, episode: 2 }));
  assert.deepEqual(store.list().map(r => r.name), ['Later', 'The Matrix (1999)'], 'newest first');
  assert.equal(store.get('B'.repeat(40))?.infoHash, 'b'.repeat(40), 'hash lower-cased');

  const reopened = await DownloadsStore.open(path);
  assert.deepEqual(reopened.list(), store.list());
  assert.equal(reopened.get('a'.repeat(40))?.type, 'movie');

  await reopened.remove('A'.repeat(40));
  assert.equal(reopened.get('a'.repeat(40)), undefined);
  assert.deepEqual((await DownloadsStore.open(path)).list().map(r => r.infoHash), ['b'.repeat(40)]);
});

test('setKept toggles only the retention flag and is durable', async t => {
  const path = await dir(t);
  const store = await DownloadsStore.open(path);
  await store.upsert(record());
  const kept = await store.setKept('a'.repeat(40), true);
  assert.equal(kept?.kept, true);
  assert.equal(kept?.expiresAt, record().expiresAt, 'expiry untouched');
  assert.equal((await DownloadsStore.open(path)).get('a'.repeat(40))?.kept, true);
  assert.equal(await store.setKept('c'.repeat(40), true), undefined, 'unknown hash');
});

test('renew updates only expiresAt and is durable', async t => {
  const path = await dir(t);
  const store = await DownloadsStore.open(path);
  await store.upsert(record({ kept: true }));
  const renewed = await store.renew('a'.repeat(40), 1_800_000_000_000);
  assert.equal(renewed?.expiresAt, 1_800_000_000_000);
  assert.equal(renewed?.kept, true, 'kept untouched');
  assert.equal((await DownloadsStore.open(path)).get('a'.repeat(40))?.expiresAt, 1_800_000_000_000);
  assert.equal(await store.renew('c'.repeat(40), 1), undefined, 'unknown hash');
});

test('snapshots are copies; a failing write leaves memory and disk intact', async t => {
  const path = await dir(t);
  const store = await DownloadsStore.open(path);
  await store.upsert(record());
  const snap = store.get('a'.repeat(40))!;
  snap.name = 'mutated';
  assert.equal(store.get('a'.repeat(40))?.name, 'The Matrix (1999)');
});

test('corrupt or unsupported downloads.json is surfaced, never reset', async t => {
  const path = await dir(t);
  for (const contents of ['{oops', '{"version":3,"downloads":[]}', '{"version":1,"downloads":[{"infoHash":"nope"}]}']) {
    await writeFile(join(path, 'downloads.json'), contents);
    await assert.rejects(DownloadsStore.open(path), /invalid or unsupported/);
    assert.equal(await readFile(join(path, 'downloads.json'), 'utf8'), contents);
  }
});
