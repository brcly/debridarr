import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { DownloadsStore, type DownloadRecord } from '../src/downloads/store.js';
import { parseInfoHash } from '../src/downloads/torrentFile.js';
import { markActive, markInactive } from '../src/playback/active.js';
import { SettingsStore, writeSettings } from '../src/settings.js';
import { listen, tmpDir } from './helpers.js';
import { parseTrustedProxies, setTrustedProxies } from '../src/security/clientAddress.js';

async function fixture(t: TestContext, writer = writeSettings, withDownloads = true) {
  const dir = await tmpDir(t, 'debridarr-admin');
  const store = await SettingsStore.open(dir, { PROWLARR_URL: 'http://prowlarr.test', PROWLARR_API_KEY: 'saved-secret' }, writer);
  const downloads = await DownloadsStore.open(dir);
  const config = loadConfig({ ADMIN_PASSWORD: 'admin-password', APP_URL: 'http://admin.test', DATA_DIR: dir, DOWNLOAD_DIR: join(dir, 'downloads') });
  const base = await listen(createApp({ config, store, ...(withDownloads ? { downloads } : {}) }), t);
  let cookie = '';
  let csrf = '';
  const request = (path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) => new Promise<Response>((resolve, reject) => {
    const req = httpRequest(`${base}/api/admin/${path}`, {
      method, headers: { Host: 'admin.test', Origin: config.appUrl, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', ...headers },
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        const resultHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach(item => resultHeaders.append(key, item));
          else if (value !== undefined) resultHeaders.set(key, value);
        }
        resolve(new Response(body, { status: response.statusCode!, headers: resultHeaders }));
      });
    });
    req.on('error', reject);
    req.end(data === undefined ? undefined : JSON.stringify(data));
  });
  const login = async () => {
    const response = await request('login', 'POST', { password: 'admin-password' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const value = response.headers.get('set-cookie')!;
    assert.match(value, /HttpOnly; SameSite=Strict/);
    cookie = value.split(';')[0]!;
    csrf = (await response.json()).csrfToken;
  };
  return { store, downloads, base, request, login, config };
}

test('settings require authentication and protect secrets across save, read, and logout', async t => {
  const { request, login, store, base } = await fixture(t);
  assert.equal((await request('settings')).status, 401);
  assert.equal((await request('login', 'POST', { password: 'wrong' })).status, 401);
  await login();
  assert.equal((await request('session')).status, 200);
  const saved = await request('settings', 'PATCH', { discovery: { providers: [{ id: store.snapshot().discovery.providers[0]!.id, type: 'prowlarr', url: 'http://prowlarr.test', preferences: { languages: ['fr'] } }] } });
  assert.equal(saved.status, 200);
  const visible = await saved.text();
  assert.ok(!visible.includes('saved-secret'));
  const stored = store.snapshot().discovery.providers[0]!;
  assert.equal(stored.apiKey, 'saved-secret');
  assert.equal(stored.url, 'http://prowlarr.test');
  assert.deepEqual(stored.preferences, { languages: ['fr'], resolutions: [], codecs: [] });
  const read = await (await request('settings')).json();
  assert.equal(read.settings.discovery.providers[0].hasApiKey, true);
  assert.equal(read.settings.metadata.provider, 'cinemeta');
  assert.deepEqual(read.backends.map((backend: { type: string }) => backend.type), ['qbittorrent', 'transmission', 'deluge', 'sabnzbd']);
  assert.equal(read.backends.find((backend: { type: string }) => backend.type === 'sabnzbd').protocol, 'usenet');
  assert.equal(read.backends[0].protocol, 'torrent');
  assert.equal(read.backends[0].fields.find((field: { key: string }) => field.key === 'password').secret, true);
  assert.deepEqual(read.discoveryProviders.map((provider: { type: string }) => provider.type), ['prowlarr', 'torznab']);
  assert.equal(read.discoveryProviders[0].fields.find((field: { key: string }) => field.key === 'apiKey').secret, true);
  assert.equal(read.discoveryProviders[1].fields.find((field: { key: string }) => field.key === 'apiKey').required, undefined);
  assert.ok(!JSON.stringify(read).includes('admin-password'));
  // The addon base path is keyed, so a bare /stream path stays 404.
  const streams = await fetch(base + '/stream/movie/tt1254207.json');
  assert.equal(streams.status, 404);
  assert.equal((await request('logout', 'POST', {})).status, 200);
  assert.equal((await request('settings')).status, 401);
  const manifest = await fetch(base + '/manifest.json', { headers: { Origin: 'https://web.stremio.com' } });
  assert.equal(manifest.headers.get('access-control-allow-origin'), '*');
  assert.equal(manifest.status, 404);
});

test('origin, host, CSRF, JSON and request-size boundaries are enforced', async t => {
  const { request, login } = await fixture(t);
  assert.equal((await request('login', 'POST', { password: 'admin-password' }, { Origin: '' })).status, 403);
  await login();
  assert.equal((await request('settings', 'PATCH', {}, { Origin: 'https://other.test' })).status, 403);
  assert.equal((await request('settings', 'PATCH', {}, { 'X-CSRF-Token': '' })).status, 403);
  const wrongHost = await request('settings', 'GET', undefined, { Host: 'other.test' });
  assert.equal(wrongHost.status, 403);
  assert.match((await wrongHost.json()).error, /http:\/\/admin\.test\/configure \(this request used other\.test\)/);
  assert.equal((await request('settings', 'PATCH', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request('settings', 'PATCH', { discovery: { providers: [{ type: 'prowlarr', url: 'not-a-url' }] } })).status, 400);
  assert.equal((await request('settings', 'PATCH', { large: 'x'.repeat(33000) })).status, 413);
  assert.equal((await request('settings')).status, 200);
});

test('draft tests use saved credentials, return status without saving, and never leak upstream errors', async t => {
  const { request, login, store } = await fixture(t);
  const base = await listen(createServer((req, res) => {
    assert.equal(req.headers['x-api-key'], 'saved-secret');
    res.end(JSON.stringify({ version: '2.0.0' }));
  }), t);
  await login();
  const provider = store.snapshot().discovery.providers[0]!;
  const response = await request('test/discovery', 'POST', { id: provider.id, type: 'prowlarr', url: base });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(store.snapshot().discovery.providers[0]!.url, 'http://prowlarr.test');
  const cleared = await request('test/discovery', 'POST', { id: provider.id, type: 'prowlarr', url: base, apiKey: null });
  assert.equal((await cleared.json()).code, 'not_configured');
  assert.equal(store.snapshot().discovery.providers[0]!.apiKey, 'saved-secret');
});

test('storage failures return an actionable error and leave active settings unchanged', async t => {
  let fail = false;
  const { request, login, store } = await fixture(t, async (path, settings) => {
    if (fail) throw new Error('private filesystem error');
    await writeSettings(path, settings);
  });
  await login();
  fail = true;
  const provider = store.snapshot().discovery.providers[0]!;
  const response = await request('settings', 'PATCH', { discovery: { providers: [{ id: provider.id, type: 'prowlarr', url: provider.url, apiKey: 'new-secret' }] } });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /Previous settings remain active/);
  assert.equal(store.snapshot().discovery.providers[0]!.apiKey, 'saved-secret');
});

test('the downloads API requires authentication first, and is unavailable without a downloads store', async t => {
  const { request, login } = await fixture(t, writeSettings, false);
  assert.equal((await request('downloads')).status, 401);
  await login();
  assert.equal((await request('downloads')).status, 503);
});

test('downloads can be listed with live qBittorrent status, kept, and deleted through the admin API', async t => {
  const { request, login, downloads, store } = await fixture(t);
  const hash = 'a'.repeat(40);
  let present = true;
  const qbtMock = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/api/v2/auth/login') { res.setHeader('Set-Cookie', 'SID=s; Path=/'); res.end('Ok.'); return; }
      if (url.pathname === '/api/v2/torrents/info') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(present
          ? [{ category: 'debridarr', tags: 'test-owner', hash, name: 'A Movie', state: 'uploading', progress: 1, size: 100, ratio: 2, save_path: '/d', content_path: '/d/x', amount_left: 0, num_seeds: 0, num_leechs: 0, dlspeed: 0, eta: 0, seq_dl: true, f_l_piece_prio: true }]
          : []));
        return;
      }
      if (url.pathname === '/api/v2/torrents/delete') present = false;
      res.end('Ok.');
    })().catch(() => { res.statusCode = 500; res.end('e'); });
  });
  const qbtBase = await listen(qbtMock, t);
  await login();
  assert.equal((await request('settings', 'PATCH', { downloadBackend: { url: qbtBase, username: 'u', password: 'p' } })).status, 200);

  const record: DownloadRecord = {
    owner: { backend: store.snapshot().downloadBackend.id, scope: 'debridarr', marker: 'test-owner' },
    origin: 'search', infoHash: hash, name: 'A Movie', media: { imdbId: 'tt0000001', type: 'movie' },
    fileIndex: 0, fileName: 'movie.mkv', bytes: 100, addedAt: Date.now(), expiresAt: Date.now() + 1000, kept: false,
  };
  await downloads.upsert(record);

  const list = await (await request('downloads')).json();
  assert.equal(list.downloads.length, 1);
  assert.equal(list.downloads[0].infoHash, hash);
  assert.equal(list.downloads[0].ratio, 2, 'merged with live qBittorrent status');
  assert.equal(list.downloads[0].kept, false);

  const kept = await request(`downloads/${hash}`, 'PATCH', { kept: true });
  assert.equal(kept.status, 200);
  assert.equal((await kept.json()).download.kept, true);
  assert.equal(downloads.get(hash)?.kept, true);
  assert.equal((await request(`downloads/${hash}`, 'PATCH', { kept: 'yes' })).status, 400);
  assert.equal((await request(`downloads/${'f'.repeat(40)}`, 'PATCH', { kept: true })).status, 404);

  assert.equal((await request(`downloads/${hash}`, 'DELETE')).status, 200);
  assert.equal(downloads.get(hash), undefined);
  assert.equal((await request(`downloads/${hash}`, 'DELETE')).status, 404, 'already gone');
});

