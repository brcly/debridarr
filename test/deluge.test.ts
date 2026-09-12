import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { test, type TestContext } from 'node:test';
import { DelugeClient } from '../src/integrations/deluge/client.js';
import type { TorrentBackend } from '../src/backends/torrent.js';
import { listen } from './helpers.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const SCOPE = 'debridarr';
const MARKER = 'debridarr-ownedmarker000000000000001';
const LABEL = `${SCOPE}__${MARKER}`;

async function readRpc(request: IncomingMessage): Promise<{ method: string; params: unknown[] }> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body) as { method: string; params: unknown[] };
}

interface MockOptions { password?: string }

function mockDeluge(t: TestContext, options: MockOptions = {}) {
  const password = options.password ?? 'deluge';
  const calls: { method: string; params: unknown[] }[] = [];
  const torrent: Record<string, unknown> = {
    name: 'The Matrix 1999 1080p', state: 'Downloading', progress: 50, total_size: 100, ratio: 0.2,
    save_path: '/downloads', download_location: '/downloads', total_remaining: 50,
    num_seeds: 9, num_peers: 11, total_seeds: 9, total_peers: 11,
    download_payload_rate: 1000, eta: 60, label: LABEL,
    sequential_download: false, prioritize_first_last_pieces: false,
    files: [
      { index: 0, path: 'The.Matrix.1999/movie.mkv', size: 90 },
      { index: 1, path: 'The.Matrix.1999/extras.mkv', size: 10 },
    ],
    file_progress: [1, 0],
    file_priorities: [1, 0],
    piece_length: 65536,
    pieces: [true, false, true, false, false, false, false, false],
  };
  const labels = new Set<string>([LABEL]);
  let session = '';
  const server = createServer((request, response) => {
    void (async () => {
      const { method, params } = await readRpc(request);
      const ok = (result: unknown) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ id: 1, result, error: null }));
      };
      const rpcError = (code: number, message: string) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ id: 1, result: null, error: { code, message } }));
      };
      if (method === 'auth.login') {
        if (params[0] !== password) { ok(false); return; }
        session = 'deluge-session';
        response.setHeader('Set-Cookie', `_session_id=${session}; Path=/json`);
        ok(true);
        return;
      }
      if (!request.headers.cookie?.includes(`_session_id=${session}`)) { rpcError(1, 'Not authenticated'); return; }
      calls.push({ method, params });
      if (method === 'web.connected') { ok(true); return; }
      if (method === 'daemon.info') { ok('2.1.1'); return; }
      if (method === 'core.get_config') { ok({ download_location: '/downloads' }); return; }
      if (method === 'core.get_free_space') { ok(123456); return; }
      if (method === 'core.get_enabled_plugins') { ok(['Label']); return; }
      if (method === 'label.get_labels') { ok([...labels]); return; }
      if (method === 'label.add') { labels.add(String(params[0])); ok(null); return; }
      if (method === 'label.set_torrent') { torrent.label = params[1]; ok(null); return; }
      if (method === 'core.add_torrent_magnet' || method === 'core.add_torrent_file') { ok(HASH); return; }
      if (method === 'core.get_torrent_status') {
        const keys = params[1] as string[];
        const subset: Record<string, unknown> = {};
        for (const key of keys) if (key in torrent) subset[key] = torrent[key];
        ok(subset);
        return;
      }
      if (method === 'core.get_torrents_status') {
        ok({ [HASH]: torrent, ['f'.repeat(40)]: { ...torrent, name: 'other', label: 'other' } });
        return;
      }
      if (method === 'core.set_torrent_options') { ok(null); return; }
      if (method === 'core.remove_torrent') { ok(true); return; }
      if (method === 'core.pause_torrent' || method === 'core.resume_torrent') { ok(null); return; }
      ok(null);
    })().catch(() => { response.statusCode = 500; response.end('err'); });
  });
  return listen(server, t).then(base => ({ base, calls, torrent, labels }));
}

