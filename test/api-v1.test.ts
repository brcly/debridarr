import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import { parseInfoHash } from '../src/downloads/torrentFile.js';
import { appFixture } from './app-fixture.js';
import { SAMPLE_HASH as HASH, SAMPLE_TORRENT as TORRENT } from './fake-qbt.js';
import { tmpDir } from './helpers.js';

const run = promisify(execFile);
// Independent verification that the zip route's *wired* output (not just the
// writer in isolation — see archive-zip.test.ts) is a real, spec-compliant
// archive with the expected entries and byte-exact content.
async function inspectZip(t: TestContext, bytes: Buffer): Promise<{ names: string[]; contents: Record<string, string> }> {
  const dir = await tmpDir(t, 'debridarr-apiv1-zip');
  const path = join(dir, 'out.zip');
  await writeFile(path, bytes);
  const script = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
names = z.namelist()
print(json.dumps({"names": names, "contents": {n: z.read(n).decode('utf8') for n in names}}))
`;
  const { stdout } = await run('python3', ['-c', script, path]);
  return JSON.parse(stdout);
}

const OTHER = 'b'.repeat(40);

async function fixture(t: TestContext) {
  const f = await appFixture(t, {
    prefix: 'debridarr-apiv1-',
    mode: 'both',
    tokenName: 'full',
    seedPlaybackFile: true,
    files: [
      { index: 0, name: 'movie.mkv', size: 100, progress: 1, priority: 1 },
      { index: 1, name: 'second.mkv', size: 50, progress: 0, priority: 0 },
      { index: 2, name: 'readme.nfo', size: 5, progress: 1, priority: 1 },
    ],
  });
  const api = (path: string, opts: { method?: string; token?: string | null; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? f.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${f.base}${path}`, {
      method: opts.method ?? 'GET', headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  };
  const upload = (bytes: Buffer<ArrayBuffer>, bearer = f.token) => fetch(`${f.base}/api/v1/transfers`, {
    method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/x-bittorrent' }, body: bytes,
  });
  return {
    base: f.base, api, upload, settings: f.settings, downloads: f.downloads, tokens: f.tokens, token: f.token,
    state: f.qbt.state, fileList: f.qbt.fileList, setFilesReady: f.qbt.setFilesReady,
    torrents: f.qbt.torrents, failures: f.qbt.failures, qbt: f.qbt,
  };
}

test('openapi is public, capabilities report scopes and backend features, and the surface is 404 in search mode', async t => {
  const { api, settings } = await fixture(t);

  const doc = await api('/api/v1/openapi.json', { token: null });
  assert.equal(doc.status, 200);
  const spec = await doc.json();
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.paths['/transfers'] && spec.paths['/transfers/preview'] && spec.paths['/transfers/{id}/pause'] && spec.paths['/download/{token}']);

  await settings.update({ integrations: { mode: 'search' } });
  assert.equal((await api('/api/v1/capabilities')).status, 404);
  assert.equal((await api('/api/v1/transfers')).status, 404);
  assert.equal((await api('/api/v1/openapi.json', { token: null })).status, 200);

  await settings.update({ integrations: { mode: 'both' } });
  const noAuth = await api('/api/v1/capabilities', { token: null });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await noAuth.json()).error.code, 'unauthorized');

  const caps = await (await api('/api/v1/capabilities')).json();
  assert.deepEqual(caps.token.scopes, ['read', 'write', 'link']);
  assert.equal(caps.backend.configured, true);
  assert.equal(caps.backend.input.magnet, true);
  assert.equal(caps.backend.input.nzb, false);
  assert.equal(caps.backend.fileSelection, true);
  assert.equal(caps.backend.freeSpace, true);
  assert.equal(caps.backend.queue, true);
  assert.equal(caps.backend.cachedOnly, true);
  assert.equal(caps.backend.pause, true);
  assert.equal(caps.backend.preview, true);
  assert.equal(caps.limits.maxTorrentBytes, 2 * 1024 * 1024);
  assert.equal(caps.limits.batchStatusMax, 100);
});

