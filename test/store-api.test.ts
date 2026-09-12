import { DownloadRecovery } from '../src/downloads/recovery.js';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { StremThru, StremThruError } from 'stremthru';
import { verifyLink } from '../src/api/v1/links.js';
import { parseInfoHash } from '../src/downloads/torrentFile.js';
import { appFixture } from './app-fixture.js';
import { SAMPLE_HASH as HASH, SAMPLE_TORRENT as TORRENT } from './fake-qbt.js';

async function fixture(t: TestContext) {
  const f = await appFixture(t, { prefix: 'debridarr-api-', tokenName: 'SDK' });
  const request = (path: string, method = 'GET', data?: unknown, bearer = f.token) => fetch(`${f.base}${path}`, {
    method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return {
    base: f.base, request, settings: f.settings, downloads: f.downloads, access: f.access, tokens: f.tokens, token: f.token,
    torrents: f.qbt.torrents, failures: f.qbt.failures, state: f.qbt.state, fileList: f.qbt.fileList,
    categoryReads: f.qbt.categoryReads, setFilesReady: f.qbt.setFilesReady,
  };
}

test('GET /health is liveness; GET /health/ready is 200 when stores load', async t => {
  const { base } = await fixture(t);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const ready = await fetch(`${base}/health/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    status: 'ready',
    checks: { store: 'ok', downloads: 'ok', backend: 'ok', downloadDir: 'ok' },
  });
});

test('native REST adds, batches status, lists files, links selected files and deletes; search mode has no store/CORS surface', async t => {
  const { request, settings, access, tokens, downloads, categoryReads, base, torrents } = await fixture(t);
  for (const method of ['GET', 'POST', 'OPTIONS']) {
    await settings.update({ integrations: { mode: 'search' } });
    const response = await request('/store/v1/magnets', method);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  await settings.update({ integrations: { mode: 'both' } });
  assert.equal((await request('/store/v1/magnets', 'GET', undefined, '')).status, 401);
  const added = await request('/store/v1/magnets', 'POST', { magnet: `magnet:?xt=urn:btih:${HASH}&dn=Movie.1080p` });
  assert.equal(added.status, 201);
  const { item } = await added.json();
  assert.equal(item.infoHash, HASH);
  assert.equal(item.name, 'Movie.1080p');
  assert.equal(item.expiresAt - item.addedAt, 14 * 86_400_000);
  assert.equal(downloads.get(HASH)?.origin, 'store');
  assert.equal(downloads.get(HASH)?.media, undefined);
  const before = categoryReads();
  await Promise.all(Array.from({ length: 3 }, () => request(`/store/v1/magnets?hash=${HASH}`)));
  assert.equal(categoryReads() - before, 1, 'cold status polls share one upstream request');
  const statuses = await (await request(`/store/v1/magnets?hash=${HASH},${'b'.repeat(40)}`)).json();
  assert.equal(statuses.statuses[HASH].state, 'ready');
  assert.equal(statuses.statuses['b'.repeat(40)].state, 'missing');
  assert.equal((await (await request('/store/v1/magnets')).json()).items.length, 1);
  const { files } = await (await request(`/store/v1/magnets/${HASH}/files`)).json();
  assert.deepEqual(files.map((f: { id: string; video: boolean }) => [f.id, f.video]), [['0', true], ['1', true], ['2', false]]);
  assert.equal((await request(`/store/v1/magnets/${'b'.repeat(40)}/files`)).status, 404);
  const linked = await (await request(`/store/v1/magnets/${HASH}/files/0/link`, 'POST')).json();
  assert.match(linked.url, /^https:\/\/public\.example\/api\/v1\/download\/[\w-]+\.[\w-]+$/);
  assert.equal(verifyLink(tokens.linkSecret(), linked.url.split('/').at(-1)!, Date.now())?.fileId, 0);
  assert.equal((await request(`/store/v1/magnets/${HASH}/files/1/link`, 'POST')).status, 200);
  assert.equal((await request(`/store/v1/magnets/${HASH}/files/-1/link`, 'POST')).status, 404);
  const addon = access.base(base);
  const streams = async (hash: string) => (await (await fetch(`${addon}/stream/other/db:${hash}.json`)).json()).streams;
  const [stream] = await streams(HASH);
  assert.match(stream.url, /\/api\/v1\/download\//);
  assert.match(stream.name, /Debridarr/);
  assert.match(stream.title, /Ready to play/);
  assert.equal(stream.description, stream.title);
  assert.equal(stream.behaviorHints.notWebReady, true);
  assert.deepEqual(await streams('e'.repeat(40)), []);
  const row = torrents.get(HASH)!;
  const tag = row.tags;
  row.tags = 'foreign';
  assert.deepEqual(await streams(HASH), []);
  row.tags = tag;
  const record = downloads.get(HASH)!;
  await downloads.upsert({ ...record, origin: 'search' });
  assert.equal((await (await request('/store/v1/magnets')).json()).items.length, 0);
  assert.equal((await request(`/store/v1/magnets/${HASH}`)).status, 404);
  await downloads.upsert(record);
  assert.equal((await request(`/store/v1/magnets/${HASH}`, 'DELETE')).status, 200);
  assert.equal(downloads.get(HASH), undefined);
  assert.equal((await request(`/store/v1/magnets/${HASH}`, 'DELETE')).status, 404);
  assert.equal((await request(`/store/v1/magnets/${HASH}`, 'GET')).status, 404);
});

test('pinned StremThru 0.13.0 SDK exercises user, add, check, get, list, generate and remove over real HTTP', async t => {
  const { base, token, categoryReads, request } = await fixture(t);
  const client = new StremThru({ baseUrl: base, auth: { store: 'debridarr', token } });
  assert.equal((await client.health()).data.status, 'ok');
  assert.equal((await client.store.getUser()).data.subscription_status, 'premium');
  const added = await client.store.addMagnet({ magnet: `magnet:?xt=urn:btih:${HASH}&dn=Movie` });
  assert.equal(added.data.hash, HASH);
  assert.equal(added.data.status, 'downloaded');
  assert.equal(added.data.files.length, 2, 'playable files can be selected when generating playback requests');
  const before = categoryReads();
  const results = await Promise.all(Array.from({ length: 3 }, () => client.store.checkMagnet({ magnet: [HASH, 'b'.repeat(40)] })));
  assert.equal(categoryReads(), before, 'polls reuse the category snapshot');
  assert.deepEqual(results[0]!.data.items.map(i => i.status), ['cached', 'unknown']);
  const item = (await client.store.getMagnet(HASH)).data;
  assert.equal(item.files[0]!.path, 'movie.mkv');
  assert.equal((await client.store.listMagnets({ limit: 1 })).data.total_items, 1);
  assert.equal((await client.store.listMagnets({ offset: 1 })).data.items.length, 0);
  assert.match((await client.store.generateLink({ link: item.files[0]!.link })).data.link, /\/api\/v1\/download\//);
  assert.equal((await request('/store/stremthru/magnets')).status, 200);
  assert.equal((await request('/store/stremthru/v0/store/magnets')).status, 200);
  assert.equal((await client.store.removeMagnet(HASH)).data, null);
  await assert.rejects(client.store.getMagnet(HASH), (e: unknown) => e instanceof StremThruError && e.statusCode === 404 && e.code === 'NOT_FOUND');
});

test('SDK multipart and native binary torrents are supported; untrusted URLs and oversized bodies are rejected', async t => {
  const { base, token, request } = await fixture(t);
  const client = new StremThru({ baseUrl: base, auth: { store: 'debridarr', token } });
  assert.equal((await client.store.addMagnet({ torrent: new File([TORRENT], 'movie.torrent') })).data.hash, parseInfoHash(TORRENT));
  const uploaded = await fetch(`${base}/store/v1/magnets`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-bittorrent' }, body: TORRENT });
  assert.equal(uploaded.status, 201);
  await assert.rejects(client.store.addMagnet({ torrent: 'http://127.0.0.1/private' }), (e: unknown) => e instanceof StremThruError && e.statusCode === 400);
  assert.equal((await request('/store/v1/magnets', 'POST', { magnet: 'http://127.0.0.1/private' })).status, 400);
  assert.equal((await request('/store/v1/magnets', 'POST', { magnet: HASH, infoHash: HASH })).status, 400);
  assert.equal((await request('/store/v1/magnets?hash=bad')).status, 400);
  const oversized = await fetch(`${base}/store/v1/magnets`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-bittorrent' }, body: Buffer.alloc(2 * 1024 * 1024 + 1) });
  assert.equal(oversized.status, 413);
});

test('native and adapter share token quotas and revocation, and auth failures are throttled without CORS', async t => {
  const { request, tokens, base } = await fixture(t);
  const limited = await tokens.create({ name: 'Limited', quotas: { requestsPerMinute: 1 } });
  assert.equal((await request('/store/v1/magnets', 'GET', undefined, limited.token)).status, 200);
  const client = new StremThru({ baseUrl: base, auth: { store: 'debridarr', token: limited.token } });
  await assert.rejects(client.store.getUser(), (e: unknown) => e instanceof StremThruError && e.statusCode === 429);
  await tokens.revoke(limited.item.id);
  assert.equal((await request('/store/v1/magnets', 'GET', undefined, limited.token)).status, 401);
  for (let n = 0; n < 4; n++) assert.equal((await request('/store/v1/magnets', 'GET', undefined, 'bad')).status, 401);
  const throttled = await request('/store/v1/magnets', 'GET', undefined, 'bad');
  assert.equal(throttled.status, 429);
  assert.ok(throttled.headers.get('retry-after'));
  assert.equal(throttled.headers.get('access-control-allow-origin'), null);
});


test('a slow magnet returns a tracked 202 and background recovery completes it without a duplicate', async t => {
  const { request, downloads, settings, setFilesReady, base, token } = await fixture(t);
  setFilesReady(false);
  const response = await request('/store/v1/magnets', 'POST', { infoHash: HASH });
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.pending, true);
  assert.equal(result.item.lifecycle, 'registering');
  assert.equal((await (await request(`/store/v1/magnets/${HASH}`)).json()).item.infoHash, HASH);
  const client = new StremThru({ baseUrl: base, auth: { store: 'debridarr', token } });
  assert.equal((await client.store.getMagnet(HASH)).data.status, 'processing');
  assert.equal((await client.store.checkMagnet({ magnet: [HASH] })).data.items[0]!.status, 'queued', 'a still-registering add is queued, not failed');
  assert.equal((await (await request(`/store/v1/magnets?hash=${HASH}`)).json()).statuses[HASH].state, 'queued');
  setFilesReady(true);
  await new DownloadRecovery({ downloads, store: settings }).run();
  assert.equal(downloads.get(HASH)?.lifecycle, 'managed');
  assert.equal(downloads.list().length, 1);
  assert.equal((await client.store.getMagnet(HASH)).data.status, 'downloaded');
});


test('StremThru supports the upstream 500-hash batch contract, including requests above the default Node header limit', async t => {
  const { base, token, categoryReads } = await fixture(t);
  const client = new StremThru({ baseUrl: base, auth: { store: 'debridarr', token } });
  const magnet = Array.from({ length: 500 }, (_, i) => i.toString(16).padStart(40, '0'));
  const { data } = await client.store.checkMagnet({ magnet });
  assert.equal(data.items.length, 500);
  assert.ok(data.items.every(i => i.status === 'unknown'));
  assert.equal(categoryReads(), 1);
  await assert.rejects(client.store.checkMagnet({ magnet: [...magnet, HASH] }), (e: unknown) => e instanceof StremThruError && e.statusCode === 400);
});


test('upstream status failures are retryable and failed deletion stays tracked until confirmed', async t => {
  const { request, downloads, failures } = await fixture(t);
  assert.equal((await request('/store/v1/magnets', 'POST', { infoHash: HASH })).status, 201);
  failures.add('info');
  assert.equal((await request(`/store/v1/magnets?hash=${HASH}`)).status, 502);
  failures.clear();
  assert.equal((await (await request(`/store/v1/magnets?hash=${HASH}`)).json()).statuses[HASH].state, 'ready');
  failures.add('delete');
  assert.equal((await request(`/store/v1/magnets/${HASH}`, 'DELETE')).status, 502);
  assert.equal(downloads.get(HASH)?.lifecycle, 'deleting');
  failures.clear();
  assert.equal((await request(`/store/v1/magnets/${HASH}`, 'DELETE')).status, 200);
  assert.equal(downloads.get(HASH), undefined);
});

test('store files are selectable without browsing mutations; low space blocks new work and preserves existing playback', async t => {
  const { request, downloads, tokens, state, fileList } = await fixture(t);
  state.freeBytes = 0;
  assert.equal((await request('/store/v1/magnets', 'POST', { infoHash: HASH })).status, 507);
  assert.equal(downloads.get(HASH), undefined, 'rejected additions leave no registration intent');
  state.freeBytes = -1;
  assert.equal((await request('/store/v1/magnets', 'POST', { infoHash: HASH })).status, 503, 'invalid storage measurements fail closed');
  assert.equal(downloads.get(HASH), undefined);
  state.freeBytes = 100e9;
  assert.equal((await request('/store/v1/magnets', 'POST', { infoHash: HASH })).status, 201);
  const before = downloads.get(HASH)!;
  const linked = await (await request(`/store/v1/magnets/${HASH}/files/1/link`, 'POST')).json();
  assert.equal(verifyLink(tokens.linkSecret(), linked.url.split('/').at(-1)!, Date.now())?.fileId, 1);
  assert.deepEqual(downloads.get(HASH), before, 'minting links never changes selections or leases');
  assert.equal(fileList[1]!.priority, 0);
  state.freeBytes = 0;
  assert.equal((await request(`/store/v1/magnets/${HASH}/files/1/select`, 'POST')).status, 507);
  assert.deepEqual(downloads.get(HASH), before);
  assert.equal((await request(`/store/v1/magnets/${HASH}/files/0/link`, 'POST')).status, 200);
  state.freeBytes = 100e9;
  assert.equal((await request(`/store/v1/magnets/${HASH}/files/1/select`, 'POST')).status, 200);
  assert.deepEqual(downloads.get(HASH)!.selectedFiles!.map(f => f.index), [0, 1]);
  assert.equal(fileList[1]!.priority, 1);
  assert.equal(downloads.get(HASH)!.expiresAt, before.expiresAt, 'selection does not renew a playback lease');
  assert.equal((await request(`/store/v1/magnets/${HASH}/files/2/select`, 'POST')).status, 400, 'non-video files cannot be selected');
});
