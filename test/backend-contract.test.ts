// One shared lifecycle contract exercised against every DownloadBackend
// adapter through the interface alone (src/backends/download.ts), so a new
// backend proves it interoperates with core code without protocol-specific
// assertions. Wire-format details belong in the adapter's own test file.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { test, type TestContext } from 'node:test';
import type { DownloadBackend, DownloadSource } from '../src/backends/download.js';
import { nzbIdentity } from '../src/downloads/nzb.js';
import { DelugeClient } from '../src/integrations/deluge/client.js';
import { QBittorrentClient } from '../src/integrations/qbittorrent/client.js';
import { SabnzbdClient } from '../src/integrations/sabnzbd/client.js';
import { TransmissionClient } from '../src/integrations/transmission/client.js';
import { listen } from './helpers.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const SCOPE = 'debridarr';
const MARKER = 'owned-marker';

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

interface VirtualTorrent {
  added: boolean;
  removed: boolean;
  selected: boolean[];
  complete: boolean;
}

function newTorrent(): VirtualTorrent {
  return { added: false, removed: false, selected: [true, true], complete: false };
}

// A minimal single-torrent qBittorrent Web API double: enough surface for
// add -> inspect -> select -> complete -> serve(state) -> delete.
function mockQbittorrent(t: TestContext) {
  const torrent = newTorrent();
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://x');
      const path = url.pathname;
      if (path === '/api/v2/auth/login') { response.setHeader('Set-Cookie', 'SID=s; Path=/'); response.end('Ok.'); return; }
      if (path === '/api/v2/app/version') { response.end('v5.0.4'); return; }
      response.setHeader('Content-Type', 'application/json');
      if (path === '/api/v2/torrents/add') { torrent.added = true; response.end('Ok.'); return; }
      if (path === '/api/v2/torrents/info') {
        if (!torrent.added || torrent.removed) { response.end('[]'); return; }
        const category = url.searchParams.get('category');
        if (category !== null && category !== SCOPE) { response.end('[]'); return; }
        response.end(JSON.stringify([{
          hash: HASH.toUpperCase(), category: SCOPE, tags: MARKER, name: 'Contract Fixture', state: torrent.complete ? 'stoppedUP' : 'downloading',
          progress: torrent.complete ? 1 : 0.5, size: 100, ratio: 0, save_path: '/downloads', content_path: '/downloads/x', amount_left: torrent.complete ? 0 : 50,
        }]));
        return;
      }
      if (path === '/api/v2/torrents/files') {
        response.end(JSON.stringify([
          { index: 0, name: 'movie.mkv', size: 90, progress: torrent.complete ? 1 : 0.5, priority: torrent.selected[0] ? 1 : 0 },
          { index: 1, name: 'extras.mkv', size: 10, progress: torrent.complete ? 1 : 0, priority: torrent.selected[1] ? 1 : 0 },
        ]));
        return;
      }
      if (path === '/api/v2/torrents/filePrio') {
        const form = new URLSearchParams(await readBody(request));
        const priority = form.get('priority');
        for (const id of (form.get('id') ?? '').split('|').filter(Boolean).map(Number)) torrent.selected[id] = priority !== '0';
        response.end('Ok.');
        return;
      }
      if (path === '/api/v2/torrents/delete') { torrent.removed = true; response.end('Ok.'); return; }
      response.end('Ok.');
    })().catch(() => { response.statusCode = 500; response.end('err'); });
  });
  return { torrent, ready: listen(server, t) };
}

