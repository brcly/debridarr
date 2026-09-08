import { sourceIdentity } from '../src/security/addon.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { DownloadsStore, type DownloadRecord } from '../src/downloads/store.js';
import { markActive, markInactive } from '../src/playback/active.js';
import { SettingsStore, writeSettings } from '../src/settings.js';
import { listen } from './helpers.js';

async function fixture(t: TestContext, writer = writeSettings, withDownloads = true) {
  const dir = await mkdtemp(join(tmpdir(), 'debridarr-admin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await SettingsStore.open(dir, { PROWLARR_API_KEY: 'saved-secret' }, writer);
  const downloads = await DownloadsStore.open(dir);
  const config = loadConfig({ ADMIN_PASSWORD: 'admin-password', APP_URL: 'http://admin.test', DATA_DIR: dir });
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
  return { store, downloads, base, request, login };
}

test('settings require authentication and protect secrets across save, read, and logout', async t => {
  const { request, login, store, base } = await fixture(t);
  assert.equal((await request('settings')).status, 401);
  assert.equal((await request('login', 'POST', { password: 'wrong' })).status, 401);
  await login();
  assert.equal((await request('session')).status, 200);
  const saved = await request('settings', 'PATCH', { prowlarr: { url: 'http://prowlarr.test' } });
  assert.equal(saved.status, 200);
  const visible = await saved.text();
  assert.ok(!visible.includes('saved-secret'));
  assert.equal(store.snapshot().prowlarr.apiKey, 'saved-secret');
  assert.equal(store.snapshot().prowlarr.url, 'http://prowlarr.test');
  const read = await (await request('settings')).json();
  assert.equal(read.settings.prowlarr.hasApiKey, true);
  assert.equal(read.settings.metadata.provider, 'cinemeta');
  assert.ok(!JSON.stringify(read).includes('admin-password'));
  // Prowlarr has no URL, so stream search stays inert and never leaves the box.
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
  assert.equal((await request('settings', 'GET', undefined, { Host: 'other.test' })).status, 403);
  assert.equal((await request('settings', 'PATCH', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request('settings', 'PATCH', { prowlarr: { url: 'not-a-url' } })).status, 400);
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
  const response = await request('test/prowlarr', 'POST', { url: base });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(store.snapshot().prowlarr.url, '');
  const cleared = await request('test/prowlarr', 'POST', { url: base, apiKey: null });
  assert.equal((await cleared.json()).code, 'not_configured');
  assert.equal(store.snapshot().prowlarr.apiKey, 'saved-secret');
});

test('storage failures return an actionable error and leave active settings unchanged', async t => {
  let fail = false;
  const { request, login, store } = await fixture(t, async (path, settings) => {
    if (fail) throw new Error('private filesystem error');
    await writeSettings(path, settings);
  });
  await login();
  fail = true;
  const response = await request('settings', 'PATCH', { prowlarr: { apiKey: 'new-secret' } });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /Previous settings remain active/);
  assert.equal(store.snapshot().prowlarr.apiKey, 'saved-secret');
});

test('the downloads API requires authentication first, and is unavailable without a downloads store', async t => {
  const { request, login } = await fixture(t, writeSettings, false);
  assert.equal((await request('downloads')).status, 401);
  await login();
  assert.equal((await request('downloads')).status, 503);
});

test('downloads can be listed with live qBittorrent status, kept, and deleted through the admin API', async t => {
  const { request, login, downloads } = await fixture(t);
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
  assert.equal((await request('settings', 'PATCH', { qbittorrent: { url: qbtBase, username: 'u', password: 'p' } })).status, 200);

  const record: DownloadRecord = {
    owner: { client: sourceIdentity({ url: qbtBase }), category: 'debridarr', tag: 'test-owner' },
    infoHash: hash, name: 'A Movie', imdbId: 'tt0000001', type: 'movie',
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

test('deleting a download that is actively streaming is refused', async t => {
  const { request, login, downloads } = await fixture(t);
  await login();
  const hash = 'b'.repeat(40);
  await downloads.upsert({
    infoHash: hash, name: 'A Movie', imdbId: 'tt0000001', type: 'movie',
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
