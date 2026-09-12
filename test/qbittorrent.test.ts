import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { test, type TestContext } from 'node:test';
import { QBittorrentClient } from '../src/integrations/qbittorrent/client.js';
import type { TorrentBackend } from '../src/backends/torrent.js';
import { listen } from './helpers.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return new URLSearchParams(body);
}

interface MockOptions { failNextAuthed?: boolean }

function mockQbt(t: TestContext, options: MockOptions = {}) {
  const calls: { path: string; form?: Record<string, string> }[] = [];
  let logins = 0;
  let poisoned = options.failNextAuthed ?? false;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://x');
      const path = url.pathname;
      if (path === '/api/v2/auth/login') {
        logins += 1;
        response.setHeader('Set-Cookie', `SID=session${logins}; Path=/`);
        response.end('Ok.');
        return;
      }
      if (!/^SID=session\d+$/.test(request.headers.cookie ?? '')) { response.statusCode = 403; response.end('Forbidden'); return; }
      if (poisoned) { poisoned = false; response.statusCode = 403; response.end('expired'); return; }
      const form = request.method === 'POST' ? Object.fromEntries(await readForm(request)) : undefined;
      calls.push({ path, ...(form ? { form } : {}) });
      if (path === '/api/v2/torrents/info') {
        const hashes = url.searchParams.get('hashes');
        const category = url.searchParams.get('category');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(hashes === HASH || category === 'debridarr'
          ? [{ hash: HASH.toUpperCase(), name: 'The Matrix 1999 1080p', state: 'downloading', progress: 0.5, size: 100, ratio: 0.2, save_path: '/downloads', content_path: '/downloads/x', amount_left: 50, num_seeds: 9, num_leechs: 2, dlspeed: 1000, eta: 60, seq_dl: false, f_l_piece_prio: false }]
          : []));
        return;
      }
      if (path === '/api/v2/torrents/files') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify([
          { index: 0, name: 'The.Matrix.1999/movie.mkv', size: 90, progress: 1, priority: 1 },
          { index: 1, name: 'The.Matrix.1999/extras.mkv', size: 10, progress: 0, priority: 1 },
        ]));
        return;
      }
      if (path === '/api/v2/app/version') { response.end('v5.0.4'); return; }
      response.end('Ok.');
    })().catch(() => { response.statusCode = 500; response.end('err'); });
  });
  return listen(server, t).then(base => ({ base, calls, logins: () => logins }));
}

test('one login is reused across calls; add/files/priorities/shareLimits/delete hit the right endpoints', async t => {
  const { base, calls, logins } = await mockQbt(t);
  const qbt: TorrentBackend = new QBittorrentClient({ url: base, username: 'admin', password: 'pw' });
  const signal = AbortSignal.timeout(3000);

  assert.equal((await qbt.get(HASH, signal))?.name, 'The Matrix 1999 1080p');
  assert.equal((await qbt.get('f'.repeat(40), signal)), undefined);
  await qbt.submit({ type: 'magnet', magnet: 'magnet:?xt=urn:btih:' + HASH }, { ownership: { backend: qbt.identity, scope: 'debridarr', marker: 'owned' } }, signal);
  const files = await qbt.getFiles(HASH, signal);
  assert.deepEqual(files.map(f => f.id), [0, 1]);
  await qbt.setFilesSelected(HASH, [1], false, signal);
  await qbt.capabilities.seedLimits!(HASH, { ratioLimit: 1 }, signal);
  await qbt.remove(HASH, true, signal);
  const byCategory = await qbt.list('debridarr', signal);
  await qbt.setRunning(HASH, false, signal);

  assert.equal(logins(), 1, 'session reused');
  const add = calls.find(c => c.path === '/api/v2/torrents/add');
  assert.equal(add?.form?.category, 'debridarr');
  assert.equal(add?.form?.autoTMM, 'false');
  assert.equal(add?.form?.sequentialDownload, 'true');
  assert.equal(add?.form?.firstLastPiecePrio, 'true');
  assert.deepEqual(calls.find(c => c.path === '/api/v2/torrents/filePrio')?.form, { hash: HASH, id: '1', priority: '0' });
  assert.equal(calls.find(c => c.path === '/api/v2/torrents/setShareLimits')?.form?.ratioLimit, '1');
  assert.deepEqual(calls.find(c => c.path === '/api/v2/torrents/delete')?.form, { hashes: HASH, deleteFiles: 'true' });
  assert.deepEqual(byCategory.map(t => t.infoHash), [HASH]);
  assert.ok(calls.some(c => c.path === '/api/v2/torrents/stop'));
  assert.ok(!calls.some(c => c.path === '/api/v2/app/setPreferences'));
});

