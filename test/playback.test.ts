import { sourceIdentity } from '../src/security/addon.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Config } from '../src/config.js';
import { DAY_MS } from '../src/downloads/manager.js';
import { DownloadsStore } from '../src/downloads/store.js';
import { QBittorrentClient } from '../src/integrations/qbittorrent/client.js';
import { handlePlay } from '../src/playback/index.js';
import { resolveLocalFile } from '../src/playback/paths.js';
import { parseRange } from '../src/playback/serve.js';
import { listen, playRequest, tmpDir, type PlayShape } from './helpers.js';

test('resolveLocalFile handles identical mounts, prefix remap, and blocks traversal', () => {
  // Same mount path in both containers: use it directly.
  assert.equal(resolveLocalFile('/downloads', 'Movie/movie.mkv', '/downloads'), '/downloads/Movie/movie.mkv');
  // Different qBittorrent save path: fall back to DOWNLOAD_DIR + the file's relative name.
  assert.equal(resolveLocalFile('/data/torrents', 'Movie/movie.mkv', '/downloads'), '/downloads/Movie/movie.mkv');
  // Explicit mappings preserve subdirectories and the longest matching prefix wins.
  const mappings = [
    { remote: '/remote', local: '/downloads/fallback' },
    { remote: '/remote/complete', local: '/downloads/complete' },
  ];
  assert.equal(resolveLocalFile('/remote/complete/movies', 'Movie/movie.mkv', '/downloads', mappings),
    '/downloads/complete/movies/Movie/movie.mkv');
  // A matching mapping outside the configured root fails closed instead of
  // silently trying an unrelated file below DOWNLOAD_DIR.
  assert.equal(resolveLocalFile('/remote', 'Movie/movie.mkv', '/downloads', [{ remote: '/remote', local: '/outside' }]), undefined);
  // A file name that climbs out of DOWNLOAD_DIR is refused under either layout.
  assert.equal(resolveLocalFile('/data/torrents', '../../etc/passwd', '/downloads'), undefined);
  assert.equal(resolveLocalFile('/downloads', '../secrets.mkv', '/downloads'), undefined);
});

test('parseRange covers open, closed, suffix, absent, and unsatisfiable ranges', () => {
  assert.equal(parseRange(undefined, 1000), undefined);
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
  assert.deepEqual(parseRange('bytes=990-5000', 1000), { start: 990, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), null);
  assert.equal(parseRange('bytes=abc', 1000), null);
});

const BODY = Buffer.from('0123456789'.repeat(20)); // 200 bytes

interface Fixture { base: string; store: DownloadsStore; dir: string }

const defaultRetention = { days: 30, targetRatio: 1, graceDays: 0, extendOnPlay: true, maxCacheGB: 0, storeLeaseDays: 14, minFreeSpaceGB: 0 };

async function fixture(t: TestContext, opts: { fileProgress: number; onDisk: boolean; qbtConfigured?: boolean; storeFile?: boolean; streamWhileDownloading?: boolean; pieceSupport?: boolean; retention?: Partial<typeof defaultRetention> }): Promise<Fixture> {
  const dir = await tmpDir(t, 'debridarr-play');
  const downloadDir = join(dir, 'downloads');
  await mkdir(join(downloadDir, 'The.Matrix.1999'), { recursive: true });
  if (opts.onDisk) await writeFile(join(downloadDir, 'The.Matrix.1999', 'movie.mkv'), BODY);

  let present = true;
  let tag = opts.storeFile ? 'test-owner' : '';
  const qbt = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url!, 'http://x').pathname;
      if (path === '/api/v2/auth/login') { response.setHeader('Set-Cookie', 'SID=s; Path=/'); response.end('Ok.'); return; }
      if (path === '/api/v2/torrents/add' || path === '/api/v2/torrents/addTags') {
        let body = ''; for await (const chunk of request) body += chunk;
        tag = new URLSearchParams(body).get('tags') ?? ''; present = true; response.end('Ok.'); return;
      }
      if (path === '/api/v2/torrents/info') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(present ? [{ category: 'debridarr', tags: tag, hash: 'a'.repeat(40), name: 'The Matrix 1999', state: 'downloading', progress: opts.fileProgress, size: 200, ratio: 0, save_path: downloadDir, content_path: `${downloadDir}/The.Matrix.1999`, amount_left: 0, num_seeds: 1, num_leechs: 0, dlspeed: 0, eta: 0, seq_dl: true, f_l_piece_prio: true }] : []));
        return;
      }
      if (path === '/api/v2/torrents/files') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify([{ index: 0, name: 'The.Matrix.1999/movie.mkv', size: 200, progress: opts.fileProgress, priority: 1 }]));
        return;
      }
      response.end('Ok.');
    })().catch(() => { response.statusCode = 500; response.end('e'); });
  });
  const qbtBase = await listen(qbt, t);
  const store = await DownloadsStore.open(dir);
  await store.upsert({ infoHash: 'a'.repeat(40), name: 'Matrix', origin: 'search', media: { imdbId: 'tt0133093', type: 'movie' }, fileIndex: 0, fileName: 'The.Matrix.1999/movie.mkv', bytes: 200, addedAt: Date.now(), expiresAt: Date.now() + 30 * DAY_MS, kept: false });

  if (opts.storeFile) await store.upsert({ ...store.get('a'.repeat(40))!, origin: 'store', lifecycle: 'managed', selectedFiles: [],
    owner: { backend: sourceIdentity({ url: qbtBase }), scope: 'debridarr', marker: tag } });
  const playTarget = playRequest(opts.storeFile ? { title: 'Store file', size: 200, infoHash: 'a'.repeat(40), origin: 'store',
    storeFile: { index: 0, name: 'The.Matrix.1999/movie.mkv', bytes: 200, ownerTag: tag } } : target);
  const config = { downloadDir } as Config;
  const client = new QBittorrentClient(
    opts.qbtConfigured === false ? { url: '', username: '', password: '' } : { url: qbtBase, username: 'u', password: 'p' },
  );
  if (opts.pieceSupport === false) Object.defineProperty(client, 'capabilities', { value: { ...client.capabilities, pieces: undefined } });
  const app = createServer((request, response) => {
    const token = new URL(request.url!, 'http://x').pathname.slice('/play/'.length);
    const retention = { ...defaultRetention, ...opts.retention };
    if (token !== 'test-reference') { response.statusCode = 404; response.end('{}'); return; }
    void handlePlay(request, response, playTarget, { config, backend: client, store, retention,
      ...(opts.streamWhileDownloading === undefined ? {} : { streamWhileDownloading: opts.streamWhileDownloading }), readyWaitMs: 0 }).catch(() => {
      if (!response.headersSent) { response.statusCode = 500; response.end('{}'); }
    });
  });
  return { base: await listen(app, t), store, dir };
}

