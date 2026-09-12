import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { test, type TestContext } from 'node:test';
import { TransmissionClient } from '../src/integrations/transmission/client.js';
import type { TorrentBackend } from '../src/backends/torrent.js';
import { listen } from './helpers.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const SESSION_ID = 'abc123csrf';

async function readJson(request: IncomingMessage): Promise<{ method: string; arguments: Record<string, unknown> }> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

interface MockOptions { requireAuth?: { username: string; password: string } }

function mockTransmission(t: TestContext, options: MockOptions = {}) {
  const calls: { method: string; arguments: Record<string, unknown> }[] = [];
  const torrent = {
    hashString: HASH, name: 'The Matrix 1999 1080p', status: 4, percentDone: 0.5, totalSize: 100,
    uploadRatio: 0.2, downloadDir: '/downloads', leftUntilDone: 50, rateDownload: 1000, eta: 60,
    labels: ['debridarr', 'owned'], trackerStats: [{ seederCount: 9, leecherCount: 2 }],
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (options.requireAuth) {
        const expected = `Basic ${Buffer.from(`${options.requireAuth.username}:${options.requireAuth.password}`).toString('base64')}`;
        if (request.headers.authorization !== expected) { response.statusCode = 401; response.end(); return; }
      }
      if (request.headers['x-transmission-session-id'] !== SESSION_ID) {
        response.statusCode = 409;
        response.setHeader('X-Transmission-Session-Id', SESSION_ID);
        response.end();
        return;
      }
      const { method, arguments: args } = await readJson(request);
      calls.push({ method, arguments: args });
      response.setHeader('Content-Type', 'application/json');
      if (method === 'session-get') {
        response.end(JSON.stringify({ result: 'success', arguments: { version: '4.0.5', 'download-dir': '/downloads', 'incomplete-dir-enabled': true, 'incomplete-dir': '/incomplete' } }));
        return;
      }
      if (method === 'free-space') {
        response.end(JSON.stringify({ result: 'success', arguments: { path: args.path, 'size-bytes': 123456 } }));
        return;
      }
      if (method === 'torrent-add') {
        response.end(JSON.stringify({ result: 'success', arguments: { 'torrent-added': { id: 7, hashString: HASH, name: torrent.name } } }));
        return;
      }
      if (method === 'torrent-get') {
        if ((args.fields as string[])?.includes('files')) {
          response.end(JSON.stringify({ result: 'success', arguments: { torrents: [{
            files: [{ name: 'The.Matrix.1999/movie.mkv', length: 90, bytesCompleted: 90 }, { name: 'The.Matrix.1999/extras.mkv', length: 10, bytesCompleted: 0 }],
            fileStats: [{ wanted: true }, { wanted: false }],
          }] } }));
          return;
        }
        response.end(JSON.stringify({ result: 'success', arguments: { torrents: [torrent] } }));
        return;
      }
      response.end(JSON.stringify({ result: 'success', arguments: {} }));
    })().catch(() => { response.statusCode = 500; response.end('err'); });
  });
  return listen(server, t).then(base => ({ base, calls }));
}

test('CSRF session negotiation retries exactly once with the token from the 409 response', async t => {
  const { base, calls } = await mockTransmission(t);
  const client: TorrentBackend = new TransmissionClient({ url: base, username: '', password: '' });
  const signal = AbortSignal.timeout(3000);
  const snapshot = await client.get(HASH, signal);
  assert.equal(snapshot?.name, 'The Matrix 1999 1080p');
  assert.equal(snapshot?.scope, 'debridarr');
  assert.deepEqual(snapshot?.markers, ['owned']);
  assert.equal(snapshot?.seeders, 9);
  assert.equal(snapshot?.leechers, 2);
  assert.equal(snapshot?.incompletePath, '/incomplete');
  assert.ok(calls.some(c => c.method === 'torrent-get'));
});

test('submit sends labels [scope, marker] and re-applies them for a duplicate response', async t => {
  const { base, calls } = await mockTransmission(t);
  const client = new TransmissionClient({ url: base, username: '', password: '' });
  const signal = AbortSignal.timeout(3000);
  await client.submit({ type: 'magnet', magnet: 'magnet:?xt=urn:btih:' + HASH }, { ownership: { backend: client.identity, scope: 'debridarr', marker: 'owned' } }, signal);
  const add = calls.find(c => c.method === 'torrent-add');
  assert.deepEqual(add?.arguments.labels, ['debridarr', 'owned']);
  assert.equal(add?.arguments.filename, 'magnet:?xt=urn:btih:' + HASH);
  const set = calls.find(c => c.method === 'torrent-set');
  assert.deepEqual(set?.arguments.labels, ['debridarr', 'owned']);
  assert.deepEqual(set?.arguments.ids, [7]);
});