// A qBittorrent that accepts an add (form-encoded magnet or multipart .torrent),
// then reports one downloading torrent with a single video file.
async function storeQbt(t: TestContext, hash: string) {
  const state = { added: false, tag: '', progress: 0, fileSize: 1_500_000_000 };
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url!, 'http://x').pathname;
      if (path === '/api/v2/auth/login') { res.setHeader('Set-Cookie', 'SID=s; Path=/'); res.end('Ok.'); return; }
      if (path === '/api/v2/sync/maindata') { res.end(JSON.stringify({ server_state: { free_space_on_disk: 100e9 } })); return; }
      if (path === '/api/v2/app/version') { res.end('v5.0.0'); return; }
      if (path === '/api/v2/torrents/add') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        state.tag = new URLSearchParams(raw).get('tags') ?? /name="tags"\r\n\r\n([^\r]*)/.exec(raw)?.[1] ?? '';
        state.added = true; res.end('Ok.'); return;
      }
      if (path === '/api/v2/torrents/info') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(state.added
          ? [{ category: 'debridarr', tags: state.tag, hash, name: 'Live Name', state: 'pausedDL', progress: 0, size: 1_500_000_000,
              ratio: 0, save_path: '/d', content_path: '/d/x', amount_left: 1_500_000_000, num_seeds: 1, num_leechs: 0, dlspeed: 1, eta: 1, seq_dl: false, f_l_piece_prio: false }]
          : []));
        return;
      }
      if (path === '/api/v2/torrents/files') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify([{ index: 0, name: 'video/movie.mkv', size: state.fileSize, progress: state.progress, priority: 1 }]));
        return;
      }
      res.end('Ok.');
    })().catch(() => { res.statusCode = 500; res.end('e'); });
  });
  return { base: await listen(server, t), state };
}