const token = 'test-reference';
const target: PlayShape = { title: 'The Matrix 1999 1080p', size: 200, imdbId: 'tt0133093', type: 'movie', infoHash: 'a'.repeat(40) };

test('a complete file is served with range support and recorded', async t => {
  const { base, store } = await fixture(t, { fileProgress: 1, onDisk: true });
  const full = await fetch(`${base}/play/${token}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/x-matroska');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal((await full.arrayBuffer()).byteLength, 200);

  const ranged = await fetch(`${base}/play/${token}`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 10-19/200');
  assert.equal(await ranged.text(), '0123456789');

  const bad = await fetch(`${base}/play/${token}`, { headers: { Range: 'bytes=500-600' } });
  assert.equal(bad.status, 416);
  assert.equal(store.get('a'.repeat(40))?.fileName, 'The.Matrix.1999/movie.mkv');
});

test('extendOnPlay renews an expired-looking lease on a completed play', async t => {
  const { base, store } = await fixture(t, { fileProgress: 1, onDisk: true, retention: { extendOnPlay: true, days: 10 } });
  const staleExpiry = Date.now() - 1000;
  await store.upsert({
    infoHash: 'a'.repeat(40), name: 'The Matrix 1999', origin: 'search', media: { imdbId: 'tt0133093', type: 'movie' },
    fileIndex: 0, fileName: 'The.Matrix.1999/movie.mkv', bytes: 200,
    addedAt: staleExpiry - 30 * DAY_MS, expiresAt: staleExpiry, kept: false,
  });
  assert.equal((await fetch(`${base}/play/${token}`)).status, 200);
  const renewed = store.get('a'.repeat(40))!;
  assert.ok(renewed.expiresAt > Date.now() + 9 * DAY_MS, 'lease pushed out roughly 10 days');
});

test('extendOnPlay: false leaves the lease untouched', async t => {
  const { base, store } = await fixture(t, { fileProgress: 1, onDisk: true, retention: { extendOnPlay: false } });
  const staleExpiry = Date.now() - 1000;
  await store.upsert({
    infoHash: 'a'.repeat(40), name: 'The Matrix 1999', origin: 'search', media: { imdbId: 'tt0133093', type: 'movie' },
    fileIndex: 0, fileName: 'The.Matrix.1999/movie.mkv', bytes: 200,
    addedAt: staleExpiry - 30 * DAY_MS, expiresAt: staleExpiry, kept: false,
  });
  assert.equal((await fetch(`${base}/play/${token}`)).status, 200);
  assert.equal(store.get('a'.repeat(40))?.expiresAt, staleExpiry);
});

test('an incomplete file plays the downloading clip by default', async t => {
  const { base } = await fixture(t, { fileProgress: 0.25, onDisk: false });
  const response = await fetch(`${base}/play/${token}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.ok((await response.arrayBuffer()).byteLength > 1000);
});

test('partial playback falls back to the downloading clip when the backend has no piece map', async t => {
  const { base } = await fixture(t, { fileProgress: 0.25, onDisk: false, streamWhileDownloading: true, pieceSupport: false });
  const response = await fetch(`${base}/play/${token}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.ok((await response.arrayBuffer()).byteLength > 1000);
});

test('a torrent with nothing downloaded yet plays the "still downloading" clip', async t => {
  const { base } = await fixture(t, { fileProgress: 0, onDisk: false });
  const response = await fetch(`${base}/play/${token}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.ok((await response.arrayBuffer()).byteLength > 1000, 'the placeholder clip is served as real video bytes');
});

test('an unconfigured qBittorrent is a clear 503', async t => {
  const { base } = await fixture(t, { fileProgress: 1, onDisk: true, qbtConfigured: false });
  const response = await fetch(`${base}/play/${token}`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'download_backend_unconfigured');
});

test('an unknown play token is a 404', async t => {
  const { base } = await fixture(t, { fileProgress: 1, onDisk: true });
  assert.equal((await fetch(`${base}/play/not-a-real-token`)).status, 404);
});


test('an id-less store file selects on playback, serves ranges, and uses the store lease', async t => {
  const { base, store } = await fixture(t, { fileProgress: 1, onDisk: true, storeFile: true, retention: { storeLeaseDays: 7 } });
  const hash = 'a'.repeat(40);
  await store.upsert({ ...store.get(hash)!, expiresAt: Date.now() - 1000 });
  const before = Date.now();
  const response = await fetch(`${base}/play/${token}`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), '0123456789');
  const record = store.get(hash)!;
  assert.equal(record.selectedFiles?.[0]?.index, 0);
  assert.ok(record.expiresAt >= before + 7 * DAY_MS && record.expiresAt <= Date.now() + 7 * DAY_MS);
});
