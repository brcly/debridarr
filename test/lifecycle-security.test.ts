import { DownloadRecovery } from '../src/downloads/recovery.js';
import { createServer } from 'node:http';
import type { Config } from '../src/config.js';
import { handlePlay } from '../src/playback/index.js';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QBittorrentClient } from '../src/integrations/qbittorrent/client.js';
import type { BackendOwnership, TorrentFile, TorrentSnapshot, TorrentSource } from '../src/backends/torrent.js';
import { DownloadsStore, type DownloadRecord } from '../src/downloads/store.js';
import { ensureTransfer, DAY_MS, QueuedAdmission, type EnsureOptions } from '../src/downloads/manager.js';
import { deleteManaged } from '../src/downloads/deletion.js';
import { SettingsStore } from '../src/settings.js';
import { sweepOnce } from '../src/retention/sweeper.js';
import { markActive, markInactive } from '../src/playback/active.js';
import type { DirectTransferSource, TransferMedia } from '../src/application/types.js';
import { listen, playRequest, tmpDir, type PlayShape } from './helpers.js';

const ensureDownload = (target: PlayShape, options: EnsureOptions) => ensureTransfer(playRequest(target), options);
const ensureStoreDownload = (input: { source: DirectTransferSource; name: string; media?: TransferMedia }, options: EnsureOptions) =>
  ensureTransfer({ ...input, origin: 'store', bytes: 0 }, options);

const hash = 'a'.repeat(40);
const movie: PlayShape = { title: 'Movie', imdbId: 'tt1', type: 'movie', size: 100, infoHash: hash };
class FakeQbt extends QBittorrentClient {
  torrents = new Map<string, TorrentSnapshot>();
  fileList: TorrentFile[] = [{ id: 0, path: 'movie.mkv', bytes: 100, progress: 1, selected: true }];
  writes: string[] = [];
  onAdd: (() => Promise<void>) | undefined;
  onDelete: ((hash: string) => Promise<void>) | undefined;
  constructor() { super({ url: 'http://fixture-qbt', username: 'u', password: 'p' }); }
  override async get(hash: string) { return structuredClone(this.torrents.get(hash)); }
  override async list() { return structuredClone([...this.torrents.values()]); }
  override async freeSpace() { return 100e9; }
  override async getFiles() { return structuredClone(this.fileList); }
  override async submit(source: TorrentSource, options: { ownership: BackendOwnership }) {
    if (source.type !== 'magnet') throw new Error('Unexpected source');
    const hash = new URL(source.magnet).searchParams.get('xt')!.slice(-40);
    this.writes.push(`add:${hash}`);
    this.torrents.set(hash, {
      infoHash: hash, scope: options.ownership.scope, markers: [options.ownership.marker], name: 'Movie', state: 'downloading', progress: 0,
      bytes: 100, ratio: 0, savePath: '/downloads', contentPath: '/downloads/movie.mkv', bytesRemaining: 100,
      seeders: 0, leechers: 0, downloadSpeed: 0, eta: 0, sequentialDownload: true, firstLastPieces: true,
    });
    await this.onAdd?.();
  }
  override async addMarker(hash: string, marker: string) { this.writes.push('tag'); this.torrents.get(hash)!.markers.push(marker); }
  override async setShareLimits() { this.writes.push('limits'); }
  override async setRunning() { this.writes.push('running'); }
  override async setFilesSelected(_hash: string, ids: number[], selected: boolean) {
    this.writes.push('priority');
    for (const file of this.fileList) if (ids.includes(file.id)) file.selected = selected;
  }
  override async remove(hash: string) {
    this.writes.push(`delete:${hash}`);
    await this.onDelete?.(hash);
    this.torrents.delete(hash);
  }
}
async function fixture(t: TestContext) {
  const dir = await tmpDir(t, 'debridarr-lifecycle');
  const downloads = await DownloadsStore.open(dir);
  const settings = await SettingsStore.open(dir, {});
  await settings.update({ downloadBackend: { url: 'http://fixture-qbt', username: 'u', password: 'p' } });
  const qbt = new FakeQbt();
  const options = { backend: qbt, store: downloads, signal: AbortSignal.timeout(5000) };
  const sweep = () => sweepOnce({ store: settings, downloads, backendFactory: () => qbt });
  return { dir, downloads, settings, qbt, options, sweep };
}

