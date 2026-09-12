import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { TransferError, TransferService } from '../src/application/transfers.js';
import type { DownloadBackend, DownloadCapabilities, DownloadFile, DownloadSnapshot, DownloadSource } from '../src/backends/download.js';
import { ensureTransfer } from '../src/downloads/manager.js';
import { isNzb, nzbIdentity } from '../src/downloads/nzb.js';
import { DownloadsStore } from '../src/downloads/store.js';
import { QBittorrentClient } from '../src/integrations/qbittorrent/client.js';
import { TransmissionClient } from '../src/integrations/transmission/client.js';
import { DelugeClient } from '../src/integrations/deluge/client.js';
import { HttpError } from '../src/http.js';
import { releaseRequest } from '../src/search/requests.js';
import { fetchTorrentSource } from '../src/security/torrentSource.js';
import { parseStoreAdd } from '../src/store/input.js';
import { listen, tmpDir } from './helpers.js';

const NZB = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file subject="The.Matrix.1999.1080p.mkv">
    <groups><group>alt.binaries.test</group></groups>
    <segments><segment bytes="100" number="1">id@example</segment></segments>
  </file>
</nzb>`);
const NZB_ID = nzbIdentity(NZB);

class FakeUsenet implements DownloadBackend {
  readonly protocol = 'usenet' as const;
  readonly identity = 'usenet-fixture';
  readonly configured = true;
  readonly pathMappings = [];
  readonly capabilities: DownloadCapabilities = {
    markers: { add: async (hash, marker) => { this.jobs.get(hash)?.snapshot.markers.push(marker); } },
  };
  jobs = new Map<string, { snapshot: DownloadSnapshot; files: DownloadFile[] }>();
  submitted: DownloadSource[] = [];

  test() { return Promise.resolve({ ok: true, code: 'connected' as const, message: 'Connected successfully.', version: '4.3.0' }); }
  async get(hash: string) { return this.jobs.get(hash.toLowerCase())?.snapshot; }
  async list(scope: string) { return [...this.jobs.values()].map(job => job.snapshot).filter(entry => entry.scope === scope); }
  async getFiles(hash: string) { return this.jobs.get(hash.toLowerCase())?.files ?? []; }
  async submit(source: DownloadSource, options: { ownership: { backend: string; scope: string; marker: string } }, _signal: AbortSignal) {
    if (source.type !== 'nzb') throw new Error('expected nzb');
    this.submitted.push(source);
    const id = nzbIdentity(source.bytes);
    this.jobs.set(id, {
      snapshot: {
        infoHash: id, scope: options.ownership.scope, markers: [options.ownership.marker],
        name: 'The Matrix 1999', state: 'downloading', progress: 1, bytes: 100, ratio: 0,
        savePath: '/downloads', contentPath: '/downloads/movie.mkv', bytesRemaining: 0,
        seeders: 0, leechers: 0, downloadSpeed: 0, eta: 0,
      },
      files: [{ id: 0, path: 'movie.mkv', bytes: 100, progress: 1, selected: true }],
    });
  }
  async setFilesSelected(hash: string, ids: number[], selected: boolean) {
    const job = this.jobs.get(hash.toLowerCase());
    if (!job) return;
    for (const file of job.files) if (ids.includes(file.id)) file.selected = selected;
  }
  async remove(hash: string) { this.jobs.delete(hash.toLowerCase()); }
  async setRunning() { /* Usenet jobs still have a running/stopped state. */ }
}

async function store(t: TestContext) {
  const dir = await tmpDir(t, 'debridarr-nzb');
  return DownloadsStore.open(dir);
}

test('isNzb and nzbIdentity are a content hash, not a torrent infohash', () => {
  assert.equal(isNzb(NZB), true);
  assert.equal(isNzb(Buffer.from('d4:infod4:name4:teste6:lengthi1ee')), false);
  assert.equal(nzbIdentity(NZB), createHash('sha1').update(NZB).digest('hex'));
  assert.match(NZB_ID, /^[a-f0-9]{40}$/);
});

test('parseStoreAdd accepts base64 NZB and an http downloadUrl, and rejects mixed sources', () => {
  const parsed = parseStoreAdd({ nzb: NZB.toString('base64'), name: 'The Matrix' });
  assert.ok('nzb' in parsed.source);
  assert.deepEqual(('nzb' in parsed.source ? parsed.source.nzb : undefined), NZB);
  assert.equal(parsed.name, 'The Matrix');
  const url = parseStoreAdd({ downloadUrl: 'https://indexer.example/get?t=get&id=1' });
  assert.deepEqual(url.source, { downloadUrl: 'https://indexer.example/get?t=get&id=1' });
  assert.throws(() => parseStoreAdd({ nzb: NZB.toString('base64'), magnet: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) }), HttpError);
  assert.throws(() => parseStoreAdd({ nzb: Buffer.from('<html>not nzb</html>').toString('base64') }), /NZB file/);
  assert.throws(() => parseStoreAdd({ downloadUrl: 'ftp://indexer.example/file.nzb' }), /http/);
});

test('a Usenet release with only a downloadUrl is a persistable prepare request and has no infoHash', () => {
  const request = releaseRequest({
    title: 'The Matrix 1999 1080p', size: 100, seeders: 0, leechers: 0, indexer: 'nzbs',
    protocol: 'usenet', guid: 'g1', downloadUrl: 'https://indexer.example/get?id=1',
  }, { type: 'movie', imdbId: 'tt0133093' });
  assert.ok(request);
  assert.deepEqual(request!.source, { downloadUrl: 'https://indexer.example/get?id=1' });
  assert.equal('infoHash' in request!.source, false);
});

test('ensureTransfer submits NZB bytes to a Usenet backend and tracks them by content hash', async t => {
  const downloads = await store(t);
  const backend = new FakeUsenet();
  const state = await ensureTransfer(
    { source: { nzb: NZB }, origin: 'store', name: 'The Matrix 1999', bytes: 100 },
    { backend, store: downloads, signal: AbortSignal.timeout(3000) },
  );
  assert.equal(state.record.infoHash, NZB_ID);
  assert.equal(state.record.origin, 'store');
  assert.equal(state.record.lifecycle, 'managed');
  assert.equal(backend.submitted[0]?.type, 'nzb');
  assert.equal(state.file.path, 'movie.mkv');
  assert.ok(state.record.owner?.marker);
  assert.ok(state.torrent.markers.includes(state.record.owner!.marker));
  assert.equal(state.torrent.seeders, 0);
  assert.equal(backend.capabilities.pieces, undefined);
  assert.equal(backend.capabilities.seedLimits, undefined);
});

test('TransferService.add creates an NZB transfer whose id is not an infoHash of a torrent', async t => {
  const downloads = await store(t);
  const backend = new FakeUsenet();
  const service = new TransferService({ downloads, backend, leaseDays: 14 });
  const { item, pending } = await service.add({ source: { nzb: NZB }, name: 'The Matrix 1999' });
  assert.equal(pending, false);
  assert.equal(item.id, NZB_ID);
  assert.equal(item.name, 'The Matrix 1999');
  assert.equal(service.get(NZB_ID)?.id, NZB_ID);
});

test('a torrent backend refuses NZB input before talking to the client', async t => {
  const downloads = await store(t);
  const qbt = new QBittorrentClient({ url: 'http://127.0.0.1:1', username: 'u', password: 'p' });
  await assert.rejects(
    ensureTransfer({ source: { nzb: NZB }, origin: 'store', name: 'The Matrix', bytes: 1 }, { backend: qbt, store: downloads, signal: AbortSignal.timeout(1000) }),
    error => error instanceof Error && /does not accept NZB/.test(error.message),
  );
  const service = new TransferService({ downloads, backend: qbt, leaseDays: 14 });
  await assert.rejects(service.add({ source: { nzb: NZB } }), TransferError);
});

test('torrent adapters reject nzb submit rather than treating it as metainfo', async () => {
  const signal = AbortSignal.timeout(500);
  const nzb = { type: 'nzb' as const, bytes: NZB };
  const ownership = { backend: 'x', scope: 'debridarr', marker: 'm' };
  await assert.rejects(new QBittorrentClient({ url: 'http://127.0.0.1:1', username: 'u', password: 'p' }).submit(nzb, { ownership }, signal));
  await assert.rejects(new TransmissionClient({ url: 'http://127.0.0.1:1', username: '', password: '' }).submit(nzb, { ownership }, signal));
  await assert.rejects(new DelugeClient({ url: 'http://127.0.0.1:1', username: '', password: 'p' }).submit(nzb, { ownership }, signal));
});

test('fetchTorrentSource sniffs an NZB body from a provider download URL', async t => {
  const base = await listen(createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/x-nzb');
    response.end(NZB);
  }), t);
  const fetched = await fetchTorrentSource(`${base}/get?id=1`, AbortSignal.timeout(1000), [{ url: base, apiKey: 'k', type: 'torznab' }]);
  assert.ok(fetched.nzb);
  assert.equal(fetched.bytes, undefined);
  assert.equal(nzbIdentity(fetched.nzb!), NZB_ID);
});
