import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';
import { SettingsStore } from '../dist/settings.js';
import { DownloadsStore } from '../dist/downloads/store.js';

const dir = await mkdtemp(join(tmpdir(), 'debridarr-browser-'));
const downloadDir = join(dir, 'downloads');
await mkdir(downloadDir);
await writeFile(join(downloadDir, 'movie.mkv'), 'EXAMPLE');
await writeFile(join(downloadDir, 'episode.mkv'), 'EPISODE_TWO');
const config = loadConfig({ ADMIN_PASSWORD: 'browser-test-password', PORT: '17070', APP_URL: 'http://127.0.0.1:17070', DATA_DIR: dir, DOWNLOAD_DIR: downloadDir });
const store = await SettingsStore.open(dir, {});
await store.update({ setup: { completed: true } });
const downloads = await DownloadsStore.open(dir);
const SEEDED_HASH = 'b'.repeat(40);
await downloads.upsert({
  owner: { backend: store.snapshot().downloadBackend.id, scope: 'debridarr', marker: 'test-owner' }, lifecycle: 'managed',
  origin: 'search', infoHash: SEEDED_HASH, name: 'Test Movie (2020)', media: { imdbId: 'tt1234567', type: 'movie' },
  fileIndex: 0, fileName: 'movie.mkv', bytes: 7,
  addedAt: Date.now(), expiresAt: Date.now() + 15 * 86_400_000, kept: false,
});

const torrents = new Map([[SEEDED_HASH, { tag: 'test-owner', paused: false, progress: 1 }]]);
const fileList = [{ index: 0, name: 'movie.mkv', size: 7, progress: 1, priority: 1 }, { index: 1, name: 'episode.mkv', size: 11, progress: 1, priority: 1 }];
let failDeletion = true;
const mock = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/prowlarr/api/v1/system/status' && req.headers['x-api-key'] === 'browser-test-key') {
    res.end(JSON.stringify({ version: '2.0.0' }));
  } else if (url.pathname === '/torznab/api' && url.searchParams.get('t') === 'caps' && url.searchParams.get('apikey') === 'browser-torznab-key') {
    res.setHeader('Content-Type', 'application/xml');
    res.end('<?xml version="1.0"?><caps><server version="1.1" title="Browser indexer"/></caps>');
  } else if (url.pathname === '/qbt/api/v2/auth/login') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      if (form.get('username') === 'admin' && form.get('password') === 'browser-qbt-password') {
        res.setHeader('Set-Cookie', 'SID=browserSession; Path=/'); res.end('Ok.');
      } else res.end('Fails.');
    });
  } else if (req.headers.cookie !== 'SID=browserSession') {
    res.statusCode = 401; res.end('Unauthorized');
  } else if (url.pathname === '/qbt/api/v2/app/version') {
    res.end('v5.0.4');
  } else if (url.pathname === '/qbt/api/v2/sync/maindata') {
    res.end(JSON.stringify({ server_state: { free_space_on_disk: 100e9 } }));
  } else if (url.pathname === '/qbt/api/v2/torrents/files') {
    res.end(JSON.stringify(fileList));
  } else if (url.pathname === '/qbt/api/v2/torrents/add' || url.pathname === '/qbt/api/v2/torrents/filePrio') {
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const form = new URLSearchParams(raw);
      if (url.pathname.endsWith('/add')) {
        torrents.set(new URL(form.get('urls')).searchParams.get('xt').slice(-40), {
          tag: form.get('tags'),
          paused: form.get('paused') === 'true' || form.get('stopped') === 'true',
          progress: 0,
        });
      } else for (const file of fileList) if ((form.get('id') ?? '').split('|').includes(String(file.index))) file.priority = Number(form.get('priority'));
      res.end('Ok.');
    });
  } else if (url.pathname === '/qbt/api/v2/torrents/pause' || url.pathname === '/qbt/api/v2/torrents/stop') {
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const row = torrents.get(new URLSearchParams(raw).get('hashes'));
      if (row) row.paused = true;
      res.end('Ok.');
    });
  } else if (url.pathname === '/qbt/api/v2/torrents/resume' || url.pathname === '/qbt/api/v2/torrents/start') {
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const row = torrents.get(new URLSearchParams(raw).get('hashes'));
      if (row) row.paused = false;
      res.end('Ok.');
    });
  } else if (url.pathname === '/qbt/api/v2/torrents/setShareLimits') { res.end('Ok.');
  } else if (url.pathname === '/qbt/api/v2/torrents/info') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([...torrents].filter(([hash]) => !url.searchParams.has('hashes') || hash === url.searchParams.get('hashes')).map(([hash, row]) => ({
      category: 'debridarr', tags: row.tag, hash, name: 'Test Movie (2020)',
      state: row.paused ? (row.progress >= 1 ? 'pausedUP' : 'pausedDL') : (row.progress >= 1 ? 'uploading' : 'downloading'),
      progress: row.progress, size: 18, ratio: row.progress >= 1 ? 1.5 : 0,
      save_path: downloadDir, content_path: downloadDir, amount_left: 0, num_seeds: 0, num_leechs: 0,
      dlspeed: 0, eta: 0, seq_dl: true, f_l_piece_prio: true,
    }))));
  } else if (url.pathname === '/qbt/api/v2/torrents/delete') {
    if (failDeletion) { failDeletion = false; res.statusCode = 500; res.end('fixture failure'); return; }
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', () => { torrents.delete(new URLSearchParams(raw).get('hashes')); res.end('Ok.'); });
  } else {
    res.statusCode = 401; res.end('Unauthorized');
  }
});
const server = createApp({ config, store, downloads });
mock.listen(17071, '127.0.0.1');
server.listen(config.port, '127.0.0.1');
const setupServers = [];
const setupDirs = [];
for (const port of [17072, 17073]) {
  const setupDir = await mkdtemp(join(tmpdir(), 'debridarr-setup-browser-'));
  setupDirs.push(setupDir);
  const setupConfig = loadConfig({ ADMIN_PASSWORD: 'browser-test-password', PORT: String(port), APP_URL: `http://127.0.0.1:${port}`, DATA_DIR: setupDir, DOWNLOAD_DIR: downloadDir });
  const app = createApp({ config: setupConfig, store: await SettingsStore.open(setupDir, {}), downloads: await DownloadsStore.open(setupDir) });
  setupServers.push(app);
  app.listen(port, '127.0.0.1');
}
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await Promise.all([server, mock, ...setupServers].map(app => new Promise(resolve => {
    app.closeAllConnections(); app.close(resolve);
  })));
  await Promise.all([dir, ...setupDirs].map(path => rm(path, { recursive: true, force: true })));
});