test('an expired session (403) triggers exactly one re-login and retry', async t => {
  const { base, logins } = await mockQbt(t, { failNextAuthed: true });
  const qbt = new QBittorrentClient({ url: base, username: 'admin', password: 'pw' });
  const torrent = await qbt.get(HASH, AbortSignal.timeout(3000));
  assert.equal(torrent?.infoHash, HASH);
  assert.equal(logins(), 2);
});

test('an unconfigured client reports not_configured without a network call', async () => {
  const result = await new QBittorrentClient({ url: '', username: '', password: '' }).test();
  assert.equal(result.code, 'not_configured');
});

test('qBittorrent 5.1+ IP-subnet auth bypass (204, no cookie) is accepted and reused', async t => {
  const paths: string[] = [];
  let sawCookie = false;
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url!, 'http://x').pathname;
      paths.push(path);
      if (request.headers.cookie) sawCookie = true;
      if (path === '/api/v2/auth/login') { response.statusCode = 204; response.end(); return; }
      if (path === '/api/v2/app/version') { response.end('v5.2.3'); return; }
      if (path === '/api/v2/torrents/info') { response.setHeader('Content-Type', 'application/json'); response.end('[]'); return; }
      response.end('Ok.');
    })().catch(() => { response.statusCode = 500; response.end('e'); });
  });
  const base = await listen(server, t);
  const qbt = new QBittorrentClient({ url: base, username: 'ignored', password: 'ignored' });

  const result = await qbt.test();
  assert.equal(result.ok, true);
  assert.equal(result.version, 'v5.2.3');
  assert.equal(await qbt.get('a'.repeat(40), AbortSignal.timeout(2000)), undefined);

  assert.equal(paths.filter(p => p === '/api/v2/auth/login').length, 1, 'logs in once, then reuses the bypass');
  assert.equal(sawCookie, false, 'no session cookie is sent in bypass mode');
});

test('qBittorrent login: an empty 200 body is bypass; any other non-Ok/non-Fails body is unexpected', async t => {
  let loginBody = '';
  const base = await listen(createServer((request, response) => {
    const path = new URL(request.url!, 'http://x').pathname;
    if (path === '/api/v2/auth/login') { response.end(loginBody); return; }
    response.end('v5.0.4');
  }), t);
  assert.equal((await new QBittorrentClient({ url: base, username: 'u', password: 'p' }).test()).ok, true);
  loginBody = 'Access denied by policy';
  assert.equal((await new QBittorrentClient({ url: base, username: 'u', password: 'p' }).test()).code, 'unexpected_response');
});