test('POST /downloads caches a magnet as an origin:store download, honouring Keep', async t => {
  const { request, login, downloads } = await fixture(t);
  const hash = 'a'.repeat(40);
  const { base, state } = await storeQbt(t, hash);
  await login();
  assert.equal((await request('settings', 'PATCH', { integrations: { mode: 'store' }, downloadBackend: { url: base, username: 'u', password: 'p' } })).status, 200);

  const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent('The.Matrix.1999.1080p.BluRay.x264-GRP')}`;
  const response = await request('downloads', 'POST', { source: magnet, media: { imdbId: 'tt0133093', type: 'movie' }, keep: true });
  assert.equal(response.status, 201);
  const { download } = await response.json();
  assert.equal(download.origin, 'store');
  assert.equal(download.imdbId, 'tt0133093');
  assert.match(download.name, /Matrix/, 'name comes from the magnet display name');

  const record = downloads.get(hash)!;
  assert.equal(record.origin, 'store');
  assert.deepEqual(record.media, { imdbId: 'tt0133093', type: 'movie' });
  assert.equal(record.lifecycle, 'managed');
  assert.equal(record.kept, true, 'Keep was applied');
  assert.ok(state.added, 'the magnet was handed to qBittorrent');
});

test('dashboard permalink is a session-authenticated 302 to a fresh signed download link', async t => {
  const { request, login } = await fixture(t);
  const hash = 'e'.repeat(40);
  const { base: qbtBase } = await storeQbt(t, hash);

  // A plain GET (no X-CSRF-Token needed, matching a bookmarked link or a new
  // browser tab) before signing in.
  assert.equal((await request(`downloads/${hash}/files/0/go`)).status, 401);

  await login();
  assert.equal((await request('settings', 'PATCH', { integrations: { mode: 'store' }, downloadBackend: { url: qbtBase, username: 'u', password: 'p' } })).status, 200);
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=Some.Release`;
  assert.equal((await request('downloads', 'POST', { source: magnet })).status, 201);

  const first = await request(`downloads/${hash}/files/0/go`);
  assert.equal(first.status, 302);
  const location = new URL(first.headers.get('location')!);
  assert.match(location.pathname, /^\/api\/v1\/download\/[\w-]+\.[\w-]+$/);

  const second = await request(`downloads/${hash}/files/0/go`);
  assert.notEqual(new URL(second.headers.get('location')!).pathname, location.pathname, 'each visit mints a fresh link');

  assert.equal((await request(`downloads/${'f'.repeat(40)}/files/0/go`)).status, 404);
});