test('failed deletion remains durable and retryable; Keep and playback conflict once deletion starts', async t => {
  const { dir, downloads, qbt, options, sweep } = await fixture(t);
  await ensureDownload(movie, options);
  await downloads.setKept(hash, true); // An explicit manual deletion overrides Keep.
  qbt.onDelete = async () => { throw new Error('upstream unavailable'); };
  await assert.rejects(deleteManaged(downloads, qbt, hash, options.signal), /unavailable/);
  assert.equal(downloads.get(hash)?.lifecycle, 'deleting');
  assert.equal((await DownloadsStore.open(dir)).get(hash)?.lifecycle, 'deleting');
  await assert.rejects(downloads.setKept(hash, true), /Deletion/);
  await assert.rejects(ensureDownload(movie, options), /Deletion/);
  const failed = await sweep();
  assert.deepEqual(failed.deleted, []);
  assert.ok(failed.failed.includes(hash));
  assert.ok(downloads.get(hash));
  qbt.onDelete = undefined;
  const retried = await sweep();
  assert.deepEqual(retried.deleted, [hash]);
  assert.equal(downloads.get(hash), undefined);
});

test('a successful delete reply without confirmed absence does not discard tracking', async t => {
  const { downloads, qbt, options } = await fixture(t);
  await ensureDownload(movie, options);
  qbt.remove = async () => {};
  await assert.rejects(deleteManaged(downloads, qbt, hash, options.signal), /confirmed deletion/);
  assert.equal(downloads.get(hash)?.lifecycle, 'deleting');
});

test('lost add replies retain registration intent and are reconciled after reopening storage', async t => {
  const { dir, downloads, settings, qbt, options } = await fixture(t);
  qbt.onAdd = async () => {
    assert.equal((await DownloadsStore.open(dir)).get(hash)?.lifecycle, 'registering', 'intent precedes network add');
    throw new Error('lost add reply');
  };
  await assert.rejects(ensureDownload(movie, options), /lost add reply/);
  assert.equal(downloads.get(hash)?.lifecycle, 'registering');
  const reopened = await DownloadsStore.open(dir);
  await new DownloadRecovery({ store: settings, downloads: reopened, backendFactory: () => qbt }).run();
  assert.equal(reopened.get(hash)?.lifecycle, 'managed');
  assert.equal(qbt.writes.filter(w => w.startsWith('add:')).length, 1);
});

test('unplayable additions stay tracked until verified cleanup succeeds', async t => {
  const { downloads, qbt, options, sweep } = await fixture(t);
  qbt.fileList = [{ id: 0, path: 'archive.zip', bytes: 100, progress: 1, selected: true }];
  await assert.rejects(ensureDownload(movie, options), /wanted file/);
  assert.equal(downloads.get(hash)?.lifecycle, 'failed');
  assert.equal(qbt.torrents.size, 1);
  const result = await sweep();
  assert.deepEqual(result.deleted, [hash]);
  assert.equal(downloads.list().length, 0);
});

test('concurrent episodes share registration and preserve both file selections', async t => {
  const { downloads, qbt, options } = await fixture(t);
  qbt.fileList = [1,2].map((episode, id) => ({ id, path: `Show.S01E0${episode}.mkv`, bytes: 100, progress: 1, selected: true }));
  const episode = (n: number): PlayShape => ({ ...movie, title: 'Show S01', type: 'series', season: 1, episode: n });
  const [first, second] = await Promise.all([ensureDownload(episode(1), options), ensureDownload(episode(2), options)]);
  assert.equal(first.file.path, 'Show.S01E01.mkv');
  assert.equal(second.file.path, 'Show.S01E02.mkv');
  assert.equal(qbt.writes.filter(w => w.startsWith('add:')).length, 1);
  assert.deepEqual(downloads.get(hash)?.selectedFiles?.map(f => f.index), [0,1]);
  assert.deepEqual(qbt.fileList.map(f => f.selected), [true,true]);
});

test('the incomplete download cap prevents an eleventh addition', async t => {
  const { downloads, qbt, options } = await fixture(t);
  for (let n = 1; n <= 10; n++) await ensureDownload({ ...movie, infoHash: n.toString(16).padStart(40, '0') }, options);
  await assert.rejects(ensureDownload(movie, options), /busy/);
  assert.equal(qbt.torrents.size, 10);
  assert.equal(downloads.list().length, 10);
});

test('changed category or client does not make a torrent stale or authorize mutation', async t => {
  const { downloads, qbt, settings, options, sweep } = await fixture(t);
  await ensureDownload(movie, options);
  qbt.torrents.get(hash)!.scope = 'personal';
  qbt.writes = [];
  await sweep();
  assert.equal(downloads.get(hash)?.lifecycle, 'conflict');
  assert.deepEqual(qbt.writes, []);
  await assert.rejects(ensureDownload(movie, options), /ownership/);
  qbt.torrents.get(hash)!.scope = 'debridarr';
  await settings.update({ downloadBackend: { url: 'http://replacement' } });
  const other = new QBittorrentClient({ url: 'http://replacement', username: 'u', password: 'p' });
  await assert.rejects(deleteManaged(downloads, other, hash, options.signal), /ownership/);
  assert.ok(downloads.get(hash));
});