test('create is asynchronous, idempotent, and accepts JSON and raw torrent bodies', async t => {
  const { api, upload, downloads, setFilesReady } = await fixture(t);

  const created = await api('/api/v1/transfers', { method: 'POST', body: { magnet: `magnet:?xt=urn:btih:${HASH}&dn=Movie` } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('location'), `/api/v1/transfers/${HASH}`);
  const first = (await created.json()).transfer;
  assert.equal(first.id, HASH);
  assert.equal(first.lifecycle, 'managed');

  const replay = await api('/api/v1/transfers', { method: 'POST', body: { infoHash: HASH }, headers: { 'Idempotency-Key': 'abc-1' } });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('idempotency-replay'), null);
  const again = await api('/api/v1/transfers', { method: 'POST', body: { infoHash: HASH }, headers: { 'Idempotency-Key': 'abc-1' } });
  assert.equal(again.headers.get('idempotency-replay'), 'true');
  assert.deepEqual(await again.json(), await replay.clone().json());
  assert.equal((await api('/api/v1/transfers', { method: 'POST', body: { infoHash: HASH }, headers: { 'Idempotency-Key': 'bad key' } })).status, 400);

  const uploaded = await upload(TORRENT);
  assert.equal(uploaded.status, 201);
  assert.equal((await uploaded.json()).transfer.id, parseInfoHash(TORRENT));

  setFilesReady(false);
  const pending = await api('/api/v1/transfers', { method: 'POST', body: { infoHash: OTHER } });
  assert.equal(pending.status, 202);
  assert.equal((await pending.json()).transfer.lifecycle, 'registering');
  assert.equal(downloads.get(OTHER)?.lifecycle, 'registering');
});

test('listing is cursor-paginated and rejects a bad cursor or limit', async t => {
  const { api, downloads } = await fixture(t);
  for (let i = 0; i < 3; i++) {
    await downloads.upsert({
      origin: 'store', infoHash: String(i).repeat(40), name: `T${i}`, fileIndex: 0, fileName: '', bytes: 0,
      addedAt: 1000 + i, expiresAt: Date.now() + 1e6, kept: false, lifecycle: 'managed',
      owner: { backend: 'x', scope: 'debridarr', marker: `m${i}` }, selectedFiles: [],
    });
  }
  const page1 = await (await api('/api/v1/transfers?limit=2')).json();
  assert.equal(page1.items.length, 2);
  assert.equal(page1.items[0].id, '2'.repeat(40), 'newest first');
  assert.ok(page1.next_cursor);
  const page2 = await (await api(`/api/v1/transfers?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`)).json();
  assert.equal(page2.items.length, 1);
  assert.equal(page2.items[0].id, '0'.repeat(40));
  assert.equal(page2.next_cursor, null);
  assert.equal((await api('/api/v1/transfers?limit=0')).status, 400);
  assert.equal((await api('/api/v1/transfers?cursor=not-a-cursor')).status, 400);
});

test('inspect and batch status report per-transfer state', async t => {
  const { api } = await fixture(t);
  await api('/api/v1/transfers', { method: 'POST', body: { infoHash: HASH } });
  assert.equal((await (await api(`/api/v1/transfers/${HASH}`)).json()).transfer.id, HASH);
  assert.equal((await api(`/api/v1/transfers/${OTHER}`)).status, 404);

  const statuses = (await (await api(`/api/v1/transfers/status?ids=${HASH},${OTHER}`)).json()).statuses;
  assert.equal(statuses[HASH].state, 'ready');
  assert.equal(statuses[OTHER].state, 'missing');

  const many = Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(40, '0')).join(',');
  assert.equal((await api(`/api/v1/transfers/status?ids=${many}`)).status, 400);
});