test('POST /downloads accepts a bare magnet with no media (id-less store item)', async t => {
  const { request, login, downloads } = await fixture(t);
  const hash = 'd'.repeat(40);
  const { base } = await storeQbt(t, hash);
  await login();
  assert.equal((await request('settings', 'PATCH', { integrations: { mode: 'both' }, downloadBackend: { url: base, username: 'u', password: 'p' } })).status, 200);

  const magnet = `magnet:?xt=urn:btih:${hash}&dn=Some.Random.Pack`;
  const response = await request('downloads', 'POST', { source: magnet });
  assert.equal(response.status, 201);
  const { download } = await response.json();
  assert.equal(download.origin, 'store');
  assert.equal(download.imdbId, null);
  assert.equal(download.type, null);
  assert.equal(download.name, 'Some.Random.Pack');
  assert.equal(downloads.get(hash)!.media, undefined);
  assert.equal(downloads.get(hash)!.lifecycle, 'managed');
});

test('POST /downloads accepts a base64 .torrent upload and names it from the file', async t => {
  const { request, login, downloads } = await fixture(t);
  const bstr = (s: string) => Buffer.from(`${Buffer.byteLength(s)}:${s}`, 'latin1');
  const torrent = Buffer.concat([
    Buffer.from('d'), bstr('info'), Buffer.from('d'),
    bstr('length'), Buffer.from('i1500000000e'),
    bstr('name'), bstr('Handmade.Release.2021.1080p'),
    bstr('piece length'), Buffer.from('i16384e'),
    bstr('pieces'), bstr('X'.repeat(20)),
    Buffer.from('ee'),
  ]);
  const hash = parseInfoHash(torrent)!;
  const { base } = await storeQbt(t, hash);
  await login();
  assert.equal((await request('settings', 'PATCH', { integrations: { mode: 'store' }, downloadBackend: { url: base, username: 'u', password: 'p' } })).status, 200);

  const response = await request('downloads', 'POST', { torrent: torrent.toString('base64'), media: { imdbId: 'tt7', type: 'movie' } });
  assert.equal(response.status, 201);
  const { download } = await response.json();
  assert.equal(download.name, 'Handmade.Release.2021.1080p');
  assert.equal(download.imdbId, 'tt7');
  assert.equal(downloads.get(hash)!.origin, 'store');

  assert.equal((await request('downloads', 'POST', { torrent: Buffer.from('not a torrent').toString('base64') })).status, 400);
});

