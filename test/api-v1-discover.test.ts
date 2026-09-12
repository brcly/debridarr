import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { SettingsStore } from '../src/settings.js';
import { DownloadsStore } from '../src/downloads/store.js';
import { StoreAccess } from '../src/store/access.js';
import { listen, tmpDir } from './helpers.js';

// The happy path (two live sources aggregated through the endpoint) lives at
// the unit level in search-aggregation.test.ts: metadata providers have no
// injectable base URL, so a full end-to-end search here would need real
// Cinemeta or TMDB network access.
async function fixture(t: TestContext) {
  const dir = await tmpDir(t, 'debridarr-discover');
  const downloadDir = join(dir, 'downloads');
  await mkdir(downloadDir, { recursive: true });
  const settings = await SettingsStore.open(dir, { DEBRIDARR_MODE: 'both' });
  const downloads = await DownloadsStore.open(dir);
  const tokens = await StoreAccess.open(dir);
  const { token } = await tokens.create({ name: 'full' });
  const config = loadConfig({ DATA_DIR: dir, DOWNLOAD_DIR: downloadDir, APP_URL: 'https://public.example', ADMIN_PASSWORD: 'test-password' });
  const base = await listen(createApp({ config, store: settings, downloads, storeAccess: tokens }), t);
  const api = (path: string, opts: { method?: string; token?: string | null } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? token}`;
    return fetch(`${base}${path}`, { method: opts.method ?? 'GET', headers });
  };
  return { api, settings };
}

test('discover validates its query parameters and tolerates a well-formed request', async t => {
  const { api } = await fixture(t);
  for (const path of [
    '/api/v1/discover',
    '/api/v1/discover?type=movie',
    '/api/v1/discover?type=movie&imdbId=matrix',
    '/api/v1/discover?type=series&imdbId=tt1',
    '/api/v1/discover?type=series&imdbId=tt1&season=1',
    '/api/v1/discover?type=movie&imdbId=tt1&season=1',
    '/api/v1/discover?type=movie&imdbId=tt1&limit=0',
  ]) {
    const response = await api(path);
    assert.equal(response.status, 400, path);
    assert.equal((await response.json()).error.code, 'invalid_request', path);
  }
  const allowed = await api('/api/v1/discover?type=movie&imdbId=tt1254207&limit=5');
  assert.equal(allowed.status, 200);
});

test('discover returns empty releases when no discovery source is configured', async t => {
  const { api } = await fixture(t);
  const response = await api('/api/v1/discover?type=movie&imdbId=tt1254207');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { releases: [] });
});

test('discover requires a bearer token and only answers GET', async t => {
  const { api } = await fixture(t);
  assert.equal((await api('/api/v1/discover?type=movie&imdbId=tt1', { token: null })).status, 401);
  assert.equal((await api('/api/v1/discover?type=movie&imdbId=tt1', { method: 'POST' })).status, 405);
});

test('discover surfaces upstream metadata failures as bad gateway', async t => {
  const { api, settings } = await fixture(t);
  await settings.update({
    metadata: { provider: 'tmdb', tmdbApiKey: null },
    discovery: { providers: [{ type: 'torznab', url: 'http://indexer:9117/torznab/api', apiKey: '' }] },
  });
  const response = await api('/api/v1/discover?type=movie&imdbId=tt1254207');
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'bad_gateway');
});

test('discover is documented in the OpenAPI surface and 404s in search mode', async t => {
  const { api, settings } = await fixture(t);
  const doc = await (await api('/api/v1/openapi.json', { token: null })).json();
  assert.ok(doc.paths['/discover']?.get);
  await settings.update({ integrations: { mode: 'search' } });
  assert.equal((await api('/api/v1/discover?type=movie&imdbId=tt1')).status, 404);
});