test('submits raw torrent bytes as base64 metainfo', async t => {
  const { base, calls } = await mockTransmission(t);
  const client = new TransmissionClient({ url: base, username: '', password: '' });
  const bytes = Buffer.from('d4:infod4:name4:teste6:lengthi1ee');
  await client.submit({ type: 'torrent', bytes }, { ownership: { backend: client.identity, scope: 'debridarr', marker: 'owned' } }, AbortSignal.timeout(3000));
  const add = calls.find(c => c.method === 'torrent-add');
  assert.equal(add?.arguments.metainfo, bytes.toString('base64'));
});

test('file selection, free space, and removal use torrent-set/free-space/torrent-remove', async t => {
  const { base, calls } = await mockTransmission(t);
  const client = new TransmissionClient({ url: base, username: '', password: '' });
  const signal = AbortSignal.timeout(3000);
  const files = await client.getFiles(HASH, signal);
  assert.deepEqual(files.map(f => f.selected), [true, false]);
  await client.setFilesSelected(HASH, [1], false, signal);
  assert.deepEqual(calls.find(c => c.method === 'torrent-set' && 'files-unwanted' in c.arguments)?.arguments, { ids: [HASH], 'files-unwanted': [1] });
  assert.equal(await client.capabilities.freeSpace!(signal), 123456);
  await client.remove(HASH, true, signal);
  assert.deepEqual(calls.find(c => c.method === 'torrent-remove')?.arguments, { ids: [HASH], 'delete-local-data': true });
});

test('HTTP basic auth is sent when username/password are configured, and 401 maps to authentication', async t => {
  const { base } = await mockTransmission(t, { requireAuth: { username: 'admin', password: 'secret' } });
  const good = new TransmissionClient({ url: base, username: 'admin', password: 'secret' });
  const result = await good.test();
  assert.equal(result.ok, true);
  assert.equal(result.version, '4.0.5');
  const bad = new TransmissionClient({ url: base, username: 'admin', password: 'wrong' });
  assert.equal((await bad.test()).code, 'authentication');
});

test('an unconfigured client reports not_configured without a network call', async () => {
  const result = await new TransmissionClient({ url: '', username: '', password: '' }).test();
  assert.equal(result.code, 'not_configured');
});

test('list() filters by scope (labels[0]) and only qualifying transfers are returned', async t => {
  const base = await listen(createServer((request, response) => {
    void (async () => {
      if (request.headers['x-transmission-session-id'] !== SESSION_ID) {
        response.statusCode = 409; response.setHeader('X-Transmission-Session-Id', SESSION_ID); response.end(); return;
      }
      const { method } = await readJson(request);
      response.setHeader('Content-Type', 'application/json');
      if (method === 'session-get') { response.end(JSON.stringify({ result: 'success', arguments: { version: '4.0.5', 'download-dir': '/d' } })); return; }
      response.end(JSON.stringify({ result: 'success', arguments: { torrents: [
        { hashString: HASH, name: 'a', status: 4, labels: ['debridarr', 'x'] },
        { hashString: 'f'.repeat(40), name: 'b', status: 4, labels: ['other'] },
      ] } }));
    })().catch(() => { response.statusCode = 500; response.end(); });
  }), t);
  const client = new TransmissionClient({ url: base, username: '', password: '' });
  const list = await client.list('debridarr', AbortSignal.timeout(3000));
  assert.deepEqual(list.map(t => t.infoHash), [HASH]);
});

test('pieceStates decodes the base64 bitfield into 0/2 states', async t => {
  const base = await listen(createServer((request, response) => {
    void (async () => {
      if (request.headers['x-transmission-session-id'] !== SESSION_ID) {
        response.statusCode = 409; response.setHeader('X-Transmission-Session-Id', SESSION_ID); response.end(); return;
      }
      await readJson(request);
      response.setHeader('Content-Type', 'application/json');
      // Bitfield 0b10100000 = pieces 0 and 2 present, 8 bits total.
      response.end(JSON.stringify({ result: 'success', arguments: { torrents: [{ pieceCount: 8, pieces: Buffer.from([0b10100000]).toString('base64'), pieceSize: 65536 }] } }));
    })().catch(() => { response.statusCode = 500; response.end(); });
  }), t);
  const client = new TransmissionClient({ url: base, username: '', password: '' });
  const signal = AbortSignal.timeout(3000);
  assert.equal(await client.capabilities.pieces!.size(HASH, signal), 65536);
  assert.deepEqual(await client.capabilities.pieces!.states(HASH, signal), [2, 0, 2, 0, 0, 0, 0, 0]);
});
