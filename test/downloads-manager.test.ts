import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DEBRIDARR_CATEGORY, DownloadError, ensureDownload } from '../src/downloads/manager.js';
import { DownloadsStore } from '../src/downloads/store.js';
import { QBittorrentClient } from '../src/integrations/qbittorrent/client.js';
import type { PlayTarget } from '../src/addon/play.js';
import { listen } from './helpers.js';

// Minimal hand-built bencode, matching test/torrentFile.test.ts's approach.
function bencodeString(value: string): Buffer {
  const bytes = Buffer.from(value, 'latin1');
  return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]);
}
function bencodeInt(value: number): Buffer {
  return Buffer.from(`i${value}e`);
}
function bencodeDict(entries: [string, Buffer][]): Buffer {
  return Buffer.concat([Buffer.from('d'), ...entries.flatMap(([key, value]) => [bencodeString(key), value]), Buffer.from('e')]);
}
function buildTorrentFile(name: string) {
  const info = bencodeDict([
    ['length', bencodeInt(100)],
    ['name', bencodeString(name)],
    ['piece length', bencodeInt(16_384)],
    ['pieces', bencodeString('X'.repeat(20))],
  ]);
  const torrent = bencodeDict([['announce', bencodeString('http://tracker.example/announce')], ['info', info]]);
  return { torrent, infoHash: createHash('sha1').update(info).digest('hex') };
}

const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

interface FakeTorrent {
  files: { index: number; name: string; size: number; progress: number; priority: number }[];
  seq: boolean; flpp: boolean; ratioLimit?: number; present: boolean; appearAfter: number;
}

async function form(request: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return new URLSearchParams(body);
}

function fakeQbt(t: TestContext, torrent: FakeTorrent) {
  const seen: string[] = [];
  let infoHits = 0;
  let tag = '';
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://x');
      const path = url.pathname;
      if (path === '/api/v2/auth/login') { response.setHeader('Set-Cookie', 'SID=s; Path=/'); response.end('Ok.'); return; }
      const body = request.method === 'POST' ? await form(request) : new URLSearchParams();
      seen.push(path);
      if (path === '/api/v2/torrents/add') { torrent.present = true; tag = body.get('tags') ?? ''; response.end('Ok.'); return; }
      if (path === '/api/v2/torrents/info') {
        infoHits += 1;
        const visible = torrent.present && infoHits >= torrent.appearAfter;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(visible ? [{
          category: 'debridarr', tags: tag, hash: HASH, name: 'The Matrix 1999 1080p BluRay', state: 'downloading', progress: 0.1,
          size: 100, ratio: 0, save_path: '/downloads', content_path: '/downloads/x',
          amount_left: 90, num_seeds: 5, num_leechs: 1, dlspeed: 1, eta: 1,
          seq_dl: torrent.seq, f_l_piece_prio: torrent.flpp,
        }] : []));
        return;
      }
      if (path === '/api/v2/torrents/files') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(torrent.files));
        return;
      }
      if (path === '/api/v2/torrents/toggleSequentialDownload') { torrent.seq = true; response.end('Ok.'); return; }
      if (path === '/api/v2/torrents/toggleFirstLastPiecePrio') { torrent.flpp = true; response.end('Ok.'); return; }
      if (path === '/api/v2/torrents/setShareLimits') { torrent.ratioLimit = Number(body.get('ratioLimit')); response.end('Ok.'); return; }
      if (path === '/api/v2/torrents/filePrio') {
        const ids = new Set((body.get('id') ?? '').split('|'));
        for (const file of torrent.files) if (ids.has(String(file.index))) file.priority = Number(body.get('priority'));
        response.end('Ok.');
        return;
      }
      response.end('Ok.');
    })().catch(() => { response.statusCode = 500; response.end('e'); });
  });
  return listen(server, t).then(base => ({ base, seen }));
}

async function store(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'debridarr-mgr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return DownloadsStore.open(dir);
}

const movie: PlayTarget = { title: 'The Matrix 1999 1080p BluRay', size: 100, imdbId: 'tt0133093', type: 'movie', infoHash: HASH };