test('addTorrentFile uploads the raw bytes as multipart form data', async t => {
  const chunks: Buffer[] = [];
  let contentType = '';
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url!, 'http://x').pathname;
      if (path === '/api/v2/auth/login') { response.setHeader('Set-Cookie', 'SID=s; Path=/'); response.end('Ok.'); return; }
      contentType = request.headers['content-type'] ?? '';
      for await (const chunk of request) chunks.push(chunk as Buffer);
      response.end('Ok.');
    })().catch(() => { response.statusCode = 500; response.end('e'); });
  });
  const base = await listen(server, t);
  const qbt = new QBittorrentClient({ url: base, username: 'u', password: 'p' });
  const bytes = Buffer.from('d4:infod4:name4:teste6:lengthi1ee');
  await qbt.submit({ type: 'torrent', bytes }, { ownership: { backend: qbt.identity, scope: 'debridarr', marker: 'owned' } }, AbortSignal.timeout(3000));

  assert.match(contentType, /^multipart\/form-data; boundary=/);
  const body = Buffer.concat(chunks).toString('latin1');
  assert.match(body, /name="torrents"/);
  assert.match(body, /filename="release\.torrent"/);
  assert.match(body, /name="category"/);
  assert.match(body, /name="sequentialDownload"\r\n\r\ntrue/);
  assert.match(body, /name="firstLastPiecePrio"\r\n\r\ntrue/);
  assert.ok(body.includes('debridarr'));
  assert.ok(body.includes(bytes.toString('latin1')), 'the uploaded bytes are present in the body');
});

test('files() returns [] when qBittorrent has no metadata yet (404 / non-array)', async t => {
  let mode: 'missing' | 'notjson' | 'ok' = 'missing';
  const base = await listen(createServer((request, response) => {
    const path = new URL(request.url!, 'http://x').pathname;
    if (path === '/api/v2/auth/login') { response.setHeader('Set-Cookie', 'SID=s; Path=/'); response.end('Ok.'); return; }
    if (mode === 'missing') { response.statusCode = 404; response.end('Not found'); return; }
    if (mode === 'notjson') { response.end('<html>nope</html>'); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify([{ index: 0, name: 'a.mkv', size: 1, progress: 0, priority: 1 }]));
  }), t);
  const qbt = new QBittorrentClient({ url: base, username: 'u', password: 'p' });
  assert.deepEqual(await qbt.getFiles('a'.repeat(40), AbortSignal.timeout(2000)), []);
  mode = 'notjson';
  assert.deepEqual(await qbt.getFiles('a'.repeat(40), AbortSignal.timeout(2000)), []);
  mode = 'ok';
  assert.equal((await qbt.getFiles('a'.repeat(40), AbortSignal.timeout(2000))).length, 1);
});

test('piece API parses inclusive ranges and rejects invalid piece sizes and state arrays', async t => {
  let pieceSize: unknown = 65536;
  let states: unknown = [2, 1, 0];
  const base = await listen(createServer((request, response) => {
    const path = new URL(request.url!, 'http://x').pathname;
    if (path === '/api/v2/auth/login') { response.statusCode = 204; response.end(); return; }
    if (path === '/api/v2/torrents/properties') { response.end(JSON.stringify({ piece_size: pieceSize })); return; }
    if (path === '/api/v2/torrents/pieceStates') { response.end(JSON.stringify(states)); return; }
    if (path === '/api/v2/torrents/files') {
      response.end(JSON.stringify([{ index: 0, name: 'a.mkv', size: 100, piece_range: [2, 3] }, { index: 1, name: 'b.mkv', piece_range: [3, 2] }])); return;
    }
    response.statusCode = 404; response.end();
  }), t);
  const qbt = new QBittorrentClient({ url: base, username: 'u', password: 'p' });
  const signal = AbortSignal.timeout(3000);
  assert.deepEqual((await qbt.getFiles(HASH, signal)).map(f => f.pieceRange), [[2, 3], undefined]);
  assert.equal(await qbt.pieceSize(HASH, signal), 65536);
  assert.deepEqual(await qbt.pieceStates(HASH, signal), [2, 1, 0]);
  for (pieceSize of [0, -1, 1.5, '65536', null]) await assert.rejects(qbt.pieceSize(HASH, signal));
  for (states of [[], [3], ['2'], {}, null]) await assert.rejects(qbt.pieceStates(HASH, signal));
});
