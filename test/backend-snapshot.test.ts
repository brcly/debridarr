import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backendSnapshot, invalidateBackendSnapshot } from '../src/backends/snapshot.js';
import type { DownloadBackend, DownloadSnapshot } from '../src/backends/download.js';

function fake(identity: string, list: () => Promise<DownloadSnapshot[]>): DownloadBackend {
  return {
    identity, protocol: 'torrent', configured: true, pathMappings: [], capabilities: {},
    test: async () => ({ ok: true, code: 'connected', message: 'ok' }),
    get: async () => undefined,
    list,
    getFiles: async () => [],
    submit: async () => {},
    setFilesSelected: async () => {},
    remove: async () => {},
    setRunning: async () => {},
  };
}

test('backendSnapshot coalesces concurrent lists and reuses a fresh result', async () => {
  let lists = 0;
  const backend = fake('qbt:http://x', async () => {
    lists++;
    await new Promise(r => setTimeout(r, 20));
    return [{ infoHash: 'a'.repeat(40), scope: 'debridarr', markers: [], name: 'n', state: 'uploading', progress: 1, bytes: 1, ratio: 0, savePath: '/', contentPath: '/', bytesRemaining: 0, seeders: 0, leechers: 0, downloadSpeed: 0, eta: 0 }];
  });
  const [a, b] = await Promise.all([backendSnapshot(backend), backendSnapshot(backend)]);
  assert.equal(lists, 1);
  assert.equal(a.byHash.size, 1);
  assert.equal((await backendSnapshot(backend)).at, b.at);
  invalidateBackendSnapshot(backend.identity);
  await backendSnapshot(backend);
  assert.equal(lists, 2);
});