// A minimal single-torrent Transmission RPC double covering the same lifecycle.
function mockTransmission(t: TestContext) {
  const torrent = newTorrent();
  const sessionId = 'contract-csrf';
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers['x-transmission-session-id'] !== sessionId) {
        response.statusCode = 409; response.setHeader('X-Transmission-Session-Id', sessionId); response.end(); return;
      }
      const { method, arguments: args } = JSON.parse(await readBody(request)) as { method: string; arguments: Record<string, unknown> };
      response.setHeader('Content-Type', 'application/json');
      const ok = (a: Record<string, unknown> = {}) => response.end(JSON.stringify({ result: 'success', arguments: a }));
      if (method === 'session-get') { ok({ version: '4.0.5', 'download-dir': '/downloads' }); return; }
      if (method === 'torrent-add') { torrent.added = true; ok({ 'torrent-added': { id: 1, hashString: HASH } }); return; }
      if (method === 'torrent-set') {
        if (Array.isArray(args['files-wanted'])) for (const id of args['files-wanted'] as number[]) torrent.selected[id] = true;
        if (Array.isArray(args['files-unwanted'])) for (const id of args['files-unwanted'] as number[]) torrent.selected[id] = false;
        ok();
        return;
      }
      if (method === 'torrent-remove') { torrent.removed = true; ok(); return; }
      if (method === 'torrent-get') {
        if (!torrent.added || torrent.removed) { ok({ torrents: [] }); return; }
        if ((args.fields as string[] | undefined)?.includes('files')) {
          ok({ torrents: [{
            files: [{ name: 'movie.mkv', length: 90, bytesCompleted: torrent.complete ? 90 : 45 }, { name: 'extras.mkv', length: 10, bytesCompleted: torrent.complete ? 10 : 0 }],
            fileStats: [{ wanted: torrent.selected[0] }, { wanted: torrent.selected[1] }],
          }] });
          return;
        }
        ok({ torrents: [{
          hashString: HASH, name: 'Contract Fixture', status: torrent.complete ? 6 : 4, percentDone: torrent.complete ? 1 : 0.5,
          totalSize: 100, uploadRatio: 0, downloadDir: '/downloads', leftUntilDone: torrent.complete ? 0 : 50, rateDownload: 0, eta: -1,
          labels: [SCOPE, MARKER],
        }] });
        return;
      }
      ok();
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  return { torrent, ready: listen(server, t) };
}

// A minimal single-torrent Deluge JSON-RPC double covering the same lifecycle.
function mockDeluge(t: TestContext) {
  const torrent = newTorrent();
  const files = [
    { index: 0, path: 'movie.mkv', size: 90 },
    { index: 1, path: 'extras.mkv', size: 10 },
  ];
  let label = '';
  const server = createServer((request, response) => {
    void (async () => {
      const { method, params } = JSON.parse(await readBody(request)) as { method: string; params: unknown[] };
      const ok = (result: unknown) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ id: 1, result, error: null }));
      };
      if (method === 'auth.login') {
        response.setHeader('Set-Cookie', '_session_id=contract; Path=/json');
        ok(true);
        return;
      }
      if (method === 'web.connected') { ok(true); return; }
      if (method === 'daemon.info') { ok('2.1.1'); return; }
      if (method === 'core.get_enabled_plugins') { ok(['Label']); return; }
      if (method === 'label.get_labels') { ok(label ? [label] : []); return; }
      if (method === 'label.add') { ok(null); return; }
      if (method === 'label.set_torrent') { label = String(params[1] ?? ''); ok(null); return; }
      if (method === 'core.add_torrent_magnet' || method === 'core.add_torrent_file') { torrent.added = true; ok(HASH); return; }
      if (method === 'core.remove_torrent') { torrent.removed = true; ok(true); return; }
      if (method === 'core.set_torrent_options') {
        const options = (params[1] ?? {}) as { file_priorities?: number[] };
        if (Array.isArray(options.file_priorities)) {
          for (const [index, priority] of options.file_priorities.entries()) torrent.selected[index] = priority > 0;
        }
        ok(null);
        return;
      }
      if (method === 'core.get_torrent_status') {
        if (!torrent.added || torrent.removed) { ok({}); return; }
        const keys = (params[1] as string[] | undefined) ?? [];
        if (keys.includes('files')) {
          ok({
            files,
            file_progress: files.map((_, i) => (torrent.complete ? 1 : i === 0 ? 0.5 : 0)),
            file_priorities: torrent.selected.map(selected => selected ? 1 : 0),
          });
          return;
        }
        ok({
          name: 'Contract Fixture', state: torrent.complete ? 'Seeding' : 'Downloading',
          progress: torrent.complete ? 100 : 50, total_size: 100, ratio: 0, save_path: '/downloads',
          download_location: '/downloads', total_remaining: torrent.complete ? 0 : 50, label,
        });
        return;
      }
      if (method === 'core.get_torrents_status') {
        if (!torrent.added || torrent.removed) { ok({}); return; }
        ok({ [HASH]: {
          name: 'Contract Fixture', state: torrent.complete ? 'Seeding' : 'Downloading',
          progress: torrent.complete ? 100 : 50, total_size: 100, ratio: 0, save_path: '/downloads',
          download_location: '/downloads', total_remaining: torrent.complete ? 0 : 50, label,
        } });
        return;
      }
      ok(null);
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  return { torrent, ready: listen(server, t) };
}

