import assert from 'node:assert/strict';
import { open, symlink, writeFile, rename, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { QBittorrentClient } from '../src/integrations/qbittorrent/client.js';
import type { BackendOwnership, TorrentSnapshot, TorrentSource } from '../src/backends/torrent.js';
import { DownloadsStore } from '../src/downloads/store.js';
import { handlePlay } from '../src/playback/index.js';
import { isActive } from '../src/playback/active.js';
import { ConnectionError } from '../src/integrations/http.js';
import { requiredPieces } from '../src/playback/pieces.js';
import { listen, playRequest, tmpDir } from './helpers.js';
import type { Config } from '../src/config.js';

const HASH = 'b'.repeat(40);
const PIECE = 65536;
const BODY = Buffer.concat([Buffer.alloc(PIECE, 'a'), Buffer.alloc(PIECE, 'b'), Buffer.alloc(PIECE, 'c'), Buffer.alloc(PIECE, 'd')]);

async function fixture(t: TestContext, opts: { states?: number[]; suffix?: boolean; wait?: number; temp?: boolean; cold?: boolean } = {}) {
  const dir = await tmpDir(t, 'debridarr-partial');
  const download = opts.temp ? join(dir, 'incomplete') : dir;
  await mkdir(download, { recursive: true });
  const path = join(download, `movie.mkv${opts.suffix ? '.!qB' : ''}`);
  // A preallocated sparse file with a correct length but unavailable zero bytes.
  const disk = await open(path, 'w+');
  await disk.truncate(BODY.length);
  t.after(() => disk.close());
  const states = opts.states ?? [2, 0, 0, 0];
  for (let i = 0; i < states.length; i++) if (states[i] === 2) await disk.write(BODY.subarray(i * PIECE, (i + 1) * PIECE), 0, PIECE, i * PIECE);
  const torrent: TorrentSnapshot = { infoHash: HASH, name: 'Movie', scope: 'debridarr', markers: ['owner'], state: 'downloading', progress: 0.25, bytes: BODY.length,
    savePath: dir, incompletePath: opts.temp ? download : '', contentPath: path, ratio: 0, bytesRemaining: BODY.length, seeders: 1, leechers: 0, downloadSpeed: 0, eta: 0, sequentialDownload: true, firstLastPieces: true };
  let probes = 0;
  let present = !opts.cold;
  let fileReads = 0;
  let adds = 0;
  let pieceSizeReads = 0;
  let resolveProbe: (() => void) | undefined;
  class Qbt extends QBittorrentClient {
    constructor() { super({ url: 'http://mock-qbt', username: 'u', password: 'p' }); }
    override async list() { return present ? [structuredClone(torrent)] : []; }
    override async get() { return present ? structuredClone(torrent) : undefined; }
    override async submit(_source: TorrentSource, options: { ownership: BackendOwnership }) {
      adds++; present = true; torrent.markers = [options.ownership.marker]; torrent.state = 'stoppedDL';
    }
    override async setRunning() { torrent.state = 'downloading'; }
    override async getFiles() {
      fileReads++;
      if (opts.cold && fileReads < 3) return [];
      return [{ id: 0, path: 'movie.mkv', bytes: BODY.length, progress: 0.25, selected: true, incompleteSuffixes: ['.!qB'],
        ...(!opts.cold || fileReads >= 4 ? { pieceRange: [0, 3] as [number, number] } : {}) }];
    }
    override async pieceSize() {
      if (opts.cold && ++pieceSizeReads === 1) throw new ConnectionError('unexpected_response');
      return PIECE;
    }
    override async pieceStates() { probes++; resolveProbe?.(); resolveProbe = undefined; return opts.cold && probes === 1 ? [] : [...states]; }
    override async setShareLimits() {}
    override async setFilesSelected() {}
  }
  const qbt = new Qbt();
  const store = await DownloadsStore.open(dir);
  if (!opts.cold) await store.upsert({ infoHash: HASH, name: 'Movie', origin: 'search', media: { imdbId: 'tt1', type: 'movie' }, fileIndex: 0, fileName: 'movie.mkv', bytes: BODY.length,
    addedAt: 0, expiresAt: Date.now() + 10000, kept: false, lifecycle: 'managed', owner: { backend: qbt.identity, marker: 'owner', scope: 'debridarr' } });
  let finish: (() => void) | undefined;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const app = createServer((request, response) => {
    void handlePlay(request, response, playRequest({ title: 'Movie', imdbId: 'tt1', type: 'movie', infoHash: HASH, size: BODY.length }), {
      config: { downloadDir: dir } as Config, backend: qbt, store,
      retention: { days: 30, targetRatio: 1, graceDays: 0, extendOnPlay: true, maxCacheGB: 0, storeLeaseDays: 14, minFreeSpaceGB: 0 },
      streamWhileDownloading: true, readyWaitMs: opts.wait ?? 2000,
    }).catch(error => { if (!response.headersSent) response.writeHead(500); response.end(String(error)); }).finally(() => finish?.());
  });
  const base = await listen(app, t);
  return { base, path, dir, done, torrent, adds: () => adds, probes: () => probes, nextProbe: () => new Promise<void>(resolve => { resolveProbe = resolve; }),
    async complete(i: number) { await disk.write(BODY.subarray(i * PIECE, (i + 1) * PIECE), 0, PIECE, i * PIECE); states[i] = 2; } };
}

test('piece mapping never omits an intersecting piece for unaligned files and padding gaps', () => {
  for (let offset = 0; offset < 16; offset++) for (let length = 1; length <= 64; length++) {
    const first = 7;
    const range: [number, number] = [first, first + Math.floor((offset + length - 1) / 16)];
    for (let start = 0; start < length; start++) {
      const end = Math.min(length - 1, start + 5);
      const [low, high] = requiredPieces(range, 16, start, end, length);
      assert.ok(low <= first + Math.floor((offset + start) / 16));
      assert.ok(high >= first + Math.floor((offset + end) / 16));
      assert.ok(low >= first && high <= range[1]);
    }
  }
});

test('partial GET sends available bytes, blocks sparse holes, then continues as pieces finish', async t => {
  const f = await fixture(t);
  const response = await fetch(f.base);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(BODY.length));
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < PIECE) {
    const { value } = await reader.read(); chunks.push(value!); received += value!.length;
  }
  assert.equal(received, PIECE);
  assert.equal(isActive(HASH), true);
  let advanced = false;
  const pending = reader.read().then(value => { advanced = true; return value; });
  await sleep(80);
  assert.equal(advanced, false, 'unwritten preallocated bytes must not be sent');
  for (let i = 1; i < 4; i++) await f.complete(i);
  const next = await pending; if (next.value) chunks.push(next.value);
  for (;;) { const value = await reader.read(); if (value.done) break; chunks.push(value.value); }
  assert.deepEqual(Buffer.concat(chunks), BODY);
  await f.done;
  assert.equal(isActive(HASH), false);
});