test('cache eviction rechecks Keep, leases and active reservations after earlier deletions', async t => {
  for (const protection of ['kept','active','lease'] as const) {
    const { downloads, qbt, options, settings, sweep } = await fixture(t);
    const second = 'b'.repeat(40);
    await ensureDownload(movie, options);
    await ensureDownload({ ...movie, infoHash: second }, options);
    const future = Date.now() + DAY_MS;
    await downloads.renew(hash, future);
    await downloads.renew(second, future + 1);
    await settings.update({ retention: { maxCacheGB: 0.000000001 } });
    qbt.onDelete = async deleted => {
      if (deleted !== hash) return;
      if (protection === 'kept') await downloads.setKept(second, true);
      if (protection === 'active') markActive(second);
      if (protection === 'lease') await downloads.renew(second, future + DAY_MS);
    };
    try {
      const result = await sweep();
      assert.deepEqual(result.evicted, [hash], protection);
      assert.ok(downloads.get(second), protection);
    } finally { markInactive(second); }
  }
});

test('playback reserves a torrent before releasing preparation coordination', async t => {
  const { downloads, qbt, options } = await fixture(t);
  await ensureDownload(movie, { ...options, onReady: state => markActive(state.record.infoHash) });
  try { await assert.rejects(deleteManaged(downloads, qbt, hash, options.signal), /prepared or streamed/); }
  finally { markInactive(hash); }
});

test('unverified legacy records survive migration as conflicts', async t => {
  const { downloads, sweep } = await fixture(t);
  const legacy: DownloadRecord = { origin: 'search', infoHash: hash, name: 'Movie', media: { imdbId: 'tt1', type: 'movie' }, fileName: 'movie.mkv', fileIndex: 0,
    bytes: 100, addedAt: 0, expiresAt: 0, kept: false };
  await downloads.upsert(legacy);
  await sweep();
  assert.equal(downloads.get(hash)?.lifecycle, 'conflict');
  assert.equal(downloads.get(hash)?.owner, undefined);
});

test('concurrent episode playback and range requests return their own file bytes', async t => {
  const { dir, downloads, settings, qbt } = await fixture(t);
  qbt.fileList = [1,2].map((episode, id) => ({ id, path: `Show.S01E0${episode}.mkv`, bytes: 11, progress: 1, selected: true }));
  await writeFile(join(dir, 'Show.S01E01.mkv'), 'EPISODE_ONE');
  await writeFile(join(dir, 'Show.S01E02.mkv'), 'EPISODE_TWO');
  const base = await listen(createServer((request, response) => {
    const episode = request.url === '/1' ? 1 : 2;
    void handlePlay(request, response, playRequest({ ...movie, type: 'series', season: 1, episode }), {
      config: { downloadDir: dir } as Config, backend: qbt, store: downloads, retention: settings.snapshot().retention, readyWaitMs: 0,
    }).catch(() => { response.statusCode = 500; response.end(); });
  }), t);
  const responses = await Promise.all([fetch(`${base}/1`), fetch(`${base}/2`)]);
  assert.deepEqual(await Promise.all(responses.map(async r => [r.status, await r.text()])), [[200, 'EPISODE_ONE'], [200, 'EPISODE_TWO']]);
  const ranged = await Promise.all([fetch(`${base}/1`, { headers: { Range: 'bytes=8-10' } }), fetch(`${base}/2`, { headers: { Range: 'bytes=8-10' } })]);
  assert.deepEqual(await Promise.all(ranged.map(async r => [r.status, await r.text()])), [[206, 'ONE'], [206, 'TWO']]);
});


test('store admission has its own preparation bucket and incomplete cap', async t => {
  const { options, qbt } = await fixture(t);
  for (let n = 1; n <= 10; n++) await ensureDownload({ ...movie, infoHash: n.toString(16).padStart(40, '0') }, options);
  const addStore = (n: number) => ensureStoreDownload({ source: { infoHash: n.toString(16).padStart(40, '0') }, name: 'Store' }, { ...options, storeMaxActiveDownloads: 2 });
  await addStore(11);
  await addStore(12);
  await assert.rejects(addStore(13), /busy/);
  assert.equal(qbt.torrents.size, 12);
  await assert.rejects(
    ensureStoreDownload({ source: { infoHash: 'd'.repeat(40) }, name: 'Queued' }, { ...options, storeMaxActiveDownloads: 2, queueIfBusy: true }),
    (error: unknown) => error instanceof QueuedAdmission && error.record.lifecycle === 'queued',
  );
  assert.equal(qbt.torrents.size, 12, 'queued transfers are not submitted to the backend');
});

