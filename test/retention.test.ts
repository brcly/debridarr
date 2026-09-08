import { sourceIdentity } from '../src/security/addon.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DAY_MS } from '../src/downloads/manager.js';
import { DownloadsStore, type DownloadRecord } from '../src/downloads/store.js';
import { sweepOnce } from '../src/retention/sweeper.js';
import { SettingsStore } from '../src/settings.js';
import { listen } from './helpers.js';

interface MockTorrent { hash: string; ratio: number; size: number }

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return new URLSearchParams(body);
}

function mockQbt(t: TestContext, initial: MockTorrent[], opts: { infoStatus?: number } = {}) {
  let torrents = [...initial];
  const deleteCalls: string[] = [];
  const prefsCalls: string[] = [];
  const tags = new Map<string, string>();
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://x');
      const path = url.pathname;
      if (path === '/api/v2/auth/login') { response.setHeader('Set-Cookie', 'SID=s; Path=/'); response.end('Ok.'); return; }
      const form = request.method === 'POST' ? await readForm(request) : new URLSearchParams();
      if (path === '/api/v2/torrents/info') {
        if (opts.infoStatus) { response.statusCode = opts.infoStatus; response.end('error'); return; }
        const live = url.searchParams.get('category') === 'debridarr' ? torrents : torrents.filter(t => t.hash === url.searchParams.get('hashes'));
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(live.map(entry => ({
          category: 'debridarr', tags: tags.get(entry.hash) ?? '', hash: entry.hash, name: entry.hash, state: 'uploading', progress: 1, size: entry.size, ratio: entry.ratio,
          save_path: '/downloads', content_path: '/downloads/x', amount_left: 0, num_seeds: 0, num_leechs: 0,
          dlspeed: 0, eta: 0, seq_dl: true, f_l_piece_prio: true,
        }))));
        return;
      }
      if (path === '/api/v2/torrents/files') { response.end(JSON.stringify([{ index: 0, name: 'movie.mkv', size: 40_000_000_000, progress: 1, priority: 1 }])); return; }
      if (path === '/api/v2/torrents/addTags') { tags.set(form.get('hashes')!, form.get('tags')!); response.end('Ok.'); return; }
      if (path === '/api/v2/app/version') { response.end('v5.0.4'); return; }
      if (path === '/api/v2/torrents/delete') {
        const hash = form.get('hashes') ?? '';
        deleteCalls.push(hash);
        torrents = torrents.filter(entry => entry.hash !== hash);
        response.end('Ok.');
        return;
      }
      if (path === '/api/v2/app/setPreferences') { prefsCalls.push(form.get('json') ?? ''); response.end('Ok.'); return; }
      response.end('Ok.');
    })().catch(() => { response.statusCode = 500; response.end('e'); });
  });
  return listen(server, t).then(base => ({ base, deleteCalls, prefsCalls, live: () => torrents }));
}

async function stores(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'debridarr-retention-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { settings: await SettingsStore.open(dir, {}), downloads: await DownloadsStore.open(dir) };
}

const T = 2_000_000_000_000;
const now = () => T;

const record = (over: Partial<DownloadRecord> = {}): DownloadRecord => ({
  infoHash: 'a'.repeat(40), name: 'A Movie', imdbId: 'tt0000001', type: 'movie',
  fileIndex: 0, fileName: 'movie.mkv', bytes: 40_000_000_000,
  addedAt: T - 40 * DAY_MS, expiresAt: T - 10 * DAY_MS, kept: false, ...over,
});

test('an unconfigured qBittorrent is skipped without touching the store', async t => {
  const { settings, downloads } = await stores(t);
  await downloads.upsert(record());
  const result = await sweepOnce({ store: settings, downloads, now });
  assert.equal(result.skipped, 'qbittorrent_unconfigured');
  assert.equal(downloads.list().length, 1);
});

test('an unreachable qBittorrent aborts the sweep instead of treating everything as gone', async t => {
  const { base } = await mockQbt(t, [], { infoStatus: 500 });
  const { settings, downloads } = await stores(t);
  await settings.update({ qbittorrent: { url: base, username: 'u', password: 'p' } });
  await downloads.upsert(record());
  const result = await sweepOnce({ store: settings, downloads, now });
  assert.equal(result.skipped, 'qbittorrent_unreachable');
  assert.equal(downloads.list().length, 1, 'nothing removed');
});

test('deletes an expired torrent once the ratio target is met, and pauses ratio-limited torrents', async t => {
  const { base, deleteCalls, prefsCalls, live } = await mockQbt(t, [{ hash: 'a'.repeat(40), ratio: 1.2, size: 40_000_000_000 }]);
  const { settings, downloads } = await stores(t);
  await settings.update({ qbittorrent: { url: base, username: 'u', password: 'p' }, retention: { targetRatio: 1 } });
  await downloads.upsert(record());
  const result = await sweepOnce({ store: settings, downloads, now });
  assert.deepEqual(result.deleted, ['a'.repeat(40)]);
  assert.equal(downloads.list().length, 0);
  assert.deepEqual(deleteCalls, ['a'.repeat(40)]);
  assert.deepEqual(live(), []);
  assert.deepEqual(prefsCalls, []);
});

