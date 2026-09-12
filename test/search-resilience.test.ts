import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStreams, buildStreamList } from '../src/addon/streams.js';
import { AddonAccess } from '../src/security/addon.js';
import { parseReleaseTitle } from '../src/search/parse.js';
import type { Candidate } from '../src/search/rank.js';
import { playRequest, requestHash, tmpDir } from './helpers.js';
import { findReleases, type DiscoverySource } from '../src/search/index.js';
import { ProwlarrClient } from '../src/integrations/prowlarr/client.js';

const id = { type: 'movie' as const, imdbId: 'tt1' };
const candidate = (title: string, source: Partial<Candidate['release']> = {}): Candidate => ({
  parsed: parseReleaseTitle(title),
  release: { title, size: 100, seeders: 1, leechers: 0, indexer: 'fixture', protocol: 'torrent', guid: title, ...source },
  preferences: { languages: [] },
});
const origin = (source: ProwlarrClient): DiscoverySource => ({ source, preferences: { languages: [], resolutions: [], codecs: [] } });

test('one source-less or oversized indexer result cannot discard playable streams or cached copies', async t => {
  const dir = await tmpDir(t, 'debridarr-results');
  const access = await AddonAccess.open(dir);
  let writes = 0;
  const issue = (targets: Parameters<AddonAccess['issue']>[0]) => { writes++; return access.issue(targets, 'fixture'); };
  const results = [candidate('Film 2026 2160p'), candidate('Film 2026 1080p', { infoHash: 'a'.repeat(40) }),
    candidate('Film 2026 720p', { downloadUrl: 'https://fixture/' + 'x'.repeat(17000) })];
  const streams = await buildStreams(results, id, 'https://addon.example', issue);
  assert.equal(streams.length, 1);
  assert.equal(requestHash(access.get(streams[0]!.url.split('/').at(-1)!, 'fixture')), 'a'.repeat(40));
  writes = 0;
  const combined = await buildStreamList([{ progress: 1, request: playRequest({ ...id, title: 'Film', size: 100, infoHash: 'b'.repeat(40),
    cachedFile: { index: 0, name: 'film.mkv', bytes: 100, ownerTag: 'owner' } }) }], results, id, {
    appUrl: 'https://addon.example', issue,
  });
  assert.equal(combined.streams.length, 2);
  assert.equal(writes, 1, 'cached and fresh references share one write');
  assert.deepEqual(combined.streams.map(stream => requestHash(access.get(stream.url.split('/').at(-1)!, 'fixture'))), ['b'.repeat(40), 'a'.repeat(40)]);
  assert.match(combined.streams[0]!.name, /Cached/);
});

test('an earlier rejected alias does not hide a matching release with the same hash', async () => {
  class QbtSearch extends ProwlarrClient {
    override async search() { return [candidate('Unrelated 2026', { infoHash: 'a'.repeat(40) }).release,
      candidate('Film 2026', { infoHash: 'a'.repeat(40) }).release]; }
  }
  const results = await findReleases({ id, sources: [origin(new QbtSearch({ url: 'http://fixture', apiKey: 'fixture' }))], signal: AbortSignal.timeout(1000),
    metadata: { name: 'fixture', resolve: async () => ({ ...id, title: 'Film', year: 2026, alternateTitles: [] }) } });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.release.title, 'Film 2026');
});

test('unusable high-ranked entries neither consume the result limit nor suppress a usable duplicate', async () => {
  const good = candidate('Film 2026 1080p', { infoHash: 'a'.repeat(40) }).release;
  const rows = [candidate('Film 2026 2160p', { infoHash: 'a'.repeat(40), downloadUrl: 'https://fixture/' + 'x'.repeat(17000) }).release,
    ...Array.from({ length: 40 }, (_, i) => candidate(`Film 2026 2160p group${i}`).release), good];
  class Search extends ProwlarrClient { override async search() { return rows; } }
  const results = await findReleases({ id, sources: [origin(new Search({ url: 'http://fixture', apiKey: 'fixture' }))], signal: AbortSignal.timeout(1000), limit: 1,
    metadata: { name: 'fixture', resolve: async () => ({ ...id, title: 'Film', year: 2026, alternateTitles: [] }) } });
  assert.deepEqual(results.map(entry => entry.release), [good]);
});

test('the result cap never drops the season pack behind a wall of single episodes', async () => {
  const seriesId = { type: 'series' as const, imdbId: 'tt1', season: 4, episode: 1 };
  const episodes = Array.from({ length: 40 }, (_, i) =>
    candidate(`Evil S04E01 1080p WEB-DL grp${i}`, { seeders: 500 + i, infoHash: i.toString(16).padStart(40, '0') }).release);
  const pack = candidate('Evil S04 1080p WEB-DL PSA', { seeders: 1, infoHash: 'b'.repeat(40) }).release; // low seeders: ranked last
  class Search extends ProwlarrClient { override async search() { return [...episodes, pack]; } }
  const results = await findReleases({
    id: seriesId, sources: [origin(new Search({ url: 'http://fixture', apiKey: 'fixture' }))], signal: AbortSignal.timeout(1000), limit: 5,
    metadata: { name: 'fixture', resolve: async () => ({ ...seriesId, title: 'Evil', year: 2019, alternateTitles: [] }) },
  });
  assert.equal(results.length, 5);
  assert.equal(results.at(-1)!.release.title, 'Evil S04 1080p WEB-DL PSA', 'the pack takes the last slot rather than being cut');
});
