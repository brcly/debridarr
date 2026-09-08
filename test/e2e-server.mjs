import { sourceIdentity } from '../dist/security/addon.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';
import { SettingsStore } from '../dist/settings.js';
import { DownloadsStore } from '../dist/downloads/store.js';

const dir = await mkdtemp(join(tmpdir(), 'debridarr-browser-'));
const config = loadConfig({ ADMIN_PASSWORD: 'browser-test-password', PORT: '17070', APP_URL: 'http://127.0.0.1:17070', DATA_DIR: dir });
const store = await SettingsStore.open(dir, {});
const downloads = await DownloadsStore.open(dir);
const SEEDED_HASH = 'b'.repeat(40);
await downloads.upsert({
  owner: { client: sourceIdentity({ url: 'http://127.0.0.1:17071/qbt' }), category: 'debridarr', tag: 'test-owner' }, lifecycle: 'managed',
  infoHash: SEEDED_HASH, name: 'Test Movie (2020)', imdbId: 'tt1234567', type: 'movie',
  fileIndex: 0, fileName: 'Test.Movie.2020/movie.mkv', bytes: 1_500_000_000,
  addedAt: Date.now(), expiresAt: Date.now() + 15 * 86_400_000, kept: false,
});

let present = true;
let failDeletion = true;
const mock = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/prowlarr/api/v1/system/status' && req.headers['x-api-key'] === 'browser-test-key') {
    res.end(JSON.stringify({ version: '2.0.0' }));
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
  } else if (url.pathname === '/qbt/api/v2/torrents/info') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(present ? [{ category: 'debridarr', tags: 'test-owner',
      hash: SEEDED_HASH, name: 'Test Movie (2020)', state: 'uploading', progress: 1, size: 1_500_000_000, ratio: 1.5,
      save_path: '/downloads', content_path: '/downloads/x', amount_left: 0, num_seeds: 0, num_leechs: 0,
      dlspeed: 0, eta: 0, seq_dl: true, f_l_piece_prio: true,
    }] : []));
  } else if (url.pathname === '/qbt/api/v2/torrents/delete') {
    if (failDeletion) { failDeletion = false; res.statusCode = 500; res.end('fixture failure'); return; }
    present = false;
    res.end('Ok.');
  } else {
    res.statusCode = 401; res.end('Unauthorized');
  }
});
const server = createApp({ config, store, downloads });
mock.listen(17071, '127.0.0.1');
server.listen(config.port, '127.0.0.1');
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await Promise.all([server, mock].map(app => new Promise(resolve => {
    app.closeAllConnections(); app.close(resolve);
  })));
  await rm(dir, { recursive: true, force: true });
});
