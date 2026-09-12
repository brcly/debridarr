import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { cachedCopies } from '../src/addon/cached.js';
import { getStreams, buildStreamList } from '../src/addon/streams.js';
import type { PrepareTransferRequest } from '../src/application/types.js';
import { DownloadsStore } from '../src/downloads/store.js';
import { ensureTransfer, type EnsureOptions } from '../src/downloads/manager.js';
import { QBittorrentClient } from '../src/integrations/qbittorrent/client.js';
import type { TorrentFile, TorrentSnapshot } from '../src/backends/torrent.js';
import type { QBittorrentBackendSettings } from '../src/backends/config.js';
import { SettingsStore } from '../src/settings.js';
import { AddonAccess, sourceIdentity } from '../src/security/addon.js';
import { parseReleaseTitle } from '../src/search/parse.js';
import { clearBackendSnapshots } from '../src/backends/snapshot.js';
import { tmpDir } from './helpers.js';

const ensureDownload = (request: PrepareTransferRequest, options: EnsureOptions) => ensureTransfer(request, options);

const HASH = 'a'.repeat(40);
const ID = { type: 'movie' as const, imdbId: 'tt1' };
async function fixture(t: TestContext) {
  clearBackendSnapshots();
  const dir = await tmpDir(t, 'debridarr-cached');
  const store = await DownloadsStore.open(dir);
  const settings = await SettingsStore.open(dir, {});
  class Qbt extends QBittorrentClient {
    writes: string[] = [];
    live: TorrentSnapshot | undefined = { infoHash: HASH, name: 'Movie', scope: 'debridarr', markers: ['owned'], state: 'stoppedUP', progress: 1, bytes: 4,
      savePath: dir, contentPath: join(dir, 'movie.mkv'), ratio: 1, bytesRemaining: 0, seeders: 0, leechers: 0, downloadSpeed: 0, eta: 0, sequentialDownload: true, firstLastPieces: true };
    fileList: TorrentFile[] = [{ id: 0, path: 'movie.mkv', bytes: 4, progress: 1, selected: true }];
    constructor() { super({ url: 'http://cached-qbt', username: 'u', password: 'p' }); }
    override async get() { return this.live ? structuredClone(this.live) : undefined; }
    override async list() { return this.live ? [structuredClone(this.live)] : []; }
    override async getFiles() { return structuredClone(this.fileList); }
    override async submit() { this.writes.push('add'); throw new Error('Must not download'); }
    override async addMarker() { this.writes.push('tag'); }
    override async setRunning() { this.writes.push('start'); }
    override async setShareLimits() { this.writes.push('limits'); }
    override async setFilesSelected() { this.writes.push('priority'); }
  }
  const qbt = new Qbt();
  await writeFile(join(dir, 'movie.mkv'), 'film');
  await store.upsert({ origin: 'search', infoHash: HASH, name: 'Movie 1080p', media: { ...ID }, fileIndex: 0, fileName: 'movie.mkv', bytes: 4,
    addedAt: 0, expiresAt: Date.now() + 1000, kept: false, lifecycle: 'managed', owner: { backend: qbt.identity, marker: 'owned', scope: 'debridarr' },
    selectedFiles: [{ index: 0, name: 'movie.mkv', bytes: 4 }] });
  const cache = { store, backend: qbt, config: { downloadDir: dir } };
  const copies = () => { clearBackendSnapshots(); return cachedCopies(ID, cache, AbortSignal.timeout(1000)); };
  const targets: PrepareTransferRequest[] = [];
  const access = await AddonAccess.open(dir);
  const context = { settings: settings.snapshot(), cache, appUrl: access.base('https://addon.example'),
    issue: async (entries: PrepareTransferRequest[]) => { targets.push(...entries); return access.issue(entries, sourceIdentity(settings.snapshot().discovery.providers)); } };
  return { dir, store, settings, qbt, cache, copies, targets, context, access };
}

test('returning to a movie lists a ready cached copy without Prowlarr, with a private HTTPS URL and no mutations', async t => {
  const f = await fixture(t);
  await f.store.upsert({ ...f.store.get(HASH)!, origin: 'store' });
  const before = f.store.list();
  const result = await getStreams(ID, f.context);
  assert.equal(result.streams.length, 1);
  assert.equal(f.targets[0]?.origin, 'store', 'IMDb-linked store copies keep their preparation origin');
  assert.match(result.streams[0]!.name, /Cached/);
  assert.match(result.streams[0]!.title, /Ready to play/);
  assert.match(result.streams[0]!.url, /^https:\/\/addon.example\/addon\/[\w-]{43}\/play\/[\w-]{43}$/);
  assert.deepEqual(f.targets[0]?.selection?.file, { id: 0, path: 'movie.mkv', bytes: 4, marker: 'owned' });
  assert.equal(f.targets[0]?.selection?.behavior, 'require-existing');
  assert.deepEqual(f.qbt.writes, []);
  assert.deepEqual(f.store.list(), before, 'browsing must not renew or change records');
  // References and records survive restart, and the exact file wins over a larger movie.
  const access = await AddonAccess.open(f.dir);
  const target = access.get(result.streams[0]!.url.split('/').at(-1)!, sourceIdentity(f.settings.snapshot().discovery.providers))!;
  assert.ok(target);
  f.qbt.fileList.push({ id: 1, path: 'different.mkv', bytes: 999, progress: 0, selected: false });
  const state = await ensureDownload(target, { backend: f.qbt, store: await DownloadsStore.open(f.dir), signal: AbortSignal.timeout(1000) });
  assert.equal(state.file.id, 0);
  assert.equal(f.qbt.writes.filter(value => value === 'add').length, 0);
});