test('an expired torrent whose ratio has not reached target is left alone with no grace period', async t => {
  const { base } = await mockQbt(t, [{ hash: 'a'.repeat(40), ratio: 0.3, size: 40_000_000_000 }]);
  const { settings, downloads } = await stores(t);
  await settings.update({ qbittorrent: { url: base, username: 'u', password: 'p' }, retention: { targetRatio: 1, graceDays: 0 } });
  await downloads.upsert(record());
  const result = await sweepOnce({ store: settings, downloads, now });
  assert.deepEqual(result.deleted, []);
  assert.equal(downloads.list().length, 1);
});

test('graceDays forces deletion past expiry + grace even if the ratio target is unreachable', async t => {
  const { base } = await mockQbt(t, [{ hash: 'a'.repeat(40), ratio: 0.3, size: 40_000_000_000 }]);
  const { settings, downloads } = await stores(t);
  await settings.update({ qbittorrent: { url: base, username: 'u', password: 'p' }, retention: { targetRatio: 1, graceDays: 5 } });
  await downloads.upsert(record({ expiresAt: T - 6 * DAY_MS })); // expired 6 days ago; grace is 5 days
  const result = await sweepOnce({ store: settings, downloads, now });
  assert.deepEqual(result.deleted, ['a'.repeat(40)]);
});

test('kept titles are never deleted regardless of expiry or ratio', async t => {
  const { base } = await mockQbt(t, [{ hash: 'a'.repeat(40), ratio: 5, size: 40_000_000_000 }]);
  const { settings, downloads } = await stores(t);
  await settings.update({ qbittorrent: { url: base, username: 'u', password: 'p' }, retention: { targetRatio: 1, graceDays: 999 } });
  await downloads.upsert(record({ kept: true, expiresAt: T - 2000 * DAY_MS }));
  const result = await sweepOnce({ store: settings, downloads, now });
  assert.deepEqual(result.deleted, []);
  assert.equal(downloads.list().length, 1);
});

test('a title with an active playback stream is skipped', async t => {
  const { base } = await mockQbt(t, [{ hash: 'a'.repeat(40), ratio: 5, size: 40_000_000_000 }]);
  const { settings, downloads } = await stores(t);
  await settings.update({ qbittorrent: { url: base, username: 'u', password: 'p' }, retention: { targetRatio: 1 } });
  await downloads.upsert(record());
  const result = await sweepOnce({ store: settings, downloads, now, isActive: hash => hash === 'a'.repeat(40) });
  assert.deepEqual(result.deleted, []);
  assert.equal(downloads.list().length, 1);
});

test('a stale record whose torrent is already gone from qBittorrent is cleaned up', async t => {
  const { base } = await mockQbt(t, []); // qBittorrent no longer has it
  const { settings, downloads } = await stores(t);
  await settings.update({ qbittorrent: { url: base, username: 'u', password: 'p' } });
  await downloads.upsert(record({ expiresAt: T + 10 * DAY_MS, owner: { client: sourceIdentity({ url: base }), category: 'debridarr', tag: 'test' } })); // not even expired, but it's simply gone
  const result = await sweepOnce({ store: settings, downloads, now });
  assert.deepEqual(result.staleRemoved, ['a'.repeat(40)]);
  assert.deepEqual(result.deleted, []);
  assert.equal(downloads.list().length, 0);
});

test('maxCacheGB evicts the soonest-to-expire non-kept, non-active survivors first', async t => {
  const hashA = 'a'.repeat(40), hashB = 'b'.repeat(40), hashC = 'c'.repeat(40);
  const size = 40_000_000_000; // 40 GB each, 120 GB total
  const { base, deleteCalls, live } = await mockQbt(t, [
    { hash: hashA, ratio: 0, size }, { hash: hashB, ratio: 0, size }, { hash: hashC, ratio: 0, size },
  ]);
  const { settings, downloads } = await stores(t);
  await settings.update({ qbittorrent: { url: base, username: 'u', password: 'p' }, retention: { maxCacheGB: 60 } });
  // None of these are expired; only the cache cap should act.
  await downloads.upsert(record({ infoHash: hashA, expiresAt: T + 1 * DAY_MS }));
  await downloads.upsert(record({ infoHash: hashB, expiresAt: T + 2 * DAY_MS, kept: true }));
  await downloads.upsert(record({ infoHash: hashC, expiresAt: T + 3 * DAY_MS }));
  const result = await sweepOnce({ store: settings, downloads, now });
  assert.deepEqual(result.evicted, [hashA, hashC], 'soonest-expiry non-kept survivors evicted until under the cap');
  assert.deepEqual(deleteCalls, [hashA, hashC]);
  assert.deepEqual(live(), [{ hash: hashB, ratio: 0, size }], 'kept title stays despite counting toward the cap');
  assert.deepEqual(downloads.list().map(r => r.infoHash), [hashB]);
});
