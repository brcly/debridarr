import { createServer } from 'node:http';
import type { Config } from '../src/config.js';
import { handlePlay } from '../src/playback/index.js';
import { listen } from './helpers.js';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QBittorrentClient, type QbtTorrent, type QbtFile } from '../src/integrations/qbittorrent/client.js';
import { DownloadsStore, type DownloadRecord } from '../src/downloads/store.js';
import { ensureDownload, DAY_MS } from '../src/downloads/manager.js';
import { deleteManaged } from '../src/downloads/deletion.js';
import { SettingsStore } from '../src/settings.js';
import { sweepOnce } from '../src/retention/sweeper.js';
import { markActive, markInactive } from '../src/playback/active.js';
import type { PlayTarget } from '../src/addon/play.js';

const hash = 'a'.repeat(40);
const movie: PlayTarget = { title: 'Movie', imdbId: 'tt1', type: 'movie', size: 100, infoHash: hash };
class FakeQbt extends QBittorrentClient {
  torrents = new Map<string, QbtTorrent>();
  fileList: QbtFile[] = [{ index: 0, name: 'movie.mkv', size: 100, progress: 1, priority: 1 }];
  writes: string[] = [];
  onAdd: (() => Promise<void>) | undefined;
  onDelete: ((hash: string) => Promise<void>) | undefined;
  constructor() { super({ url: 'http://fixture-qbt', username: 'u', password: 'p' }); }
  override async torrent(hash: string) { return structuredClone(this.torrents.get(hash)); }
  override async files() { return structuredClone(this.fileList); }
  override async add(magnet: string, options: { category: string; tags?: string }) {
    const hash = new URL(magnet).searchParams.get('xt')!.slice(-40);
    this.writes.push(`add:${hash}`);
    this.torrents.set(hash, {
      hash, category: options.category, tags: [options.tags!], name: 'Movie', state: 'downloading', progress: 0,
      size: 100, ratio: 0, savePath: '/downloads', contentPath: '/downloads/movie.mkv', amountLeft: 100,
      numSeeds: 0, numLeechs: 0, dlspeed: 0, eta: 0, sequential: true, firstLastPiecePrio: true,
    });
    await this.onAdd?.();
  }
  override async addTags(hash: string, tag: string) { this.writes.push('tag'); this.torrents.get(hash)!.tags.push(tag); }
  override async setShareLimits() { this.writes.push('limits'); }
  override async setRunning() { this.writes.push('running'); }
  override async setFilePriorities(_hash: string, indices: number[], priority: number) {
    this.writes.push('priority');
    for (const file of this.fileList) if (indices.includes(file.index)) file.priority = priority;
  }
  override async delete(hash: string) {
    this.writes.push(`delete:${hash}`);
    await this.onDelete?.(hash);
    this.torrents.delete(hash);
  }
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'debridarr-lifecycle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const downloads = await DownloadsStore.open(dir);
  const settings = await SettingsStore.open(dir, {});
  await settings.update({ qbittorrent: { url: 'http://fixture-qbt', username: 'u', password: 'p' } });
  const qbt = new FakeQbt();
  const options = { qbt, store: downloads, signal: AbortSignal.timeout(5000) };
  const sweep = () => sweepOnce({ store: settings, downloads, qbtFactory: () => qbt });
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
  qbt.delete = async () => {};
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
  await sweepOnce({ store: settings, downloads: reopened, qbtFactory: () => qbt });
  assert.equal(reopened.get(hash)?.lifecycle, 'managed');
  assert.equal(qbt.writes.filter(w => w.startsWith('add:')).length, 1);
});

test('unplayable additions stay tracked until verified cleanup succeeds', async t => {
  const { downloads, qbt, options, sweep } = await fixture(t);
  qbt.fileList = [{ index: 0, name: 'archive.zip', size: 100, progress: 1, priority: 1 }];
  await assert.rejects(ensureDownload(movie, options), /wanted file/);
  assert.equal(downloads.get(hash)?.lifecycle, 'failed');
  assert.equal(qbt.torrents.size, 1);
  const result = await sweep();
  assert.deepEqual(result.deleted, [hash]);
  assert.equal(downloads.list().length, 0);
});

test('concurrent episodes share registration and preserve both file selections', async t => {
  const { downloads, qbt, options } = await fixture(t);
  qbt.fileList = [1,2].map((episode, index) => ({ index, name: `Show.S01E0${episode}.mkv`, size: 100, progress: 1, priority: 1 }));
  const episode = (n: number): PlayTarget => ({ ...movie, title: 'Show S01', type: 'series', season: 1, episode: n });
  const [first, second] = await Promise.all([ensureDownload(episode(1), options), ensureDownload(episode(2), options)]);
  assert.equal(first.file.name, 'Show.S01E01.mkv');
  assert.equal(second.file.name, 'Show.S01E02.mkv');
  assert.equal(qbt.writes.filter(w => w.startsWith('add:')).length, 1);
  assert.deepEqual(downloads.get(hash)?.selectedFiles?.map(f => f.index), [0,1]);
  assert.deepEqual(qbt.fileList.map(f => f.priority), [1,1]);
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
  qbt.torrents.get(hash)!.category = 'personal';
  qbt.writes = [];
  await sweep();
  assert.equal(downloads.get(hash)?.lifecycle, 'conflict');
  assert.deepEqual(qbt.writes, []);
  await assert.rejects(ensureDownload(movie, options), /ownership/);
  qbt.torrents.get(hash)!.category = 'debridarr';
  await settings.update({ qbittorrent: { url: 'http://replacement' } });
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
  const legacy: DownloadRecord = { infoHash: hash, name: 'Movie', imdbId: 'tt1', type: 'movie', fileName: 'movie.mkv', fileIndex: 0,
    bytes: 100, addedAt: 0, expiresAt: 0, kept: false };
  await downloads.upsert(legacy);
  await sweep();
  assert.equal(downloads.get(hash)?.lifecycle, 'conflict');
  assert.equal(downloads.get(hash)?.owner, undefined);
});

test('concurrent episode playback and range requests return their own file bytes', async t => {
  const { dir, downloads, settings, qbt } = await fixture(t);
  qbt.fileList = [1,2].map((episode, index) => ({ index, name: `Show.S01E0${episode}.mkv`, size: 11, progress: 1, priority: 1 }));
  await writeFile(join(dir, 'Show.S01E01.mkv'), 'EPISODE_ONE');
  await writeFile(join(dir, 'Show.S01E02.mkv'), 'EPISODE_TWO');
  const base = await listen(createServer((request, response) => {
    const episode = request.url === '/1' ? 1 : 2;
    void handlePlay(request, response, { ...movie, type: 'series', season: 1, episode }, {
      config: { downloadDir: dir } as Config, qbt, store: downloads, retention: settings.snapshot().retention, readyWaitMs: 0,
    }).catch(() => { response.statusCode = 500; response.end(); });
  }), t);
  const responses = await Promise.all([fetch(`${base}/1`), fetch(`${base}/2`)]);
  assert.deepEqual(await Promise.all(responses.map(async r => [r.status, await r.text()])), [[200, 'EPISODE_ONE'], [200, 'EPISODE_TWO']]);
  const ranged = await Promise.all([fetch(`${base}/1`, { headers: { Range: 'bytes=8-10' } }), fetch(`${base}/2`, { headers: { Range: 'bytes=8-10' } })]);
  assert.deepEqual(await Promise.all(ranged.map(async r => [r.status, await r.text()])), [[206, 'ONE'], [206, 'TWO']]);
});