test('cache survives unavailable metadata and deduplicates fresh indexer results by hash', async t => {
  const f = await fixture(t);
  f.context.settings.discovery = { providers: [{ id: 'unused', type: 'prowlarr', url: 'http://unused-prowlarr', apiKey: 'test-key', preferences: { languages: [], resolutions: [], codecs: [] } }] };
  f.context.settings.metadata = { provider: 'tmdb', tmdbApiKey: '' };
  const result = await getStreams(ID, f.context);
  assert.match(result.streams[0]!.name, /Cached/);
  const candidates = [HASH.toUpperCase(), 'b'.repeat(40)].map(infoHash => ({
    release: { title: 'Movie 2000 1080p', infoHash, size: 4, seeders: 1, leechers: 0, indexer: 'Indexer', protocol: 'torrent' as const, guid: infoHash },
    parsed: parseReleaseTitle('Movie 2000 1080p'),
    preferences: { languages: [] },
  }));
  const combined = await buildStreamList(await f.copies(), candidates, ID, f.context);
  assert.equal(combined.streams.length, 2);
  assert.match(combined.streams[0]!.name, /Cached/);
  assert.doesNotMatch(combined.streams[1]!.name, /Cached/);
});

test('missing, truncated, deleted, foreign and conflicted copies are not advertised as cached', async t => {
  const f = await fixture(t);
  const record = f.store.get(HASH)!;
  f.qbt.live!.markers = ['foreign']; assert.deepEqual(await f.copies(), []);
  f.qbt.live!.markers = ['owned'];
  f.qbt.live!.state = 'checkingUP'; assert.deepEqual(await f.copies(), []);
  f.qbt.live!.state = 'stoppedUP';
  await f.store.upsert({ ...record, lifecycle: 'deleting' }); assert.deepEqual(await f.copies(), []);
  await f.store.upsert({ ...record, lifecycle: 'conflict' }); assert.deepEqual(await f.copies(), []);
  await f.store.upsert(record);
  await writeFile(join(f.dir, 'movie.mkv'), 'x'); assert.deepEqual(await f.copies(), []);
  await rm(join(f.dir, 'movie.mkv')); assert.deepEqual(await f.copies(), []);
  f.qbt.live = undefined; assert.deepEqual(await f.copies(), []);
  assert.deepEqual(f.qbt.writes, []);
});

test('incomplete copies are labelled downloading; stale cached references cannot recreate removed torrents', async t => {
  const f = await fixture(t);
  f.qbt.live!.state = 'downloading';
  f.qbt.fileList[0]!.progress = 0.5;
  const result = await getStreams(ID, f.context);
  assert.match(result.streams[0]!.name, /⏳ 50%/);
  assert.match(result.streams[0]!.title, /Downloading/);
  assert.doesNotMatch(result.streams[0]!.title, /Ready to play/);
  const target = f.targets[0]!;
  f.qbt.live = undefined;
  await assert.rejects(ensureDownload(target, { backend: f.qbt, store: f.store, signal: AbortSignal.timeout(1000) }), { code: 'cache_missing' });
  assert.deepEqual(f.qbt.writes, []);
});

test('season pack selections preserve episode identity across restart, including legacy records', async t => {
  const f = await fixture(t);
  f.qbt.fileList = [1, 2].map(episode => ({ id: episode - 1, path: `Show.S01E0${episode}.mkv`, bytes: 4, progress: 1, selected: true }));
  for (const file of f.qbt.fileList) await writeFile(join(f.dir, file.path), 'show');
  await f.store.upsert({ ...f.store.get(HASH)!, media: { imdbId: 'tt1', type: 'series', season: 1, episode: 1 }, fileIndex: 1, fileName: f.qbt.fileList[1]!.path,
    selectedFiles: f.qbt.fileList.map(file => ({ index: file.id, name: file.path, bytes: file.bytes })) });
  const id = { ...ID, type: 'series' as const, season: 1, episode: 2 };
  const copies = await cachedCopies(id, f.cache, AbortSignal.timeout(1000));
  assert.equal(copies.length, 1);
  assert.equal(copies[0]!.request.selection!.file.id, 1);
  await ensureDownload(copies[0]!.request, { backend: f.qbt, store: f.store, signal: AbortSignal.timeout(1000) });
  const reopened = await DownloadsStore.open(f.dir);
  assert.deepEqual(reopened.get(HASH)?.selectedFiles?.[1]?.media, id);
  assert.deepEqual(await cachedCopies({ ...id, episode: 3 }, { ...f.cache, store: reopened }, AbortSignal.timeout(1000)), []);
});

