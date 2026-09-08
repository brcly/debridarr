import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Config } from '../src/config.js';
import { DAY_MS } from '../src/downloads/manager.js';
import { DownloadsStore } from '../src/downloads/store.js';
import { QBittorrentClient } from '../src/integrations/qbittorrent/client.js';
import { handlePlay } from '../src/playback/index.js';
import { resolveLocalFile } from '../src/playback/paths.js';
import { parseRange } from '../src/playback/serve.js';
import type { PlayTarget } from '../src/addon/play.js';
import { listen } from './helpers.js';

test('resolveLocalFile handles identical mounts, prefix remap, and blocks traversal', () => {
  // Same mount path in both containers: use it directly.
  assert.equal(resolveLocalFile('/downloads', 'Movie/movie.mkv', '/downloads'), '/downloads/Movie/movie.mkv');
  // Different qBittorrent save path: fall back to DOWNLOAD_DIR + the file's relative name.
  assert.equal(resolveLocalFile('/data/torrents', 'Movie/movie.mkv', '/downloads'), '/downloads/Movie/movie.mkv');
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

const defaultRetention = { days: 30, targetRatio: 1, graceDays: 0, extendOnPlay: true, maxCacheGB: 0 };

async function fixture(t: TestContext, opts: { fileProgress: number; onDisk: boolean; qbtConfigured?: boolean; retention?: Partial<typeof defaultRetention> }): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'debridarr-play-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const downloadDir = join(dir, 'downloads');
  await mkdir(join(downloadDir, 'The.Matrix.1999'), { recursive: true });
  if (opts.onDisk) await writeFile(join(downloadDir, 'The.Matrix.1999', 'movie.mkv'), BODY);

  let present = true;
  let tag = '';
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
  await store.upsert({ infoHash: 'a'.repeat(40), name: 'Matrix', imdbId: 'tt0133093', type: 'movie', fileIndex: 0, fileName: 'The.Matrix.1999/movie.mkv', bytes: 200, addedAt: Date.now(), expiresAt: Date.now() + 30 * DAY_MS, kept: false });

  const config = { downloadDir } as Config;
  const client = new QBittorrentClient(
    opts.qbtConfigured === false ? { url: '', username: '', password: '' } : { url: qbtBase, username: 'u', password: 'p' },
  );
  const app = createServer((request, response) => {
    const token = new URL(request.url!, 'http://x').pathname.slice('/play/'.length);
    const retention = { ...defaultRetention, ...opts.retention };
    if (token !== 'test-reference') { response.statusCode = 404; response.end('{}'); return; }
    void handlePlay(request, response, target, { config, qbt: client, store, retention, readyWaitMs: 0 }).catch(() => {
      if (!response.headersSent) { response.statusCode = 500; response.end('{}'); }
    });
  });
  return { base: await listen(app, t), store, dir };
}

const token = 'test-reference';
const target: PlayTarget = { title: 'The Matrix 1999 1080p', size: 200, imdbId: 'tt0133093', type: 'movie', infoHash: 'a'.repeat(40) };

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
    infoHash: 'a'.repeat(40), name: 'The Matrix 1999', imdbId: 'tt0133093', type: 'movie',
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
    infoHash: 'a'.repeat(40), name: 'The Matrix 1999', imdbId: 'tt0133093', type: 'movie',
    fileIndex: 0, fileName: 'The.Matrix.1999/movie.mkv', bytes: 200,
    addedAt: staleExpiry - 30 * DAY_MS, expiresAt: staleExpiry, kept: false,
  });
  assert.equal((await fetch(`${base}/play/${token}`)).status, 200);
  assert.equal(store.get('a'.repeat(40))?.expiresAt, staleExpiry);
});

test('an incomplete file reports downloading progress instead of streaming', async t => {
  const { base } = await fixture(t, { fileProgress: 0.25, onDisk: false });
  const response = await fetch(`${base}/play/${token}`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'downloading');
  assert.equal(body.progress, 0.25);
  assert.equal(response.headers.get('retry-after'), '15');
});

test('an unconfigured qBittorrent is a clear 503', async t => {
  const { base } = await fixture(t, { fileProgress: 1, onDisk: true, qbtConfigured: false });
  const response = await fetch(`${base}/play/${token}`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'qbittorrent_unconfigured');
});

test('an unknown play token is a 404', async t => {
  const { base } = await fixture(t, { fileProgress: 1, onDisk: true });
  assert.equal((await fetch(`${base}/play/not-a-real-token`)).status, 404);
});