test('adds a missing torrent, enables sequential + first/last, sets the ratio limit, and records it', async t => {
  const { base, seen } = await fakeQbt(t, {
    present: false, appearAfter: 1, seq: false, flpp: false,
    files: [
      { index: 0, name: 'The.Matrix.1999/movie.mkv', size: 95, progress: 0, priority: 1 },
      { index: 1, name: 'The.Matrix.1999/sample.mkv', size: 5, progress: 0, priority: 1 },
    ],
  });
  const s = await store(t);
  const state = await ensureDownload(movie, { qbt: new QBittorrentClient({ url: base, username: 'u', password: 'p' }), store: s, signal: AbortSignal.timeout(5000) });

  assert.ok(seen.includes('/api/v2/torrents/add'));
  assert.ok(seen.includes('/api/v2/torrents/toggleSequentialDownload'));
  assert.ok(seen.includes('/api/v2/torrents/toggleFirstLastPiecePrio'));
  assert.equal(state.file.index, 0, 'largest non-sample video');
  assert.equal(state.record.infoHash, HASH);
  assert.equal(state.record.imdbId, 'tt0133093');
  assert.equal(state.record.fileName, 'The.Matrix.1999/movie.mkv');
  assert.equal(state.record.kept, false);
  assert.ok(state.record.expiresAt - state.record.addedAt >= 29 * 86_400_000);
  assert.equal(s.get(HASH)?.fileIndex, 0);
});

test('refuses an unrelated existing torrent without adding, serving or reprioritizing', async t => {
  const { base, seen } = await fakeQbt(t, { present: true, appearAfter: 1, seq: true, flpp: true,
    files: [{ index: 0, name: 'movie.mkv', size: 100, progress: 1, priority: 1 }] });
  const s = await store(t);
  await assert.rejects(ensureDownload(movie, { qbt: new QBittorrentClient({ url: base, username: 'u', password: 'p' }), store: s, signal: AbortSignal.timeout(5000) }), /ownership/);
  assert.deepEqual(seen, ['/api/v2/torrents/info']);
  assert.equal(s.list().length, 0);
});

test('a target with no infohash, magnet, or download URL is rejected before any request', async t => {
  const s = await store(t);
  await assert.rejects(
    ensureDownload({ title: 'x', size: 1, imdbId: 'tt1', type: 'movie' }, { qbt: new QBittorrentClient({ url: 'http://127.0.0.1:1', username: 'u', password: 'p' }), store: s, signal: AbortSignal.timeout(2000) }),
    (error: unknown) => error instanceof DownloadError && error.code === 'no_infohash',
  );
});

test('a downloadUrl whose torrent file cannot be fetched fails with torrent_fetch_failed', async t => {
  const failing = await listen(createServer((_request, response) => { response.statusCode = 500; response.end('nope'); }), t);
  const s = await store(t);
  await assert.rejects(
    ensureDownload(
      { title: 'x', size: 1, imdbId: 'tt1', type: 'movie', downloadUrl: failing },
      { qbt: new QBittorrentClient({ url: 'http://127.0.0.1:1', username: 'u', password: 'p' }), store: s, signal: AbortSignal.timeout(2000) },
    ),
    (error: unknown) => error instanceof DownloadError && error.code === 'torrent_fetch_failed',
  );
});

test('a downloadUrl-only release fetches the .torrent file and uploads its bytes (preserving trackers), keyed by the computed infohash', async t => {
  const { torrent, infoHash } = buildTorrentFile('The.Matrix.1999/movie.mkv');
  const torrentUrl = await listen(createServer((_request, response) => { response.end(torrent); }), t);

  let present = false;
  let tag = '';
  const seen: string[] = [];
  const qbt = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url!, 'http://x').pathname;
      if (path === '/api/v2/auth/login') { response.setHeader('Set-Cookie', 'SID=s; Path=/'); response.end('Ok.'); return; }
      seen.push(path);
      if (path === '/api/v2/torrents/add') {
        let body = ''; for await (const chunk of request) body += chunk;
        tag = /name="tags"\r\n\r\n([^\r]+)/.exec(body)?.[1] ?? '';
        assert.ok(body.includes(torrent.toString()), 'raw torrent preserved');
        present = true; response.end('Ok.'); return;
      }
      if (path === '/api/v2/torrents/info') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(present ? [{
          category: 'debridarr', tags: tag, hash: infoHash, name: 'The Matrix 1999', state: 'downloading', progress: 0, size: 100, ratio: 0,
          save_path: '/downloads', content_path: '/downloads/x', amount_left: 100, num_seeds: 0, num_leechs: 0,
          dlspeed: 0, eta: 0, seq_dl: false, f_l_piece_prio: false,
        }] : []));
        return;
      }
      if (path === '/api/v2/torrents/files') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify([{ index: 0, name: 'The.Matrix.1999/movie.mkv', size: 100, progress: 0, priority: 1 }]));
        return;
      }
      response.end('Ok.');
    })().catch(() => { response.statusCode = 500; response.end('e'); });
  });
  const qbtBase = await listen(qbt, t);
  const s = await store(t);
  const target: PlayTarget = { title: 'The Matrix 1999 1080p BluRay', size: 100, imdbId: 'tt0133093', type: 'movie', downloadUrl: `${torrentUrl}/1/download?link=fixture` };
  const state = await ensureDownload(target, { prowlarr: { url: torrentUrl, apiKey: 'test-key' }, qbt: new QBittorrentClient({ url: qbtBase, username: 'u', password: 'p' }), store: s, signal: AbortSignal.timeout(5000) });

  assert.equal(state.record.infoHash, infoHash, 'identity comes from the fetched torrent file, not a synthetic magnet');
  assert.ok(seen.includes('/api/v2/torrents/add'));
  assert.equal(s.get(infoHash)?.fileName, 'The.Matrix.1999/movie.mkv');
});