test('two blocked search preparations do not block a store preparation', async t => {
  const { options, qbt } = await fixture(t);
  await ensureDownload(movie, options);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = qbt.get.bind(qbt);
  qbt.get = async h => { if (h === hash) { entered(); await blocked; } return original(h); };
  const first = ensureDownload(movie, options);
  await started;
  const second = ensureDownload(movie, options);
  try {
    await assert.rejects(ensureDownload(movie, options), /busy/);
    await ensureStoreDownload({ source: { infoHash: 'b'.repeat(40) }, name: 'Store' }, options);
  } finally { release(); await Promise.all([first, second]); }
});

test('background recovery finishes an IMDb-less store registration with its original lease', async t => {
  const { options, qbt, downloads, settings } = await fixture(t);
  qbt.onAdd = async () => { throw new Error('lost reply'); };
  await assert.rejects(ensureStoreDownload({ source: { infoHash: hash }, name: 'Store' }, { ...options, retentionDays: 14 }), /lost reply/);
  const pending = downloads.get(hash)!;
  assert.equal(pending.lifecycle, 'registering');
  qbt.onAdd = undefined;
  await new DownloadRecovery({ store: settings, downloads, backendFactory: () => qbt }).run();
  const managed = downloads.get(hash)!;
  assert.equal(managed.lifecycle, 'managed');
  assert.equal(managed.origin, 'store');
  assert.equal(managed.media, undefined);
  assert.equal(managed.expiresAt, pending.expiresAt);
});

test('playing store content renews the store lease instead of the search lease', async t => {
  const { dir, downloads, settings, qbt, options } = await fixture(t);
  qbt.fileList[0]!.bytes = 5;
  await writeFile(join(dir, 'movie.mkv'), 'MOVIE');
  await ensureStoreDownload({ source: { infoHash: hash }, name: 'Store' }, { ...options, retentionDays: 1 });
  const base = await listen(createServer((request, response) => {
    void handlePlay(request, response, playRequest({ ...movie, origin: 'store' }), {
      config: { downloadDir: dir } as Config, backend: qbt, store: downloads, retention: settings.snapshot().retention,
    }).catch(() => { response.statusCode = 500; response.end(); });
  }), t);
  const before = Date.now();
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'MOVIE');
  const expiry = downloads.get(hash)!.expiresAt;
  assert.ok(expiry >= before + 14 * DAY_MS && expiry <= Date.now() + 14 * DAY_MS);
});


test('store adds cannot silently return or reselect a search-owned record', async t => {
  const { options, downloads } = await fixture(t);
  await ensureDownload(movie, options);
  const before = downloads.get(hash);
  await assert.rejects(ensureStoreDownload({ source: { infoHash: hash }, name: 'Store' }, options), /already managed by search/);
  assert.deepEqual(downloads.get(hash), before);
});

test('recovery backs off pending metadata, releases admission, and never recreates a missing torrent', async t => {
  const { downloads, qbt, options, settings } = await fixture(t);
  let now = 0;
  const files = qbt.fileList;
  qbt.fileList = [];
  await assert.rejects(ensureStoreDownload({ source: { infoHash: hash }, name: 'Pending' }, { ...options, metadataTimeoutMs: 0 }), /metadata/);
  let reads = 0;
  qbt.getFiles = async () => { reads++; return qbt.fileList; };
  const recovery = new DownloadRecovery({ store: settings, downloads, backendFactory: () => qbt, now: () => now });
  await recovery.run();
  const first = reads;
  await recovery.run();
  assert.equal(reads, first, 'repeated ticks respect backoff');
  now = 15_000;
  qbt.fileList = files;
  await recovery.run();
  assert.equal(downloads.get(hash)?.lifecycle, 'managed');
  const added = qbt.writes.filter(w => w.startsWith('add:')).length;
  await downloads.upsert({ ...downloads.get(hash)!, lifecycle: 'registering' });
  qbt.torrents.delete(hash);
  now = 30_000;
  await recovery.run();
  assert.equal(qbt.writes.filter(w => w.startsWith('add:')).length, added);
  assert.equal(downloads.get(hash)?.lifecycle, 'registering');
});