test('POST /downloads rejects search mode, a bad source, and bad media', async t => {
  const { request, login } = await fixture(t);
  await login();
  // Default mode is `search`.
  assert.equal((await request('downloads', 'POST', { source: 'a'.repeat(40), media: { imdbId: 'tt1', type: 'movie' } })).status, 403);

  assert.equal((await request('settings', 'PATCH', { integrations: { mode: 'both' }, downloadBackend: { url: 'http://qbt.invalid', username: 'u', password: 'p' } })).status, 200);
  assert.equal((await request('downloads', 'POST', { source: 'not-a-magnet', media: { imdbId: 'tt1', type: 'movie' } })).status, 400);
  assert.equal((await request('downloads', 'POST', { source: 'b'.repeat(40), media: { imdbId: 'nope', type: 'movie' } })).status, 400);
  assert.equal((await request('downloads', 'POST', { source: 'b'.repeat(40), media: { imdbId: 'tt1', type: 'series' } })).status, 400, 'series needs season + episode');
});

test('POST /downloads is 503 when qBittorrent is not connected', async t => {
  const { request, login } = await fixture(t);
  await login();
  assert.equal((await request('settings', 'PATCH', { integrations: { mode: 'store' } })).status, 200);
  assert.equal((await request('downloads', 'POST', { source: 'c'.repeat(40), media: { imdbId: 'tt1', type: 'movie' } })).status, 503);
});

test('deleting a download that is actively streaming is refused', async t => {
  const { request, login, downloads } = await fixture(t);
  await login();
  const hash = 'b'.repeat(40);
  await downloads.upsert({
    origin: 'search', infoHash: hash, name: 'A Movie', media: { imdbId: 'tt0000001', type: 'movie' },
    fileIndex: 0, fileName: 'movie.mkv', bytes: 100, addedAt: Date.now(), expiresAt: Date.now() + 1000, kept: false,
  });
  markActive(hash);
  t.after(() => markInactive(hash));
  const response = await request(`downloads/${hash}`, 'DELETE');
  assert.equal(response.status, 409);
  assert.ok(downloads.get(hash), 'not removed');
});

test('addon installation links require a session and rotation requires CSRF', async t => {
  const { request, login, base } = await fixture(t);
  assert.equal((await request('addon')).status, 401);
  await login();
  const first = (await (await request('addon')).json()).manifestUrl as string;
  assert.match(first, /^http:\/\/admin\.test\/addon\/[\w-]{43}\/manifest\.json$/);
  assert.equal((await request('addon', 'POST', {}, { 'X-CSRF-Token': '' })).status, 403);
  const next = (await (await request('addon', 'POST', {})).json()).manifestUrl as string;
  assert.notEqual(first, next);
  assert.equal((await fetch(base + new URL(first).pathname)).status, 404);
  assert.equal((await fetch(base + new URL(next).pathname)).status, 200);
});