test('DEBRIDARR_CATEGORY is the qBittorrent category used on add', async t => {
  const { base, seen } = await fakeQbt(t, { present: false, appearAfter: 1, seq: true, flpp: true, files: [{ index: 0, name: 'movie.mkv', size: 100, progress: 0, priority: 1 }] });
  const s = await store(t);
  await ensureDownload(movie, { qbt: new QBittorrentClient({ url: base, username: 'u', password: 'p' }), store: s, signal: AbortSignal.timeout(5000) });
  assert.equal(DEBRIDARR_CATEGORY, 'debridarr');
  assert.ok(seen.includes('/api/v2/torrents/add'));
});

test('a freshly added stopped torrent is started before its files are read, so magnets can fetch metadata', async t => {
  const seen: string[] = [];
  let present = false;
  let running = false;
  let tag = '';
  const qbt = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url!, 'http://x').pathname;
      if (path === '/api/v2/auth/login') { response.setHeader('Set-Cookie', 'SID=s; Path=/'); response.end('Ok.'); return; }
      const body = request.method === 'POST' ? await form(request) : new URLSearchParams();
      seen.push(path);
      if (path === '/api/v2/app/version') { response.end('v5.2.3'); return; }
      if (path === '/api/v2/torrents/add') {
        assert.equal(body.get('stopped'), 'true', 'Debridarr adds torrents stopped');
        present = true; tag = body.get('tags') ?? ''; response.end('Ok.'); return;
      }
      if (path === '/api/v2/torrents/start') { running = true; response.end('Ok.'); return; }
      if (path === '/api/v2/torrents/info') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(present ? [{
          category: 'debridarr', tags: tag, hash: HASH, name: 'The Lost Boys 1987', state: running ? 'metaDL' : 'stoppedDL',
          progress: 0, size: 100, ratio: 0, save_path: '/downloads', content_path: '/downloads/x',
          amount_left: 100, num_seeds: 0, num_leechs: 0, dlspeed: 0, eta: 0, seq_dl: false, f_l_piece_prio: false,
        }] : []));
        return;
      }
      if (path === '/api/v2/torrents/files') {
        response.setHeader('Content-Type', 'application/json');
        // A magnet only exposes its file list once it is running and has metadata.
        response.end(JSON.stringify(running ? [{ index: 0, name: 'The.Lost.Boys.1987/movie.mkv', size: 100, progress: 0, priority: 1 }] : []));
        return;
      }
      response.end('Ok.');
    })().catch(() => { response.statusCode = 500; response.end('e'); });
  });
  const base = await listen(qbt, t);
  const s = await store(t);
  const target: PlayTarget = { title: 'The Lost Boys 1987 REMASTERED 1080p BluRay x265-RBG', size: 100, imdbId: 'tt0093437', type: 'movie', infoHash: HASH };
  const state = await ensureDownload(target, { qbt: new QBittorrentClient({ url: base, username: 'u', password: 'p' }), store: s, signal: AbortSignal.timeout(5000) });

  assert.ok(seen.includes('/api/v2/torrents/start'));
  assert.ok(seen.indexOf('/api/v2/torrents/start') < seen.indexOf('/api/v2/torrents/files'), 'started before reading files');
  assert.equal(state.record.lifecycle, 'managed');
  assert.equal(state.record.fileName, 'The.Lost.Boys.1987/movie.mkv');
});