async function runLifecycle(
  backend: DownloadBackend,
  torrent: VirtualTorrent,
  source: DownloadSource = { type: 'magnet', magnet: `magnet:?xt=urn:btih:${HASH}` },
  id = HASH,
): Promise<void> {
  const signal = AbortSignal.timeout(5000);

  await backend.submit(source, { ownership: { backend: backend.identity, scope: SCOPE, marker: MARKER } }, signal);

  let snapshot = await backend.get(id, signal);
  assert.ok(snapshot, 'submitted transfer is inspectable');
  assert.equal(snapshot!.scope, SCOPE);
  assert.ok(snapshot!.markers.includes(MARKER));
  assert.equal(snapshot!.progress < 1, true, 'not yet complete');

  const byScope = await backend.list(SCOPE, signal);
  assert.ok(byScope.some(entry => entry.infoHash === id), 'listing by scope finds the transfer');

  let files = await backend.getFiles(id, signal);
  assert.equal(files.length, 2);
  assert.ok(files.every(f => f.selected), 'both files start selected');

  await backend.setFilesSelected(id, [1], false, signal);
  files = await backend.getFiles(id, signal);
  assert.equal(files.find(f => f.id === 0)?.selected, true, 'file 0 stays selected');
  const extras = files.find(f => f.id === 1);
  assert.ok(!extras || extras.selected === false, 'file 1 is deselected or removed');

  torrent.complete = true;
  snapshot = await backend.get(id, signal);
  assert.equal(snapshot!.progress, 1, 'transfer reaches completion');

  await backend.remove(id, true, signal);
  assert.equal(await backend.get(id, signal), undefined, 'removed transfer is no longer inspectable');
  assert.equal((await backend.list(SCOPE, signal)).length, 0, 'removed transfer drops out of its scope listing');
}

test('qBittorrent: add -> inspect -> select -> complete -> delete', async t => {
  const { torrent, ready } = mockQbittorrent(t);
  const base = await ready;
  await runLifecycle(new QBittorrentClient({ url: base, username: 'admin', password: 'pw' }), torrent);
});

test('Transmission: add -> inspect -> select -> complete -> delete', async t => {
  const { torrent, ready } = mockTransmission(t);
  const base = await ready;
  await runLifecycle(new TransmissionClient({ url: base, username: '', password: '' }), torrent);
});

test('Deluge: add -> inspect -> select -> complete -> delete', async t => {
  const { torrent, ready } = mockDeluge(t);
  const base = await ready;
  await runLifecycle(new DelugeClient({ url: base, username: '', password: 'deluge' }), torrent);
});

const CONTRACT_NZB = Buffer.from(`<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file subject="movie.mkv"><groups><group>a</group></groups><segments><segment bytes="90" number="1">a@x</segment></segments></file><file subject="extras.mkv"><groups><group>a</group></groups><segments><segment bytes="10" number="1">b@x</segment></segments></file></nzb>`);
const CONTRACT_NZB_ID = nzbIdentity(CONTRACT_NZB);

