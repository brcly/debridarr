import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { pollSavedSearches } from '../src/rss/poll.js';
import { savedSearchStatus } from '../src/rss/state.js';
import { appFixture } from './app-fixture.js';
import { listen } from './helpers.js';

interface FeedItem { title: string; guid: string; magnet: string }

function rssXml(items: FeedItem[]): string {
  const body = items.map(item => `<item><title>${item.title}</title><guid>${item.guid}</guid><link>${item.magnet}</link></item>`).join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${body}</channel></rss>`;
}

// A minimal Torznab-shaped RSS server whose item list the test controls,
// mirroring how a saved search would point at a real indexer's feed.
async function testFeed(t: TestContext, initial: FeedItem[]): Promise<{ url: string; setItems: (items: FeedItem[]) => void }> {
  let items = initial;
  const base = await listen(createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/rss+xml');
    response.end(rssXml(items));
  }), t);
  return { url: `${base}/rss?t=search&apikey=k3y`, setItems: next => { items = next; } };
}

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const magnet = (hash: string, name: string) => `magnet:?xt=urn:btih:${hash}&dn=${name}`;

test('a local RSS fixture adds one magnet; duplicates are skipped; disabling the search stops adds', async t => {
  const f = await appFixture(t, { prefix: 'debridarr-rss-' });
  const feed = await testFeed(t, [{ title: 'Movie.2024.1080p', guid: 'guid-1', magnet: magnet(HASH_A, 'Movie') }]);

  const saved = await f.settings.update({ rss: { searches: [{ feedUrl: feed.url, protocol: 'torrent' }] } });
  const searchId = saved.rss.searches[0]!.id;

  await pollSavedSearches({ store: f.settings, downloads: f.downloads });
  assert.equal(f.downloads.list().length, 1);
  assert.equal(f.downloads.get(HASH_A)?.origin, 'store');
  const status = savedSearchStatus(searchId);
  assert.ok(status?.lastPolledAt);
  assert.equal(status?.lastError, undefined);
  assert.deepEqual(status?.items.map(item => [item.guid, item.status]), [['guid-1', 'added']]);

  // The same item is still in the feed on the next poll — no re-add attempt.
  await pollSavedSearches({ store: f.settings, downloads: f.downloads });
  assert.equal(f.downloads.list().length, 1);
  assert.equal(savedSearchStatus(searchId)?.items.length, 1);

  // A new item appears, but the search is now disabled: no add happens.
  feed.setItems([
    { title: 'Movie.2024.1080p', guid: 'guid-1', magnet: magnet(HASH_A, 'Movie') },
    { title: 'Other.2024.720p', guid: 'guid-2', magnet: magnet(HASH_B, 'Other') },
  ]);
  await f.settings.update({ rss: { searches: [{ id: searchId, feedUrl: feed.url, protocol: 'torrent', enabled: false }] } });
  await pollSavedSearches({ store: f.settings, downloads: f.downloads });
  assert.equal(f.downloads.list().length, 1, 'disabling the search stops adds even for a brand-new item');
  assert.equal(savedSearchStatus(searchId)?.items.length, 1, 'a disabled search does not poll at all');
});

test('titleExclude drops a matching item before it is ever recorded, while other items still add', async t => {
  const f = await appFixture(t, { prefix: 'debridarr-rss-filter-' });
  const feed = await testFeed(t, [
    { title: 'Movie.CAM.720p', guid: 'guid-cam', magnet: magnet(HASH_A, 'Movie') },
    { title: 'Movie.2024.1080p', guid: 'guid-good', magnet: magnet(HASH_B, 'Movie') },
  ]);
  const saved = await f.settings.update({ rss: { searches: [{ feedUrl: feed.url, protocol: 'torrent', titleExclude: 'CAM' }] } });
  const searchId = saved.rss.searches[0]!.id;

  await pollSavedSearches({ store: f.settings, downloads: f.downloads });
  assert.equal(f.downloads.list().length, 1);
  assert.equal(f.downloads.get(HASH_B)?.origin, 'store');
  assert.equal(f.downloads.get(HASH_A), undefined, 'the excluded title was never attempted');
  // Excluded items are not recorded at all — they were never candidates.
  assert.deepEqual(savedSearchStatus(searchId)?.items.map(item => item.guid), ['guid-good']);
});

test('Search-only mode skips polling entirely', async t => {
  const f = await appFixture(t, { prefix: 'debridarr-rss-search-mode-', mode: 'search' });
  const feed = await testFeed(t, [{ title: 'Movie.2024.1080p', guid: 'guid-1', magnet: magnet(HASH_A, 'Movie') }]);
  const saved = await f.settings.update({ rss: { searches: [{ feedUrl: feed.url, protocol: 'torrent' }] } });
  const searchId = saved.rss.searches[0]!.id;

  await pollSavedSearches({ store: f.settings, downloads: f.downloads });
  assert.equal(f.downloads.list().length, 0);
  assert.equal(savedSearchStatus(searchId), undefined, 'a search-only instance never even attempts the feed');
});
