import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddonAccess } from '../src/security/addon.js';
import { SettingsStore } from '../src/settings.js';
import { loadConfig } from '../src/config.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { createApp } from '../src/server.js';
import { DownloadsStore } from '../src/downloads/store.js';
import { listen, tmpDir } from './helpers.js';

const dir = await mkdtemp(join(tmpdir(), 'debridarr-server-'));
const access = await AddonAccess.open(dir);
const server = createApp({ config: loadConfig({ ADMIN_PASSWORD: 'test-password', DATA_DIR: dir }), store: await SettingsStore.open(dir, {}), access });
let base: string;

before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
});

test('health works without external services', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(response.headers.get('content-security-policy'), null);
  const ready = await fetch(`${base}/health/ready`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), { status: 'not_ready', checks: {} });
});

test('health/ready reports which component is unhealthy', async t => {
  const dir2 = await tmpDir(t, 'debridarr-ready');
  const settings = await SettingsStore.open(dir2, {
    DEBRIDARR_MODE: 'store', QBITTORRENT_URL: 'http://127.0.0.1:1', QBITTORRENT_USERNAME: 'u', QBITTORRENT_PASSWORD: 'p',
  });
  const downloads = await DownloadsStore.open(dir2);
  const access2 = await AddonAccess.open(dir2);
  const config = loadConfig({ DATA_DIR: dir2, DOWNLOAD_DIR: join(dir2, 'missing-downloads'), ADMIN_PASSWORD: 'test-password' });
  const base2 = await listen(createApp({ config, store: settings, downloads, access: access2 }), t);
  const ready = await fetch(`${base2}/health/ready`);
  assert.equal(ready.status, 503);
  const body = await ready.json();
  assert.equal(body.status, 'not_ready');
  assert.deepEqual(body.checks, { store: 'ok', downloads: 'ok', backend: 'error', downloadDir: 'error' });
});

test('manifest advertises only supported IMDb stream resources', async () => {
  const response = await fetch(`${access.base(base)}/manifest.json`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /application\/json/);
  assert.equal(response.headers.get('content-security-policy'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const manifest = await response.json();
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.id, 'org.debridarr.addon');
  assert.equal(manifest.name, 'Debridarr');
  assert.equal(manifest.version, pkg.version);
  assert.equal(typeof manifest.description, 'string');
  assert.deepEqual(manifest.types, ['movie', 'series']);
  assert.deepEqual(manifest.catalogs, []);
  assert.deepEqual(manifest.resources, [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] }]);
});

test('movie, episode, encoded episode, and special requests return empty streams', async () => {
  for (const path of ['movie/tt1254207', 'series/tt0944947:1:1', 'series/tt0944947%3A1%3A1', 'series/tt0944947:0:1']) {
    const response = await fetch(`${access.base(base)}/stream/${path}.json`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), { streams: [] });
  }
});

test('legacy and forged playback links are rejected', async () => {
  const forged = Buffer.from(JSON.stringify({ v: 1, t: 'x', i: 'tt1', k: 'm', d: 'http://127.0.0.1/secret' })).toString('base64url');
  for (const path of ['/manifest.json', '/stream/movie/tt1.json', `/play/${forged}`, `/addon/${'a'.repeat(43)}/play/${forged}`]) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  assert.equal((await fetch(`${access.base(base)}/play/${forged}`)).status, 404);
});

test('unknown routes, unsupported types, and invalid IDs consistently return 404', async () => {
  const dbId = `db:${'a'.repeat(40)}`;
  for (const path of ['/missing', '/catalog/movie/top.json', '/stream/channel/tt123.json', '/stream/movie/other.json', '/stream/series/tt123.json', '/stream/movie/tt123:1:1.json',
    // store-mode routes stay 404 in the default search mode
    '/catalog/other/debridarr-library.json', `/meta/other/${dbId}.json`, `/stream/other/${dbId}.json`]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const errorBody = await response.json();
    assert.equal(errorBody.error, 'Not found');
    assert.equal(errorBody.requestId, response.headers.get('x-request-id'));
  }
});

test('malformed URL encoding returns 400 and leaves server usable', async () => {
  const response = await fetch(`${access.base(base)}/stream/movie/%ZZ.json`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid URL encoding' });
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('preflight and HEAD requests work; writes are rejected', async () => {
  const preflight = await fetch(`${access.base(base)}/manifest.json`, {
    method: 'OPTIONS', headers: { Origin: 'https://web.stremio.com', 'Access-Control-Request-Method': 'GET' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS');
  assert.equal(await preflight.text(), '');
  const head = await fetch(`${access.base(base)}/manifest.json`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await fetch(`${access.base(base)}/manifest.json`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD, OPTIONS');
  assert.deepEqual(await post.json(), { error: 'Method not allowed' });
});