test('admin token creation and revocation require a session and CSRF; lists never expose secrets', async t => {
  const { request, login } = await fixture(t);
  assert.equal((await request('store/tokens')).status, 401);
  await login();
  assert.equal((await request('store/tokens', 'POST', { name: 'Client' }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await request('store/tokens', 'POST', { name: '' })).status, 400);
  const created = await request('store/tokens', 'POST', { name: 'Client', quotas: { requestsPerMinute: 30, concurrentRequests: 2 } });
  assert.equal(created.status, 201);
  const { token, item } = await created.json();
  assert.match(token, /^[\w-]{43}$/);
  assert.deepEqual(item.scopes, ['read', 'write', 'link'], 'a token grants full access by default');
  const scoped = await request('store/tokens', 'POST', { name: 'Reader', scopes: ['read', 'link'] });
  assert.deepEqual((await scoped.json()).item.scopes, ['read', 'link']);
  assert.equal((await request('store/tokens', 'POST', { name: 'Bad', scopes: ['admin'] })).status, 400);
  const listed = await (await request('store/tokens')).text();
  assert.ok(!listed.includes(token));
  assert.ok(!listed.includes('digest'));
  assert.equal(JSON.parse(listed).tokens.find((t: { name: string }) => t.name === 'Client').quotas.requestsPerMinute, 30);
  assert.deepEqual(JSON.parse(listed).tokens.find((t: { name: string }) => t.name === 'Reader').scopes, ['read', 'link']);
  assert.equal((await request(`store/tokens/${item.id}`, 'DELETE')).status, 200);
  assert.equal((await (await request('store/tokens')).json()).tokens.length, 1);
});


test('diagnostics distinguish an empty mount, unreadable files and verified playback without mutations', async t => {
  const { request, login, config, downloads } = await fixture(t);
  const hash = 'e'.repeat(40);
  const { base, state } = await storeQbt(t, hash);
  assert.equal((await request('diagnostics')).status, 401);
  await login();
  await request('settings', 'PATCH', { integrations: { mode: 'store' }, downloadBackend: { url: base, username: 'u', password: 'p' } });
  await mkdir(join(config.downloadDir, 'video'), { recursive: true });
  const empty = await (await request('diagnostics')).json();
  assert.equal(empty.playbackReady, false);
  assert.equal(empty.checks.find((c: { id: string }) => c.id === 'file').status, 'warning');
  assert.equal(empty.storage.freeBytes, 100e9);
  assert.equal((await request('downloads', 'POST', { source: hash })).status, 201);
  const before = downloads.get(hash);
  state.progress = 1; state.fileSize = 3;
  const missing = await (await request('diagnostics')).json();
  assert.equal(missing.playbackReady, false);
  assert.equal(missing.checks.find((c: { id: string }) => c.id === 'file').status, 'fail');
  await writeFile(join(config.downloadDir, 'video/movie.mkv'), 'abc');
  assert.equal((await (await request('diagnostics')).json()).playbackReady, true);
  assert.deepEqual(downloads.get(hash), before, 'checks must not renew or change selections');
  await writeFile(join(config.downloadDir, 'video/movie.mkv'), 'wrong size');
  assert.equal((await (await request('diagnostics')).json()).playbackReady, false);
});

test('metrics requires authentication and reports counters, admission and playback state', async t => {
  const { request, login, downloads } = await fixture(t);
  assert.equal((await request('metrics')).status, 401);
  await login();
  const hash = 'f'.repeat(40);
  markActive(hash);
  try {
    const metrics = await (await request('metrics')).json();
    assert.equal(typeof metrics.uptimeSeconds, 'number');
    assert.ok(metrics.uptimeSeconds >= 0);
    assert.equal(typeof metrics.requests.total, 'number');
    assert.ok(metrics.requests.total >= 1, 'earlier requests in this test are already counted');
    assert.equal(metrics.playback.active, 1);
    assert.deepEqual(metrics.admission.searches, { active: 0, max: 4 });
    assert.deepEqual(metrics.admission.streams, { active: 0, max: 16 });
    assert.equal(typeof metrics.downloads, 'object');
  } finally { markInactive(hash); }

  await downloads.upsert({ infoHash: 'a'.repeat(40), name: 'x', origin: 'search', media: { imdbId: 'tt1', type: 'movie' },
    fileIndex: 0, fileName: 'x.mkv', bytes: 1, addedAt: Date.now(), expiresAt: Date.now() + 1000, kept: false, lifecycle: 'managed' });
  const after = await (await request('metrics')).json();
  assert.equal(after.downloads.managed, 1);
});

test('a discovery provider can be tested against a draft address, reusing its saved key', async t => {
  const { request, login, store } = await fixture(t);
  await login();
  let sawKey = '';
  const indexer = await listen(createServer((req, res) => {
    sawKey = new URL(req.url!, 'http://x').searchParams.get('apikey') ?? '';
    res.setHeader('Content-Type', 'application/xml');
    res.end('<caps><server version="1.1" title="Indexer"/></caps>');
  }), t);
  await request('settings', 'PATCH', { discovery: { providers: [{ type: 'torznab', url: indexer, apiKey: 'indexer-key' }] } });
  const saved = store.snapshot().discovery.providers[0]!;
  // No apiKey in the body: the saved key for that provider id is reused.
  const tested = await request('test/discovery', 'POST', { id: saved.id, type: 'torznab', url: indexer });
  assert.equal(tested.status, 200);
  const result = await tested.json();
  assert.equal(result.ok, true);
  assert.equal(result.code, 'connected');
  assert.equal(result.version, '1.1');
  assert.equal(sawKey, 'indexer-key');
  const withoutKey = await request('test/discovery', 'POST', { id: saved.id, type: 'torznab', url: indexer, apiKey: null });
  assert.equal(withoutKey.status, 200);
  assert.equal(sawKey, '');
  assert.equal(store.snapshot().discovery.providers[0]!.apiKey, 'indexer-key', 'testing must not save the cleared key');
  // A bad address is reported, not thrown.
  const failed = await request('test/discovery', 'POST', { id: saved.id, type: 'torznab', url: 'http://127.0.0.1:1/torznab' });
  assert.equal((await failed.json()).code, 'unreachable');
});

test('RSS saved search admin routes: status, poll now, ignore, and Search-only mode gating', async t => {
  const { request, login } = await fixture(t);
  await login();
  assert.deepEqual(await (await request('rss/status')).json(), { status: {} });

  await request('settings', 'PATCH', { integrations: { mode: 'store' } });
  const saved = await (await request('settings', 'PATCH', {
    rss: { searches: [{ feedUrl: 'http://127.0.0.1:1/rss', protocol: 'torrent' }] },
  })).json();
  const searchId = saved.settings.rss.searches[0].id;

  // An unreachable feed is a recorded poll-level error, not a request failure.
  assert.equal((await request(`rss/${searchId}/poll`, 'POST')).status, 200);
  const afterPoll = await (await request('rss/status')).json();
  assert.ok(afterPoll.status[searchId].lastPolledAt);
  assert.ok(afterPoll.status[searchId].lastError);
  assert.equal((await request('rss/unknown-id/poll', 'POST')).status, 404);

  assert.equal((await request(`rss/${searchId}/ignore`, 'POST', {})).status, 400, 'guid is required');
  assert.equal((await request(`rss/${searchId}/ignore`, 'POST', { guid: 'g1' })).status, 200);
  const afterIgnore = await (await request('rss/status')).json();
  const ignored = afterIgnore.status[searchId].items.find((item: { guid: string }) => item.guid === 'g1');
  assert.equal(ignored.status, 'ignored');
  assert.equal(ignored.title, '', 'an item ignored before it was ever seen has no known title');

  // Search-only mode blocks both actions, matching the "Cache a torrent" gate.
  await request('settings', 'PATCH', { integrations: { mode: 'search' } });
  assert.equal((await request(`rss/${searchId}/poll`, 'POST')).status, 403);
  assert.equal((await request(`rss/${searchId}/ignore`, 'POST', { guid: 'g2' })).status, 403);
});

// Regression guard for the reverse-proxy deployment the docs recommend: with
// TRUSTED_PROXIES set, one client exhausting the login limit must not lock out
// everybody else sharing the proxy's socket address.
test('login throttling isolates clients by forwarded address behind a trusted proxy', async t => {
  const dir = await tmpDir(t, 'debridarr-proxy');
  const store = await SettingsStore.open(dir, {}, writeSettings);
  const config = loadConfig({
    ADMIN_PASSWORD: 'admin-password', APP_URL: 'http://admin.test',
    DATA_DIR: dir, DOWNLOAD_DIR: join(dir, 'downloads'), TRUSTED_PROXIES: 'loopback',
  });
  setTrustedProxies(config.trustedProxies);
  t.after(() => setTrustedProxies(parseTrustedProxies(undefined)));

  const base = await listen(createApp({ config, store }), t);
  const attempt = (password: string, forwardedFor: string) => new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${base}/api/admin/login`, {
      method: 'POST',
      headers: {
        Host: 'admin.test', Origin: config.appUrl, 'Content-Type': 'application/json',
        'X-Forwarded-For': forwardedFor,
      },
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode!));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ password }));
  });

  // Exhaust the five-attempt budget for one client.
  for (let i = 0; i < 5; i += 1) assert.equal(await attempt('wrong', '203.0.113.9'), 401);
  assert.equal(await attempt('wrong', '203.0.113.9'), 429, 'the offending client is throttled');
  assert.equal(await attempt('admin-password', '203.0.113.9'), 429, 'and stays throttled even with the right password');

  // A different client behind the same proxy is unaffected.
  assert.equal(await attempt('admin-password', '198.51.100.4'), 200);
});
