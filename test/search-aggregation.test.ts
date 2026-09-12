import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DiscoveryProviderPreferences } from '../src/discovery/config.js';
import { configuredDiscoverySources } from '../src/discovery/registry.js';
import type { Release, ReleaseSource } from '../src/discovery/source.js';
import { ConnectionError } from '../src/integrations/http.js';
import { ProwlarrClient } from '../src/integrations/prowlarr/client.js';
import { TorznabClient } from '../src/integrations/torznab/client.js';
import type { MetadataProvider, ResolvedTitle } from '../src/metadata/index.js';
import { findReleases, type DiscoverySource } from '../src/search/index.js';

const id = { type: 'series' as const, imdbId: 'tt2', season: 2, episode: 3 };
const wanted: ResolvedTitle = { ...id, title: 'Game of Thrones', alternateTitles: [], year: 2011 };
const metadata: MetadataProvider = { name: 'fixture', resolve: async () => wanted };

const release = (title: string, extra: Partial<Release> = {}): Release => ({
  title, size: 1_000_000_000, seeders: 1, leechers: 0, indexer: 'fixture', protocol: 'torrent', guid: title, ...extra,
});
const stub = (results: () => Release[], log: string[], name: string, configured = true): ReleaseSource => ({
  configured,
  test: async () => { throw new Error('unused'); },
  search: async query => { log.push(`${name}:${query}`); return results(); },
});
const noPreferences: DiscoveryProviderPreferences = { languages: [], resolutions: [], codecs: [] };
const origin = (source: ReleaseSource, preferences: DiscoveryProviderPreferences = noPreferences): DiscoverySource => ({ source, preferences });

test('findReleases queries every configured source and merges and dedupes their results', async () => {
  const log: string[] = [];
  const episode = release('Game of Thrones S02E03 1080p WEB-DL', { infoHash: 'a'.repeat(40), seeders: 10 });
  const sources = [
    origin(stub(() => [episode], log, 'prowlarr')),
    origin(stub(() => [
      episode, // same infoHash: duplicate across sources
      release('Game of Thrones S02 COMPLETE 1080p BluRay', { infoHash: 'b'.repeat(40), seeders: 8 }),
    ], log, 'torznab')),
  ];
  const results = await findReleases({ id, metadata, sources, signal: AbortSignal.timeout(1000) });
  assert.deepEqual(results.map(candidate => candidate.release.title), [
    'Game of Thrones S02 COMPLETE 1080p BluRay', // a downloadable pack outranks single episodes
    'Game of Thrones S02E03 1080p WEB-DL',
  ]);
  assert.deepEqual([...log].sort(), [
    'prowlarr:Game of Thrones S02', 'prowlarr:Game of Thrones S02E03',
    'torznab:Game of Thrones S02', 'torznab:Game of Thrones S02E03',
  ], 'both sources run every query');
});

test('unconfigured sources are skipped, and none configured short-circuits before metadata', async () => {
  const quiet: MetadataProvider = { name: 'fixture', resolve: async () => { throw new Error('metadata must not resolve'); } };
  assert.deepEqual(await findReleases({ id, metadata: quiet, sources: [], signal: AbortSignal.timeout(100) }), []);
  const log: string[] = [];
  const sources = [
    origin(stub(() => [release('Game of Thrones S02E03 1080p')], log, 'off', false)),
    origin(stub(() => [release('Game of Thrones S02E03 1080p WEB-DL', { infoHash: 'c'.repeat(40) })], log, 'on')),
  ];
  const results = await findReleases({ id, metadata, sources, signal: AbortSignal.timeout(1000) });
  assert.deepEqual(results.map(candidate => candidate.release.guid), ['Game of Thrones S02E03 1080p WEB-DL']);
  assert.ok(log.length > 0 && log.every(entry => entry.startsWith('on:')), 'the unconfigured source is never queried');
});

test('a failing source cannot hide the results of the others', async () => {
  const broken: ReleaseSource = {
    configured: true,
    test: async () => { throw new Error('unused'); },
    search: async () => { throw new ConnectionError('unreachable'); },
  };
  const fine = stub(() => [release('Game of Thrones S02E03 1080p WEB-DL', { infoHash: 'd'.repeat(40) })], [], 'fine');
  const results = await findReleases({ id, metadata, sources: [origin(broken), origin(fine)], signal: AbortSignal.timeout(1000) });
  assert.deepEqual(results.map(candidate => candidate.release.guid), ['Game of Thrones S02E03 1080p WEB-DL']);
});

test('usenet releases are dropped unless the caller accepts the usenet protocol', async () => {
  const nzb = release('Game of Thrones S02E03 1080p WEB-DL', { protocol: 'usenet', downloadUrl: 'http://indexer.test/get?id=1', seeders: 0 });
  const torrent = release('Game of Thrones S02E03 720p WEB-DL', { protocol: 'torrent', infoHash: 'e'.repeat(40), seeders: 4 });
  const sources = [origin(stub(() => [nzb, torrent], [], 'both'))];
  const torrentOnly = await findReleases({ id, metadata, sources, signal: AbortSignal.timeout(1000) });
  assert.deepEqual(torrentOnly.map(c => c.release.protocol), ['torrent']);
  const usenetOnly = await findReleases({ id, metadata, sources, signal: AbortSignal.timeout(1000), protocols: ['usenet'] });
  assert.deepEqual(usenetOnly.map(c => c.release.protocol), ['usenet']);
  assert.equal(usenetOnly[0]!.release.infoHash, undefined);
});

test('configuredDiscoverySources maps each provider to a source carrying its own preferences', () => {
  const sources = configuredDiscoverySources({ discovery: { providers: [
    { id: 'p1', type: 'prowlarr', url: 'http://prowlarr:9696', apiKey: 'k', preferences: { languages: ['fr'], resolutions: [1080], codecs: [] } },
    { id: 't1', type: 'torznab', url: '', apiKey: '', preferences: noPreferences },
  ] } });
  assert.ok(sources[0]!.source instanceof ProwlarrClient && sources[1]!.source instanceof TorznabClient);
  assert.deepEqual(sources.map(entry => entry.source.configured), [true, false], 'a provider without a URL stays unconfigured');
  assert.deepEqual(sources[0]!.preferences, { languages: ['fr'], resolutions: [1080], codecs: [] });
  assert.deepEqual(sources[1]!.preferences, noPreferences);
});
