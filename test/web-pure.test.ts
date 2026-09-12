import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadSignature, downloadTags, expiryText, formatSize, parsePathMappings } from '../web/pure.js';
import type { DownloadView } from '../web/types.js';

const DAY = 86_400_000;

function download(overrides: Partial<DownloadView> = {}): DownloadView {
  return {
    infoHash: 'abc123',
    name: 'Example',
    imdbId: 'tt1234567',
    type: 'movie',
    bytes: 1024,
    addedAt: 1,
    expiresAt: 10 * DAY,
    kept: false,
    ratio: null,
    progress: null,
    state: null,
    eta: null,
    ...overrides,
  };
}

test('parsePathMappings trims lines and marks malformed mappings incomplete', () => {
  assert.deepEqual(parsePathMappings(' /remote/a => /local/a \n\n/remote/b=>/local/b'), [
    { remote: '/remote/a', local: '/local/a' },
    { remote: '/remote/b', local: '/local/b' },
  ]);
  assert.deepEqual(parsePathMappings('/remote/only\na => b => c'), [
    { remote: '/remote/only', local: '' },
    { remote: 'a', local: '' },
  ]);
});

test('formatSize handles unknown, unit boundaries, decimals, and the largest unit', () => {
  assert.equal(formatSize(0), 'size unknown');
  assert.equal(formatSize(1023), '1023 B');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(10 * 1024), '10 KB');
  assert.equal(formatSize(2 * 1024 ** 5), '2048 TB');
});

test('downloadTags describes episodes and active or completed transfer state', () => {
  assert.equal(downloadTags(download({ type: 'series', season: 2, episode: 3, bytes: 1536, progress: 0.496, state: 'downloading' })), 'S02E03 · 1.5 KB · downloading 50%');
  assert.equal(downloadTags(download({ progress: 0.25, state: 'pausedDL' })), 'movie · 1.0 KB · paused 25%');
  assert.equal(downloadTags(download({ progress: 1, ratio: 1.236 })), 'movie · 1.0 KB · ratio 1.24');
  assert.equal(downloadTags(download({ type: null })), 'download · 1.0 KB · status unknown');
});

test('expiryText prioritizes server status and keep state, then computes whole days', () => {
  const now = 5 * DAY;
  assert.equal(expiryText(download({ retentionStatus: 'Expires after seeding' }), now), 'Expires after seeding');
  assert.equal(expiryText(download({ kept: true }), now), 'Kept — never expires');
  assert.equal(expiryText(download({ expiresAt: now + 1 }), now), 'Expires in 1 day');
  assert.equal(expiryText(download({ expiresAt: now + DAY + 1 }), now), 'Expires in 2 days');
  assert.equal(expiryText(download({ expiresAt: now }), now), 'Expiring soon');
});

test('downloadSignature changes for every field that affects an existing row', () => {
  const item = download({ lifecycle: 'managed', origin: 'store' });
  const signature = downloadSignature(item);
  for (const changed of [
    download({ name: 'Changed', lifecycle: 'managed', origin: 'store' }),
    download({ kept: true, lifecycle: 'managed', origin: 'store' }),
    download({ progress: 0.5, lifecycle: 'managed', origin: 'store' }),
    download({ ratio: 2, lifecycle: 'managed', origin: 'store' }),
    download({ state: 'paused', lifecycle: 'managed', origin: 'store' }),
    download({ lifecycle: 'failed', origin: 'store' }),
    download({ failure: 'metadata', lifecycle: 'managed', origin: 'store' }),
    download({ retentionStatus: 'Queued', lifecycle: 'managed', origin: 'store' }),
    download({ expiresAt: 99, lifecycle: 'managed', origin: 'store' }),
    download({ lifecycle: 'managed', origin: 'search' }),
  ]) assert.notEqual(downloadSignature(changed), signature);
});