test('cookie login then daemon.info reports a connected version', async t => {
  const { base } = await mockDeluge(t);
  const client: TorrentBackend = new DelugeClient({ url: base, username: '', password: 'deluge' });
  const result = await client.test();
  assert.equal(result.ok, true);
  assert.equal(result.version, '2.1.1');
});

test('get() decodes the packed label into scope and markers and scales progress', async t => {
  const { base } = await mockDeluge(t);
  const client = new DelugeClient({ url: base, username: '', password: 'deluge' });
  const snapshot = await client.get(HASH, AbortSignal.timeout(3000));
  assert.equal(snapshot?.name, 'The Matrix 1999 1080p');
  assert.equal(snapshot?.scope, SCOPE);
  assert.deepEqual(snapshot?.markers, [MARKER]);
  assert.equal(snapshot?.progress, 0.5);
  assert.equal(snapshot?.state, 'downloading');
  assert.equal(snapshot?.seeders, 9);
  assert.equal(snapshot?.leechers, 2);
});

test('submit packs scope and marker into one label and re-applies it', async t => {
  const { base, calls } = await mockDeluge(t);
  const client = new DelugeClient({ url: base, username: '', password: 'deluge' });
  await client.submit(
    { type: 'magnet', magnet: `magnet:?xt=urn:btih:${HASH}` },
    { ownership: { backend: client.identity, scope: SCOPE, marker: MARKER } },
    AbortSignal.timeout(3000),
  );
  const add = calls.find(c => c.method === 'core.add_torrent_magnet');
  assert.ok(add, 'expected a core.add_torrent_magnet call');
  assert.equal(add.params[0], `magnet:?xt=urn:btih:${HASH}`);
  assert.equal((add.params[1] as { add_paused?: boolean }).add_paused, false);
  assert.ok(calls.some(c => c.method === 'label.add' && c.params[0] === LABEL) || calls.some(c => c.method === 'label.get_labels'));
  const set = calls.find(c => c.method === 'label.set_torrent');
  assert.deepEqual(set?.params, [HASH, LABEL]);
});

test('duplicate magnet still applies the ownership label', async t => {
  const base = await listen(createServer((request, response) => {
    void (async () => {
      const { method } = await readRpc(request);
      const ok = (result: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ id: 1, result, error: null })); };
      if (method === 'auth.login') {
        response.setHeader('Set-Cookie', '_session_id=s; Path=/json');
        ok(true);
        return;
      }
      if (method === 'web.connected') { ok(true); return; }
      if (method === 'core.add_torrent_magnet') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ id: 1, result: null, error: { code: 4, message: `Torrent already in session (${HASH}).` } }));
        return;
      }
      if (method === 'core.get_enabled_plugins') { ok(['Label']); return; }
      if (method === 'label.get_labels') { ok([LABEL]); return; }
      if (method === 'label.set_torrent') { ok(null); return; }
      ok(null);
    })().catch(() => { response.statusCode = 500; response.end(); });
  }), t);
  const client = new DelugeClient({ url: base, username: '', password: 'deluge' });
  await client.submit(
    { type: 'magnet', magnet: `magnet:?xt=urn:btih:${HASH}` },
    { ownership: { backend: client.identity, scope: SCOPE, marker: MARKER } },
    AbortSignal.timeout(3000),
  );
});

test('submits raw torrent bytes as base64 filedump', async t => {
  const { base, calls } = await mockDeluge(t);
  const client = new DelugeClient({ url: base, username: '', password: 'deluge' });
  const bytes = Buffer.from('d4:infod4:name4:teste6:lengthi1ee');
  await client.submit({ type: 'torrent', bytes }, { ownership: { backend: client.identity, scope: SCOPE, marker: MARKER } }, AbortSignal.timeout(3000));
  const add = calls.find(c => c.method === 'core.add_torrent_file');
  assert.equal(add?.params[0], 'release.torrent');
  assert.equal(add?.params[1], bytes.toString('base64'));
});

