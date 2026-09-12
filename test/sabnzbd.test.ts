import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { test, type TestContext } from 'node:test';
import { SabnzbdClient } from '../src/integrations/sabnzbd/client.js';
import { nzbIdentity } from '../src/downloads/nzb.js';
import { listen } from './helpers.js';

const NZB = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file subject="movie.mkv"><groups><group>a</group></groups><segments><segment bytes="100" number="1">id@x</segment></segments></file></nzb>`);
const HASH = nzbIdentity(NZB);
const SCOPE = 'debridarr';
const MARKER = 'debridarr-ownedmarker000000000000001';
const LABEL = `${SCOPE}__${MARKER}`;
const NZO = 'SABnzbd_nzo_fixture';
const API_KEY = 'secret-api-key';

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

function mockSab(t: TestContext, options: { apiKey?: string } = {}) {
  const apiKey = options.apiKey ?? API_KEY;
  const calls: { mode: string; name?: string; params: Record<string, string> }[] = [];
  const job = {
    present: false,
    history: false,
    cat: LABEL,
    percentage: 50,
    files: [
      { filename: 'movie.mkv', bytes: '90', mbleft: '45', nzf_id: 'nzf-0', status: 'active' },
      { filename: 'extras.mkv', bytes: '10', mbleft: '10', nzf_id: 'nzf-1', status: 'active' },
    ],
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://x');
      if (url.pathname !== '/api') { response.statusCode = 404; response.end(); return; }
      const params = Object.fromEntries(url.searchParams);
      if (request.method === 'POST') await readBody(request);
      const mode = params.mode ?? '';
      calls.push({ mode, params, ...(params.name ? { name: params.name } : {}) });
      response.setHeader('Content-Type', 'application/json');
      if (params.apikey !== apiKey && mode !== 'version') {
        response.end(JSON.stringify({ error: 'API Key Incorrect' }));
        return;
      }
      if (mode === 'addfile') {
        job.present = true;
        job.cat = params.cat || job.cat;
        response.end(JSON.stringify({ status: true, nzo_ids: [NZO] }));
        return;
      }
      if (mode === 'queue') {
        if (params.name === 'change_cat') { job.cat = params.value2 ?? job.cat; response.end(JSON.stringify({ status: true })); return; }
        if (params.name === 'delete') { job.present = false; response.end(JSON.stringify({ status: true })); return; }
        if (params.name === 'delete_nzf') {
          const ids = new Set((params.value2 ?? '').split(',').filter(Boolean));
          for (const file of job.files) if (ids.has(file.nzf_id)) file.status = 'paused';
          response.end(JSON.stringify({ status: true }));
          return;
        }
        if (params.name === 'pause' || params.name === 'resume') { response.end(JSON.stringify({ status: true })); return; }
        response.end(JSON.stringify({
          queue: {
            version: '4.3.2', diskspace1: '12.5',
            slots: job.present && !job.history ? [{
              nzo_id: NZO, filename: HASH, cat: job.cat, status: 'Downloading',
              percentage: String(job.percentage), mb: '0.10', mbleft: job.percentage >= 100 ? '0' : '0.05',
              kbpersec: '10', timeleft: '0:00:10',
            }] : [],
          },
        }));
        return;
      }
      if (mode === 'history') {
        if (params.name === 'delete') { job.present = false; response.end(JSON.stringify({ status: true })); return; }
        response.end(JSON.stringify({
          history: {
            slots: job.present && job.history ? [{
              nzo_id: NZO, nzb_name: HASH, name: HASH, category: job.cat, status: 'Completed',
              bytes: 100, storage: '/downloads/movie.mkv',
            }] : [],
          },
        }));
        return;
      }
      if (mode === 'get_files') {
        response.end(JSON.stringify({ files: job.files }));
        return;
      }
      response.end(JSON.stringify({}));
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  return listen(server, t).then(base => ({ base, calls, job }));
}

test('queue+apikey reports a connected version and wrong keys map to authentication', async t => {
  const { base } = await mockSab(t);
  const good = new SabnzbdClient({ url: base, username: '', password: API_KEY });
  const result = await good.test();
  assert.equal(result.ok, true);
  assert.equal(result.version, '4.3.2');
  const bad = new SabnzbdClient({ url: base, username: '', password: 'wrong' });
  assert.equal((await bad.test()).code, 'authentication');
  assert.equal((await new SabnzbdClient({ url: '', username: '', password: '' }).test()).code, 'not_configured');
});

test('submit uploads an NZB, packs scope/marker into cat, and keys the job by content hash', async t => {
  const { base, calls } = await mockSab(t);
  const client = new SabnzbdClient({ url: base, username: '', password: API_KEY });
  await client.submit({ type: 'nzb', bytes: NZB }, { ownership: { backend: client.identity, scope: SCOPE, marker: MARKER } }, AbortSignal.timeout(3000));
  const add = calls.find(c => c.mode === 'addfile');
  assert.equal(add?.params.nzbname, HASH);
  assert.equal(add?.params.cat, LABEL);
  const snapshot = await client.get(HASH, AbortSignal.timeout(3000));
  assert.equal(snapshot?.infoHash, HASH);
  assert.equal(snapshot?.scope, SCOPE);
  assert.deepEqual(snapshot?.markers, [MARKER]);
  assert.equal(snapshot?.progress, 0.5);
  assert.equal(snapshot?.seeders, 0);
});

test('duplicate NZB re-applies the packed category instead of adding again', async t => {
  const { base, calls, job } = await mockSab(t);
  job.present = true;
  const client = new SabnzbdClient({ url: base, username: '', password: API_KEY });
  await client.submit({ type: 'nzb', bytes: NZB }, { ownership: { backend: client.identity, scope: SCOPE, marker: MARKER } }, AbortSignal.timeout(3000));
  assert.equal(calls.some(c => c.mode === 'addfile'), false);
  assert.ok(calls.some(c => c.mode === 'queue' && c.name === 'change_cat' && c.params.value2 === LABEL));
});

test('magnet and torrent sources are rejected', async t => {
  const { base } = await mockSab(t);
  const client = new SabnzbdClient({ url: base, username: '', password: API_KEY });
  const ownership = { backend: client.identity, scope: SCOPE, marker: MARKER };
  const signal = AbortSignal.timeout(1000);
  await assert.rejects(client.submit({ type: 'magnet', magnet: 'magnet:?xt=urn:btih:' + HASH }, { ownership }, signal));
  await assert.rejects(client.submit({ type: 'torrent', bytes: Buffer.from('d4:infod4:name4:teste6:lengthi1ee') }, { ownership }, signal));
});

test('file deselect, free space, pause, and delete hit delete_nzf / diskspace / pause / queue-delete', async t => {
  const { base, calls, job } = await mockSab(t);
  job.present = true;
  const client = new SabnzbdClient({ url: base, username: '', password: API_KEY });
  const signal = AbortSignal.timeout(3000);
  const files = await client.getFiles(HASH, signal);
  assert.deepEqual(files.map(f => f.selected), [true, true]);
  await client.setFilesSelected(HASH, [1], false, signal);
  assert.equal(calls.find(c => c.name === 'delete_nzf')?.params.value2, 'nzf-1');
  const after = await client.getFiles(HASH, signal);
  assert.equal(after.find(f => f.id === 1)?.selected, false);
  assert.equal(await client.capabilities.freeSpace!(signal), 12_500_000_000);
  await client.setRunning(HASH, false, signal);
  assert.ok(calls.some(c => c.name === 'pause' && c.params.value === NZO));
  await client.remove(HASH, true, signal);
  assert.deepEqual(calls.find(c => c.name === 'delete' && c.mode === 'queue')?.params.del_files, '1');
});

test('list() filters by packed category scope; completed jobs come from history', async t => {
  const { base, job } = await mockSab(t);
  job.present = true;
  const client = new SabnzbdClient({ url: base, username: '', password: API_KEY });
  assert.deepEqual((await client.list(SCOPE, AbortSignal.timeout(3000))).map(e => e.infoHash), [HASH]);
  assert.equal((await client.list('other', AbortSignal.timeout(3000))).length, 0);
  job.history = true;
  const done = await client.get(HASH, AbortSignal.timeout(3000));
  assert.equal(done?.progress, 1);
  assert.equal(done?.savePath, '/downloads/movie.mkv');
  assert.equal(done?.state, 'stopped');
});

test('addMarker appends to the packed category without dropping the scope', async t => {
  const { base, calls, job } = await mockSab(t);
  job.present = true;
  const client = new SabnzbdClient({ url: base, username: '', password: API_KEY });
  const extra = 'debridarr-secondmarker00000000000002';
  await client.capabilities.markers!.add(HASH, extra, AbortSignal.timeout(3000));
  assert.equal(calls.find(c => c.name === 'change_cat')?.params.value2, `${SCOPE}__${MARKER}__${extra}`);
});