test('an auto-enqueued season-pack sibling only lists as a copy once it has downloaded', async t => {
  const f = await fixture(t);
  f.qbt.fileList = [1, 2].map((episode, id) => ({ id, path: `Show.S01E0${episode}.mkv`, bytes: 4, progress: id === 0 ? 1 : 0, selected: true }));
  for (const file of f.qbt.fileList) await writeFile(join(f.dir, file.path), 'show');
  await f.store.upsert({ ...f.store.get(HASH)!, media: { imdbId: 'tt1', type: 'series', season: 1, episode: 1 }, fileIndex: 0, fileName: 'Show.S01E01.mkv',
    selectedFiles: [
      { index: 0, name: 'Show.S01E01.mkv', bytes: 4, media: { imdbId: 'tt1', type: 'series', season: 1, episode: 1 } },
      { index: 1, name: 'Show.S01E02.mkv', bytes: 4, auto: true, media: { imdbId: 'tt1', type: 'series', season: 1, episode: 2 } },
    ] });
  const browseEp2 = { ...ID, type: 'series' as const, season: 1, episode: 2 };

  assert.deepEqual(await cachedCopies(browseEp2, f.cache, AbortSignal.timeout(1000)), [], 'a not-yet-downloaded sibling is hidden, so the fresh pack stays selectable');

  f.qbt.fileList[1]!.progress = 1;
  const ready = await cachedCopies(browseEp2, f.cache, AbortSignal.timeout(1000));
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.request.selection!.file.id, 1);

  f.qbt.fileList[0]!.progress = 0.5;
  const explicit = await cachedCopies({ ...ID, type: 'series' as const, season: 1, episode: 1 }, f.cache, AbortSignal.timeout(1000));
  assert.equal(explicit.length, 1, 'an explicitly played episode still lists while downloading');
});

test('HTTP routing wires cached search to exact-file playback and preserves the configured HTTPS origin', async t => {
  const { createApp } = await import('../src/server.js');
  const { loadConfig } = await import('../src/config.js');
  const { createServer } = await import('node:http');
  const { listen } = await import('./helpers.js');
  const f = await fixture(t);
  const upstream = await listen(createServer((request, response) => {
    const path = new URL(request.url!, 'http://x').pathname;
    if (path === '/api/v2/auth/login') { response.statusCode = 204; response.end(); return; }
    if (path === '/api/v2/torrents/info') { response.end(JSON.stringify([{ hash: HASH, category: 'debridarr', tags: 'owned', state: 'stoppedUP', progress: 1, save_path: f.dir, seq_dl: true, f_l_piece_prio: true }])); return; }
    if (path === '/api/v2/torrents/files') {
      response.end(JSON.stringify(f.qbt.fileList.map(file => ({
        index: file.id, name: file.path, size: file.bytes, progress: file.progress, priority: file.selected ? 1 : 0,
      }))));
      return;
    }
    if (path === '/api/v2/torrents/setShareLimits') { response.end(); return; }
    response.statusCode = 500; response.end();
  }), t);
  await f.settings.update({ downloadBackend: { url: upstream, username: 'u', password: 'p' } });
  const qbt = new QBittorrentClient(f.settings.snapshot().downloadBackend as QBittorrentBackendSettings);
  await f.store.upsert({ ...f.store.get(HASH)!, owner: { backend: qbt.identity, scope: 'debridarr', marker: 'owned' } });
  const config = loadConfig({ APP_URL: 'https://addon.example', ADMIN_PASSWORD: 'test-password', DATA_DIR: f.dir, DOWNLOAD_DIR: f.dir });
  const base = await listen(createApp({ config, store: f.settings, downloads: f.store, access: f.access }), t);
  const search = await fetch(`${f.access.base(base)}/stream/movie/tt1.json`);
  assert.equal(search.headers.get('strict-transport-security'), 'max-age=31536000');
  const { streams } = await search.json();
  assert.equal(streams.length, 1);
  assert.match(streams[0].url, /^https:\/\/addon.example\//);
  const playback = await fetch(base + new URL(streams[0].url).pathname, { headers: { Range: 'bytes=1-2' } });
  assert.equal(playback.status, 206);
  assert.equal(await playback.text(), 'il');
  assert.match(playback.headers.get('access-control-expose-headers')!, /Content-Range/);
  const preflight = await fetch(base + new URL(streams[0].url).pathname, { method: 'OPTIONS', headers: { 'Access-Control-Request-Headers': 'Range' } });
  assert.match(preflight.headers.get('access-control-allow-headers')!, /Range/);
});
