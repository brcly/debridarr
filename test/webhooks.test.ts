import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { withWebhooks } from '../src/webhooks/dispatch.js';
import { DownloadsStore, type DownloadRecord } from '../src/downloads/store.js';
import { ensureTransfer, type EnsureOptions } from '../src/downloads/manager.js';
import { deleteManaged } from '../src/downloads/deletion.js';
import { createDownloadBackend } from '../src/backends/factory.js';
import { emptySettings, SettingsStore, type Settings } from '../src/settings.js';
import type { SettingsRepository } from '../src/state/repositories.js';
import { listen, playRequest, tmpDir } from './helpers.js';
import { listenFakeQbit, SAMPLE_HASH } from './fake-qbt.js';

interface Received { headers: Record<string, string>; raw: string; body: Record<string, unknown> }

// A plain HTTP listener standing in for the operator's webhook receiver.
// `respond` lets a test simulate a failing receiver without a real network
// failure's flaky timing.
async function testListener(t: TestContext, respond: (response: import('node:http').ServerResponse) => void = response => response.end('ok')): Promise<{ url: string; received: () => Received[] }> {
  const received: Received[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    void (async () => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      received.push({ raw, body: raw ? JSON.parse(raw) : {}, headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)])) });
      respond(response);
    })();
  });
  const url = await listen(server, t);
  return { url, received: () => received };
}

// `connections.webhookUrl` is HTTPS-only once saved through SettingsStore (see
// settings.test.ts); the dispatcher itself only reads whatever a
// SettingsRepository reports, so a plain fake pointed at a local HTTP test
// listener exercises real delivery without standing up TLS in a test.
function fakeSettings(webhookUrl: string, webhookSecret = ''): SettingsRepository {
  const current: Settings = { ...emptySettings(), connections: { webhookUrl, webhookSecret } };
  return { snapshot: () => current, update: async () => current };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the webhook delivery');
    await sleep(10);
  }
}

const baseRecord: DownloadRecord = { origin: 'store', infoHash: 'a'.repeat(40), name: 'Movie', fileIndex: 0, fileName: 'movie.mkv', bytes: 100, addedAt: 0, expiresAt: 0, kept: false };

test('withWebhooks: managed/failed fire once on transition, signed with the configured secret', async t => {
  const dir = await tmpDir(t, 'debridarr-webhooks');
  const { url, received } = await testListener(t);
  const downloads = withWebhooks(await DownloadsStore.open(dir), fakeSettings(url, 'shh'));

  await downloads.upsert({ ...baseRecord, lifecycle: 'registering' });
  await sleep(50);
  assert.equal(received().length, 0, 'entering registering is not managed, failed, or deleted');

  await downloads.upsert({ ...baseRecord, lifecycle: 'managed' });
  await waitFor(() => received().length === 1);
  const [managed] = received();
  assert.deepEqual(managed!.body, { event: 'managed', id: baseRecord.infoHash, name: 'Movie', lifecycle: 'managed' });
  assert.equal(managed!.headers['x-debridarr-signature'], `sha256=${createHmac('sha256', 'shh').update(managed!.raw).digest('hex')}`);

  // Re-upserting an already-managed record is not a transition.
  await downloads.upsert({ ...baseRecord, lifecycle: 'managed', bytes: 200 });
  await sleep(50);
  assert.equal(received().length, 1);

  await downloads.upsert({ ...baseRecord, lifecycle: 'failed', failure: 'no_file' });
  await waitFor(() => received().length === 2);
  assert.equal(received()[1]!.body.event, 'failed');

  await downloads.remove(baseRecord.infoHash);
  await waitFor(() => received().length === 3);
  assert.deepEqual(received()[2]!.body, { event: 'deleted', id: baseRecord.infoHash, name: 'Movie', lifecycle: 'failed' });

  // The optional `media` field rides along when the record carries one.
  const withMedia: DownloadRecord = { ...baseRecord, infoHash: 'c'.repeat(40), media: { imdbId: 'tt1234567', type: 'movie' }, lifecycle: 'registering' };
  await downloads.upsert(withMedia);
  await downloads.upsert({ ...withMedia, lifecycle: 'managed' });
  await waitFor(() => received().length === 4);
  assert.deepEqual(received()[3]!.body.media, { imdbId: 'tt1234567', type: 'movie' });
});

test('withWebhooks: no URL means no network call; a failing receiver does not fail the write; other methods pass through', async t => {
  const dir = await tmpDir(t, 'debridarr-webhooks-quiet');
  const raw = await DownloadsStore.open(dir);
  const unconfigured = withWebhooks(raw, fakeSettings(''));
  const saved = await unconfigured.upsert({ ...baseRecord, lifecycle: 'managed' });
  assert.equal(saved.lifecycle, 'managed');
  assert.equal(unconfigured.get(baseRecord.infoHash)?.name, 'Movie');
  assert.deepEqual(unconfigured.list(), raw.list());
  assert.equal((await unconfigured.setKept(baseRecord.infoHash, true))?.kept, true);
  assert.ok((await unconfigured.renew(baseRecord.infoHash, 123))!.expiresAt === 123);

  const { url, received } = await testListener(t, response => { response.statusCode = 500; response.end('nope'); });
  const failing = withWebhooks(raw, fakeSettings(url));
  await assert.doesNotReject(failing.upsert({ ...baseRecord, infoHash: 'b'.repeat(40), lifecycle: 'failed' }));
  await waitFor(() => received().length === 1);
  assert.equal(received()[0]!.body.event, 'failed');
});

test('the real create/delete path notifies through ensureTransfer and deleteManaged, not a separate poller', async t => {
  const dir = await tmpDir(t, 'debridarr-webhooks-create');
  const raw = await DownloadsStore.open(dir);
  const { url, received } = await testListener(t);
  const downloads = withWebhooks(raw, fakeSettings(url));
  const qbt = await listenFakeQbit(t, { savePath: dir });
  const settings = await SettingsStore.open(dir, { QBITTORRENT_URL: qbt.url, QBITTORRENT_USERNAME: 'u', QBITTORRENT_PASSWORD: 'p' });
  const backend = createDownloadBackend(settings.snapshot().downloadBackend);
  const options: EnsureOptions = { backend, store: downloads, signal: AbortSignal.timeout(15_000), retentionDays: 14, metadataTimeoutMs: 0 };

  await ensureTransfer(playRequest({ title: 'Movie', size: 100, infoHash: SAMPLE_HASH }), options);
  await waitFor(() => received().length === 1);
  assert.equal(received()[0]!.body.event, 'managed');
  assert.equal(received()[0]!.body.id, SAMPLE_HASH);

  await deleteManaged(downloads, backend, SAMPLE_HASH, AbortSignal.timeout(15_000));
  await waitFor(() => received().length === 2);
  assert.equal(received()[1]!.body.event, 'deleted');
  assert.equal(received()[1]!.body.id, SAMPLE_HASH);
});