test('file selection, free space, and removal use set_torrent_options / get_free_space / remove_torrent', async t => {
  const { base, calls } = await mockDeluge(t);
  const client = new DelugeClient({ url: base, username: '', password: 'deluge' });
  const signal = AbortSignal.timeout(3000);
  const files = await client.getFiles(HASH, signal);
  assert.deepEqual(files.map(f => f.selected), [true, false]);
  await client.setFilesSelected(HASH, [1], false, signal);
  const set = calls.find(c => c.method === 'core.set_torrent_options');
  assert.ok(set, 'expected a core.set_torrent_options call');
  assert.deepEqual((set.params[1] as { file_priorities: number[] }).file_priorities, [1, 0]);
  assert.equal(await client.capabilities.freeSpace!(signal), 123456);
  await client.remove(HASH, true, signal);
  assert.deepEqual(calls.find(c => c.method === 'core.remove_torrent')?.params, [HASH, true]);
});

test('wrong password maps to authentication, and an empty URL is not_configured', async t => {
  const { base } = await mockDeluge(t, { password: 'secret' });
  const good = new DelugeClient({ url: base, username: '', password: 'secret' });
  assert.equal((await good.test()).ok, true);
  const bad = new DelugeClient({ url: base, username: '', password: 'wrong' });
  assert.equal((await bad.test()).code, 'authentication');
  assert.equal((await new DelugeClient({ url: '', username: '', password: '' }).test()).code, 'not_configured');
});

test('list() filters by the label scope segment', async t => {
  const { base } = await mockDeluge(t);
  const client = new DelugeClient({ url: base, username: '', password: 'deluge' });
  const list = await client.list(SCOPE, AbortSignal.timeout(3000));
  assert.deepEqual(list.map(t => t.infoHash), [HASH]);
});

test('addMarker appends to the packed label without dropping the scope', async t => {
  const { base, calls } = await mockDeluge(t);
  const client = new DelugeClient({ url: base, username: '', password: 'deluge' });
  const extra = 'debridarr-secondmarker00000000000002';
  await client.capabilities.markers!.add(HASH, extra, AbortSignal.timeout(3000));
  const set = calls.find(c => c.method === 'label.set_torrent');
  assert.deepEqual(set?.params, [HASH, `${SCOPE}__${MARKER}__${extra}`]);
});

test('pieceStates maps Deluge bools onto 0/2 states', async t => {
  const { base } = await mockDeluge(t);
  const client = new DelugeClient({ url: base, username: '', password: 'deluge' });
  const signal = AbortSignal.timeout(3000);
  assert.equal(await client.capabilities.pieces!.size(HASH, signal), 65536);
  assert.deepEqual(await client.capabilities.pieces!.states(HASH, signal), [2, 0, 2, 0, 0, 0, 0, 0]);
});

test('an expired session cookie logs in again and retries the call', async t => {
  let logins = 0;
  let expireNext = false;
  const base = await listen(createServer((request, response) => {
    void (async () => {
      const { method } = await readRpc(request);
      const ok = (result: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ id: 1, result, error: null })); };
      if (method === 'auth.login') {
        logins += 1;
        response.setHeader('Set-Cookie', `_session_id=s${logins}; Path=/json`);
        ok(true);
        return;
      }
      if (expireNext) {
        expireNext = false;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ id: 1, result: null, error: { code: 1, message: 'Not authenticated' } }));
        return;
      }
      if (method === 'web.connected') { ok(true); return; }
      if (method === 'daemon.info') { ok('2.1.1'); return; }
      if (method === 'core.get_torrent_status') { ok({ name: 'x', state: 'Paused', progress: 0, label: LABEL }); return; }
      ok(null);
    })().catch(() => { response.statusCode = 500; response.end(); });
  }), t);
  const client = new DelugeClient({ url: base, username: '', password: 'deluge' });
  assert.equal((await client.test()).ok, true);
  assert.equal(logins, 1);
  expireNext = true;
  const snapshot = await client.get(HASH, AbortSignal.timeout(3000));
  assert.equal(snapshot?.name, 'x');
  assert.equal(logins, 2);
});