test('files can be listed and selected, links are signed and stream with range support', async t => {
  const { api, fileList } = await fixture(t);
  await api('/api/v1/transfers', { method: 'POST', body: { infoHash: HASH } });

  const files = (await (await api(`/api/v1/transfers/${HASH}/files`)).json()).files;
  assert.deepEqual(files.map((f: { id: string; video: boolean }) => [f.id, f.video]), [['0', true], ['1', true], ['2', false]]);

  const selected = await (await api(`/api/v1/transfers/${HASH}/files/1/select`, { method: 'POST' })).json();
  assert.equal(selected.file.id, '1');
  assert.equal(fileList[1]!.priority, 1);

  const link = (await (await api(`/api/v1/transfers/${HASH}/files/0/link`, { method: 'POST' })).json()).link;
  assert.match(link.url, /^https:\/\/public\.example\/api\/v1\/download\/[\w-]+\.[\w-]+$/);
  assert.ok(link.expiresAt > Date.now());

  // Playback links carry APP_URL; point the path back at the test server.
  const path = new URL(link.url).pathname;
  const full = await api(path, { token: null });
  assert.equal(full.status, 200);
  assert.equal(Buffer.from(await full.arrayBuffer()).length, 100);

  const part = await api(path, { token: null, headers: { Range: 'bytes=0-9' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 0-9/100');
  assert.equal(await part.text(), '0123456789');

  const dot = path.lastIndexOf('.');
  const tampered = `${path.slice(0, dot + 1)}${path[dot + 1] === 'x' ? 'y' : 'x'}${path.slice(dot + 2)}`;
  assert.equal((await api(tampered, { token: null })).status, 404);

  const links = (await (await api(`/api/v1/transfers/${HASH}/links`)).json()).links;
  assert.equal(links.length, 2, 'both playable files');
  assert.ok(links.every((l: { url: string }) => l.url.includes('/api/v1/download/')));
});

test('permalink is a stable 302 to a fresh signed link, accepts a query token, and respects scope', async t => {
  const { base, api, token, tokens } = await fixture(t);
  await api('/api/v1/transfers', { method: 'POST', body: { infoHash: HASH } });
  const goPath = `/api/v1/transfers/${HASH}/files/0/go`;

  const withHeader = await fetch(`${base}${goPath}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' });
  assert.equal(withHeader.status, 302);
  // Playback links carry APP_URL (a fake host in tests); point the path back at the test server.
  const location = new URL(withHeader.headers.get('location')!);
  assert.match(location.pathname, /^\/api\/v1\/download\/[\w-]+\.[\w-]+$/);
  const played = await fetch(`${base}${location.pathname}`);
  assert.equal(played.status, 200);
  assert.equal(Buffer.from(await played.arrayBuffer()).length, 100);

  // No Authorization header at all — the "dumb client" path.
  const withQuery = await fetch(`${base}${goPath}?token=${token}`, { redirect: 'manual' });
  assert.equal(withQuery.status, 302);
  assert.notEqual(new URL(withQuery.headers.get('location')!).pathname, location.pathname, 'each visit mints a fresh link');

  assert.equal((await fetch(`${base}${goPath}`, { redirect: 'manual' })).status, 401, 'no token at all');
  // The query-token fallback is scoped to /go only — it must not work elsewhere.
  assert.equal((await fetch(`${base}/api/v1/transfers/${HASH}?token=${token}`)).status, 401);

  const noLink = (await tokens.create({ name: 'nolink', scopes: ['read', 'write'] })).token;
  assert.equal((await fetch(`${base}${goPath}`, { headers: { Authorization: `Bearer ${noLink}` }, redirect: 'manual' })).status, 403);

  assert.equal((await fetch(`${base}/api/v1/transfers/${'c'.repeat(40)}/files/0/go`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' })).status, 404);
});

test('zip streams selected-and-complete files, skips an incomplete selection, and reports 409/404 appropriately', async t => {
  const { api, base, token, fileList } = await fixture(t);
  await api('/api/v1/transfers', { method: 'POST', body: { infoHash: HASH } });
  // file 1 ("second.mkv") is selected too, but still at progress 0.
  await api(`/api/v1/transfers/${HASH}/files/1/select`, { method: 'POST' });

  const zipped = await fetch(`${base}/api/v1/transfers/${HASH}/zip`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers.get('content-type'), 'application/zip');
  assert.match(zipped.headers.get('content-disposition')!, /^attachment; filename="Torrent [\w]+\.zip"/);
  const { names, contents } = await inspectZip(t, Buffer.from(await zipped.arrayBuffer()));
  assert.equal(names.length, 1, 'the incomplete selected file is excluded');
  assert.match(names[0]!, /movie\.mkv$/);
  assert.equal(contents[names[0]!], '0123456789'.repeat(10));

  // Nothing is complete anymore: 409, not the writer choking on an empty list.
  fileList[0]!.progress = 0;
  const noneComplete = await fetch(`${base}/api/v1/transfers/${HASH}/zip`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(noneComplete.status, 409);
  assert.equal((await noneComplete.json()).error.code, 'conflict');

  assert.equal((await fetch(`${base}/api/v1/transfers/${'c'.repeat(40)}/zip`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
});

test('delete removes the transfer and is idempotent afterwards', async t => {
  const { api, downloads } = await fixture(t);
  await api('/api/v1/transfers', { method: 'POST', body: { infoHash: HASH } });
  const deleted = await api(`/api/v1/transfers/${HASH}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal(await deleted.text(), '');
  assert.equal(downloads.get(HASH), undefined);
  assert.equal((await api(`/api/v1/transfers/${HASH}`, { method: 'DELETE' })).status, 404);
  assert.equal((await api(`/api/v1/transfers/${HASH}`)).status, 404);
});

test('token scopes gate every route and share the store throttle', async t => {
  const { api, tokens } = await fixture(t);
  await api('/api/v1/transfers', { method: 'POST', body: { infoHash: HASH } });

  const readOnly = (await tokens.create({ name: 'ro', scopes: ['read'] })).token;
  assert.deepEqual((await (await api('/api/v1/capabilities', { token: readOnly })).json()).token.scopes, ['read']);
  assert.equal((await api('/api/v1/transfers', { token: readOnly })).status, 200);
  const forbidden = await api('/api/v1/transfers', { method: 'POST', token: readOnly, body: { infoHash: OTHER } });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, 'forbidden');

  const noLink = (await tokens.create({ name: 'rw', scopes: ['read', 'write'] })).token;
  assert.equal((await api(`/api/v1/transfers/${HASH}/files/0/link`, { method: 'POST', token: noLink })).status, 403);
  assert.equal((await api(`/api/v1/transfers/${HASH}/files/0/select`, { method: 'POST', token: noLink })).status, 200);

  const limited = (await tokens.create({ name: 'lim', quotas: { requestsPerMinute: 1, concurrentRequests: 4 } })).token;
  assert.equal((await api('/api/v1/capabilities', { token: limited })).status, 200);
  const throttled = await api('/api/v1/capabilities', { token: limited });
  assert.equal(throttled.status, 429);
  assert.ok(throttled.headers.get('retry-after'));
  assert.equal((await throttled.json()).error.code, 'rate_limited');
  assert.equal(throttled.headers.get('access-control-allow-origin'), null);
});

test('queue holds a transfer at the active cap and admits it when a slot frees', async t => {
  const { api, settings, state } = await fixture(t);
  await settings.update({ store: { maxActiveDownloads: 1 } });
  state.progress = 0;
  assert.equal((await api('/api/v1/transfers', { method: 'POST', body: { infoHash: HASH } })).status, 201);
  const busy = await api('/api/v1/transfers', { method: 'POST', body: { infoHash: OTHER } });
  assert.equal(busy.status, 429);
  const queued = await api('/api/v1/transfers', { method: 'POST', body: { infoHash: OTHER, queue: true } });
  assert.equal(queued.status, 202);
  assert.equal((await queued.json()).transfer.lifecycle, 'queued');
  const listed = await (await api('/api/v1/transfers')).json();
  assert.equal(listed.items.filter((item: { lifecycle: string }) => item.lifecycle === 'queued').length, 1);
  assert.equal((await api(`/api/v1/transfers/${HASH}`, { method: 'DELETE' })).status, 204);
  const admitted = await (await api(`/api/v1/transfers/${OTHER}`)).json();
  assert.equal(admitted.transfer.lifecycle, 'managed');
});

test('cachedOnly returns an existing playable transfer and does not add a miss', async t => {
  const { api, downloads } = await fixture(t);
  assert.equal((await api('/api/v1/transfers', { method: 'POST', body: { infoHash: HASH } })).status, 201);
  const hit = await api('/api/v1/transfers', { method: 'POST', body: { infoHash: HASH, cachedOnly: true } });
  assert.equal(hit.status, 201);
  assert.equal((await hit.json()).transfer.id, HASH);
  const miss = await api('/api/v1/transfers', { method: 'POST', body: { infoHash: OTHER, cachedOnly: true } });
  assert.equal(miss.status, 404);
  assert.equal((await miss.json()).error.code, 'not_found');
  assert.equal(downloads.get(OTHER), undefined);
});

test('pause stops a managed job and resume continues it', async t => {
  const { api, torrents, settings, state } = await fixture(t);
  assert.equal((await api('/api/v1/transfers', { method: 'POST', body: { infoHash: HASH } })).status, 201);
  state.progress = 0;
  assert.equal((await api(`/api/v1/transfers/${HASH}/resume`, { method: 'POST', body: {} })).status, 204);
  assert.equal(torrents.get(HASH)?.paused, false);
  assert.equal((await api(`/api/v1/transfers/${HASH}/pause`, { method: 'POST', body: {} })).status, 204);
  assert.equal(torrents.get(HASH)?.paused, true);
  assert.equal((await api(`/api/v1/transfers/${HASH}/resume`, { method: 'POST', body: {} })).status, 204);
  assert.equal(torrents.get(HASH)?.paused, false);

  await settings.update({ store: { maxActiveDownloads: 1 } });
  const queued = await api('/api/v1/transfers', { method: 'POST', body: { infoHash: OTHER, queue: true } });
  assert.equal(queued.status, 202);
  const queuedPause = await api(`/api/v1/transfers/${OTHER}/pause`, { method: 'POST', body: {} });
  assert.equal(queuedPause.status, 503);
  assert.equal((await queuedPause.json()).error.code, 'unavailable');
  assert.equal((await api(`/api/v1/transfers/${'c'.repeat(40)}/pause`, { method: 'POST', body: {} })).status, 404);
});

test('preview does not create a transfer and a failed probe leaves no backend job', async t => {
  const { api, downloads, torrents, qbt } = await fixture(t);
  assert.equal((await api('/api/v1/transfers', { method: 'POST', body: { infoHash: HASH } })).status, 201);

  const owned = await api('/api/v1/transfers/preview', { method: 'POST', body: { infoHash: HASH } });
  assert.equal(owned.status, 200);
  const ownedBody = await owned.json();
  assert.equal(ownedBody.preview.id, HASH);
  assert.ok(ownedBody.preview.files.length >= 1);
  assert.equal(ownedBody.preview.seeders, 1);
  assert.ok(torrents.has(HASH));
  assert.ok(downloads.get(HASH));

  const fresh = await api('/api/v1/transfers/preview', { method: 'POST', body: { infoHash: OTHER } });
  assert.equal(fresh.status, 200);
  const preview = await fresh.json();
  assert.equal(preview.preview.id, OTHER);
  assert.equal(preview.preview.name, 'Movie');
  assert.ok(preview.preview.files.some((file: { path: string }) => file.path === 'movie.mkv'));
  assert.equal(downloads.get(OTHER), undefined);
  assert.equal(torrents.has(OTHER), false);
  const listed = await (await api('/api/v1/transfers')).json();
  assert.equal(listed.items.some((item: { id: string }) => item.id === OTHER), false);

  const queuedHash = 'c'.repeat(40);
  await downloads.upsert({
    origin: 'store', infoHash: queuedHash, name: 'Queued', fileIndex: 0, fileName: '', bytes: 42,
    addedAt: Date.now(), expiresAt: Date.now() + 1e6, kept: false, lifecycle: 'queued',
    owner: { backend: 'x', scope: 'debridarr', marker: 'm' }, selectedFiles: [],
  });
  const queued = await (await api('/api/v1/transfers/preview', { method: 'POST', body: { infoHash: queuedHash } })).json();
  assert.equal(queued.preview.name, 'Queued');
  assert.equal(queued.preview.bytes, 42);
  assert.deepEqual(queued.preview.files, []);
  assert.equal(torrents.has(queuedHash), false);

  qbt.onAdd = () => { qbt.failures.add('info'); };
  const failed = await api('/api/v1/transfers/preview', { method: 'POST', body: { magnet: `magnet:?xt=urn:btih:${OTHER}` } });
  qbt.onAdd = undefined;
  qbt.failures.delete('info');
  assert.equal(failed.status, 503);
  assert.equal(downloads.get(OTHER), undefined);
  assert.equal(torrents.has(OTHER), false);
});