test('suffix seeking reads the tail while the middle is missing; HEAD and invalid ranges do not wait', async t => {
  const f = await fixture(t, { states: [2, 0, 0, 2], suffix: true, temp: true });
  const tail = await fetch(f.base, { headers: { Range: 'bytes=-16' } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('content-range'), `bytes ${BODY.length - 16}-${BODY.length - 1}/${BODY.length}`);
  assert.equal(await tail.text(), 'd'.repeat(16));
  const head = await fetch(f.base, { method: 'HEAD', headers: { Range: 'bytes=65536-65545' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const bad = await fetch(f.base, { headers: { Range: 'bytes=99999999999999999999999999-' } });
  assert.equal(bad.status, 416);
});

test('headers arrive while buffering; a stalled body closes without sending unverified bytes', async t => {
  const f = await fixture(t, { states: [0, 0, 0, 0], wait: 30 });
  const response = await fetch(f.base, { headers: { Range: 'bytes=0-9' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-length'), '10');
  await assert.rejects(response.arrayBuffer(), /terminated|aborted|closed/i);
  await f.done;
  assert.equal(isActive(HASH), false);
});

test('disconnect during buffering cancels polling and releases the active reservation', async t => {
  const f = await fixture(t, { states: [0, 0, 0, 0] });
  const controller = new AbortController();
  const probe = f.nextProbe();
  const response = fetch(f.base, { signal: controller.signal }).catch(() => undefined);
  await probe;
  assert.equal(isActive(HASH), true);
  controller.abort();
  await response;
  await f.done;
  assert.equal(isActive(HASH), false);
  const count = f.probes();
  await sleep(50);
  assert.equal(f.probes(), count);
});

test('partial files retain symlink confinement, including the .!qB fallback', async t => {
  const f = await fixture(t, { suffix: true });
  await rename(f.path, join(f.dir, 'held'));
  const outside = await tmpDir(t, 'debridarr-outside');
  await writeFile(join(outside, 'secret'), BODY);
  await symlink(join(outside, 'secret'), f.path);
  const response = await fetch(f.base);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'not_mounted');
});

test('one cold playback request survives delayed magnet metadata, missing piece layout and initially empty piece states', async t => {
  const f = await fixture(t, { cold: true, states: [2, 2, 2, 2], wait: 5000 });
  const response = await fetch(f.base);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), BODY);
  await f.done;
  assert.equal(f.adds(), 1, 'no second click or duplicate add was needed');
  assert.ok(f.probes() >= 2);
  assert.equal(isActive(HASH), false);
});

test('losing ownership during buffering stops the response instead of retrying or reading the file', async t => {
  const f = await fixture(t, { states: [0, 0, 0, 0] });
  const probe = f.nextProbe();
  const response = await fetch(f.base);
  const body = response.arrayBuffer();
  const rejected = assert.rejects(body, /terminated|aborted|closed/i);
  await probe;
  f.torrent.markers = ['another-owner'];
  await rejected;
  await f.done;
  assert.equal(isActive(HASH), false);
});