function mockSabnzbd(t: TestContext) {
  const torrent = newTorrent();
  const files = [
    { filename: 'movie.mkv', bytes: '90', nzf_id: 'nzf-0', status: 'active' },
    { filename: 'extras.mkv', bytes: '10', nzf_id: 'nzf-1', status: 'active' },
  ];
  let cat = '';
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://x');
      const params = Object.fromEntries(url.searchParams);
      if (request.method === 'POST') await readBody(request);
      const ok = (body: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); };
      if (params.mode === 'addfile') { torrent.added = true; cat = params.cat ?? cat; ok({ status: true, nzo_ids: ['SABnzbd_nzo_c'] }); return; }
      if (params.mode === 'get_files') { ok({ files }); return; }
      if (params.mode === 'history') {
        if (params.name === 'delete') { torrent.removed = true; ok({ status: true }); return; }
        ok({ history: { slots: torrent.added && !torrent.removed && torrent.complete ? [{ nzo_id: 'SABnzbd_nzo_c', nzb_name: CONTRACT_NZB_ID, category: cat, status: 'Completed', bytes: 100, storage: '/downloads/x' }] : [] } });
        return;
      }
      if (params.mode === 'queue') {
        if (params.name === 'delete_nzf') {
          const ids = new Set((params.value2 ?? '').split(',').filter(Boolean));
          for (const file of files) if (ids.has(file.nzf_id)) file.status = 'paused';
          ok({ status: true });
          return;
        }
        if (params.name === 'delete') { torrent.removed = true; ok({ status: true }); return; }
        if (params.name === 'change_cat') { cat = params.value2 ?? cat; ok({ status: true }); return; }
        ok({ queue: { version: '4.3.2', diskspace1: '10', slots: torrent.added && !torrent.removed && !torrent.complete ? [{
          nzo_id: 'SABnzbd_nzo_c', filename: CONTRACT_NZB_ID, cat, status: 'Downloading', percentage: torrent.complete ? '100' : '50', mb: '0.10', mbleft: '0.05',
        }] : [] } });
        return;
      }
      ok({});
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  return { torrent, ready: listen(server, t) };
}

test('SABnzbd: add -> inspect -> select -> complete -> delete', async t => {
  const { torrent, ready } = mockSabnzbd(t);
  const base = await ready;
  await runLifecycle(new SabnzbdClient({ url: base, username: '', password: 'k' }), torrent, { type: 'nzb', bytes: CONTRACT_NZB }, CONTRACT_NZB_ID);
});

test('each adapter declares its protocol and only the capability groups it implements', () => {
  const qbt = new QBittorrentClient({ url: 'http://qbt:8080', username: 'admin', password: 'pw' });
  const transmission = new TransmissionClient({ url: 'http://tr:9091/transmission/rpc', username: '', password: '' });
  const deluge = new DelugeClient({ url: 'http://deluge:8112', username: '', password: 'deluge' });
  const sabnzbd = new SabnzbdClient({ url: 'http://sabnzbd:8080', username: '', password: 'k' });
  for (const backend of [qbt, transmission, deluge]) {
    assert.equal(backend.protocol, 'torrent');
    assert.ok(backend.capabilities.markers, 'torrent backends can tag ownership durably');
    assert.ok(backend.capabilities.pieces);
    assert.ok(backend.capabilities.freeSpace);
  }
  // Transmission exposes no download-order control; core must branch on the
  // declaration rather than assume every torrent backend has one.
  assert.equal(transmission.capabilities.downloadOrder, undefined);
  assert.ok(qbt.capabilities.downloadOrder);
  assert.ok(deluge.capabilities.downloadOrder);
  assert.equal(sabnzbd.protocol, 'usenet');
  assert.ok(sabnzbd.capabilities.markers);
  assert.ok(sabnzbd.capabilities.freeSpace);
  assert.equal(sabnzbd.capabilities.pieces, undefined);
  assert.equal(sabnzbd.capabilities.seedLimits, undefined);
  assert.equal(sabnzbd.capabilities.downloadOrder, undefined);
});
