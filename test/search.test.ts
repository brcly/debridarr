import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { ProwlarrClient } from '../src/integrations/prowlarr/client.js';
import type { MediaId, MetadataProvider, ResolvedTitle } from '../src/metadata/index.js';
import { buildQueries, findReleases } from '../src/search/index.js';
import { releaseMatches } from '../src/search/match.js';
import { parseReleaseTitle } from '../src/search/parse.js';
import { rankCandidates, type Candidate } from '../src/search/rank.js';
import type { Settings } from '../src/settings.js';
import { listen } from './helpers.js';

test('parseReleaseTitle reads resolution, source, codec, HDR, year, and season/episode', () => {
  assert.deepEqual(parseReleaseTitle('The Matrix 1999 2160p UHD BluRay x265-GRP'),
    { hdr: false, seasonPack: false, resolution: 2160, source: 'bluray', codec: 'x265', year: 1999, languages: [] });
  assert.deepEqual(parseReleaseTitle('Show.Name.S02E05.1080p.WEB-DL.DDP5.1.H.264-GRP'),
    { hdr: false, seasonPack: false, resolution: 1080, source: 'webdl', codec: 'x264', season: 2, episode: 5, languages: [] });
  assert.equal(parseReleaseTitle('Show Name S03 COMPLETE 720p HDTV').seasonPack, true);
  assert.equal(parseReleaseTitle('Show Name S03 COMPLETE 720p HDTV').season, 3);
  assert.equal(parseReleaseTitle('Show.Name.S01E01-E10.1080p.BluRay').seasonPack, true);
  assert.equal(parseReleaseTitle('Movie 2020 1080p BluRay DoVi HDR10').hdr, true);
});

test('parseReleaseTitle reads language tags, including dual-audio MULTI/DUAL', () => {
  assert.deepEqual(parseReleaseTitle('Movie 2020 1080p BluRay ITA ENG').languages.sort(), ['en', 'it']);
  assert.deepEqual(parseReleaseTitle('Le Film 2020 FRENCH 1080p WEB-DL').languages, ['fr']);
  assert.deepEqual(parseReleaseTitle('Movie 2020 VOSTFR 1080p').languages, ['fr']);
  assert.deepEqual(parseReleaseTitle('Der Film 2020 GERMAN 1080p').languages, ['de']);
  assert.deepEqual(parseReleaseTitle('Movie 2020 MULTI 1080p BluRay').languages, ['multi']);
  assert.deepEqual(parseReleaseTitle('Movie 2020 DUAL 1080p BluRay').languages, ['multi']);
  assert.deepEqual(parseReleaseTitle('Movie 2020 1080p BluRay').languages, [], 'untagged: no language claimed');
});

test('releaseMatches enforces title words, year proximity, and season/episode', () => {
  const movie: ResolvedTitle = { type: 'movie', imdbId: 'tt1', title: 'The Matrix', alternateTitles: [], year: 1999 };
  const ok = (releaseTitle: string, wanted = movie) =>
    releaseMatches({ releaseTitle, parsed: parseReleaseTitle(releaseTitle), wanted });
  assert.equal(ok('The Matrix 1999 1080p BluRay x264-GRP'), true);
  assert.equal(ok('The Matrix 2003 1080p'), false, 'year too far off');
  assert.equal(ok('The Matrix Reloaded 2003 1080p'), false, 'different movie, year off');
  assert.equal(ok('Completely Unrelated 1999 1080p'), false, 'missing title words');

  const episode: ResolvedTitle = { type: 'series', imdbId: 'tt2', title: 'Game of Thrones', alternateTitles: [], season: 2, episode: 3 };
  const series = (releaseTitle: string) =>
    releaseMatches({ releaseTitle, parsed: parseReleaseTitle(releaseTitle), wanted: episode });
  assert.equal(series('Game of Thrones S02E03 1080p WEB-DL'), true);
  assert.equal(series('Game of Thrones S02E04 1080p WEB-DL'), false);
  assert.equal(series('Game of Thrones S01E03 1080p WEB-DL'), false);
  assert.equal(series('Game of Thrones S02 COMPLETE 1080p'), true, 'season pack covers the episode');
  assert.equal(series('Game of Thrones S03 COMPLETE 1080p'), false, 'wrong season pack');
});

test('releaseMatches accepts a release matching only an alternate/original title', () => {
  const wanted: ResolvedTitle = { type: 'movie', imdbId: 'tt1', title: 'Spirited Away', alternateTitles: ['Sen to Chihiro no Kamikakushi'], year: 2001 };
  const ok = (releaseTitle: string) => releaseMatches({ releaseTitle, parsed: parseReleaseTitle(releaseTitle), wanted });
  assert.equal(ok('Sen to Chihiro no Kamikakushi 2001 1080p BluRay'), true, 'matches via the alternate title');
  assert.equal(ok('Spirited Away 2001 1080p BluRay'), true, 'still matches via the main title');
  assert.equal(ok('Some Other Movie 2001 1080p'), false, 'matches neither title');
  // Words from different candidate titles must not combine into a match.
  assert.equal(ok('Spirited Chihiro 2001 1080p'), false, 'no single title fully covered');
});

test('rankCandidates prefers live torrents, then resolution, then source, then seeders', () => {
  const make = (title: string, seeders: number): Candidate =>
    ({ release: { title, size: 1, seeders, leechers: 0, indexer: 'i', protocol: 'torrent', guid: title }, parsed: parseReleaseTitle(title) });
  const ordered = rankCandidates([
    make('A 720p WEB-DL', 50),
    make('B 2160p BluRay', 0),
    make('C 1080p BluRay', 5),
    make('D 1080p WEB-DL', 20),
  ]).map(candidate => candidate.release.title[0]);
  assert.deepEqual(ordered, ['C', 'D', 'A', 'B']);
});

test('buildQueries covers the episode and its season pack', () => {
  assert.deepEqual(buildQueries({ type: 'movie', imdbId: 'tt1' }, 'The Matrix', 1999), ['The Matrix 1999']);
  assert.deepEqual(buildQueries({ type: 'movie', imdbId: 'tt1' }, 'The Matrix'), ['The Matrix']);
  assert.deepEqual(buildQueries({ type: 'series', imdbId: 'tt2', season: 2, episode: 3 }, 'GoT'),
    ['GoT S02E03', 'GoT S02']);
});

test('buildQueries also searches an alternate/original title when one is given', () => {
  assert.deepEqual(buildQueries({ type: 'movie', imdbId: 'tt1' }, 'Spirited Away', 2001, 'Sen to Chihiro'),
    ['Spirited Away 2001', 'Sen to Chihiro 2001']);
  assert.deepEqual(buildQueries({ type: 'series', imdbId: 'tt2', season: 2, episode: 3 }, 'GoT', undefined, 'Alt'),
    ['GoT S02E03', 'GoT S02', 'Alt S02E03', 'Alt S02']);
});

function fakeMetadata(title: ResolvedTitle | (() => never)): MetadataProvider {
  return {
    name: 'fake',
    resolve: async () => (typeof title === 'function' ? title() : title),
  };
}

test('findReleases resolves, searches every query, dedupes, filters, and ranks', async t => {
  const base = await prowlarrMock(t, {
    'Game of Thrones S02E03': [
      release('Game of Thrones S02E03 2160p WEB-DL', { seeders: 10, infoHash: 'a'.repeat(40) }),
      release('Game of Thrones S02E03 1080p WEB-DL', { seeders: 40 }),
      release('Game of Thrones S02E03 1080p WEB-DL', { seeders: 40 }), // dupe by title+size
      release('Totally Different Show S02E03 1080p', { seeders: 99 }), // title mismatch
      { ...release('Game of Thrones S02E03 1080p usenet', { seeders: 5 }), protocol: 'usenet' },
    ],
    'Game of Thrones S02': [
      release('Game of Thrones S02E03 2160p WEB-DL', { seeders: 10, infoHash: 'a'.repeat(40) }), // dupe by infoHash
      release('Game of Thrones S02 COMPLETE 1080p BluRay', { seeders: 8 }),
    ],
  });
  const prowlarr = new ProwlarrClient({ url: base, apiKey: 'k' });
  const wanted: ResolvedTitle = { type: 'series', imdbId: 'tt2', title: 'Game of Thrones', alternateTitles: [], year: 2011, season: 2, episode: 3 };
  const results = await findReleases({ id: idOf(wanted), metadata: fakeMetadata(wanted), prowlarr, signal: AbortSignal.timeout(3000) });
  const titles = results.map(candidate => candidate.release.title);
  assert.deepEqual(titles, [
    'Game of Thrones S02E03 2160p WEB-DL',
    'Game of Thrones S02 COMPLETE 1080p BluRay',
    'Game of Thrones S02E03 1080p WEB-DL',
  ]);
  assert.equal(results.length, 3, 'usenet, mismatch, and both dupes removed');
});

test('findReleases short-circuits when Prowlarr is unconfigured and never resolves metadata', async () => {
  const prowlarr = new ProwlarrClient({ url: '', apiKey: '' });
  const metadata = fakeMetadata(() => { throw new Error('metadata should not be called'); });
  assert.deepEqual(await findReleases({ id: { type: 'movie', imdbId: 'tt1' }, metadata, prowlarr, signal: AbortSignal.timeout(1000) }), []);
});

test('findReleases tolerates a failing query and still returns the other results', async t => {
  const base = await listen(createServer((request, response) => {
    const query = new URL(request.url!, 'http://x').searchParams.get('query') ?? '';
    if (query.endsWith('S02')) { response.statusCode = 500; response.end('indexer exploded'); return; }
    response.end(JSON.stringify([release('Game of Thrones S02E03 1080p WEB-DL', { seeders: 12 })]));
  }), t);
  const prowlarr = new ProwlarrClient({ url: base, apiKey: 'k' });
  const wanted: ResolvedTitle = { type: 'series', imdbId: 'tt2', title: 'Game of Thrones', alternateTitles: [], season: 2, episode: 3 };
  const results = await findReleases({ id: idOf(wanted), metadata: fakeMetadata(wanted), prowlarr, signal: AbortSignal.timeout(3000) });
  assert.deepEqual(results.map(candidate => candidate.release.title), ['Game of Thrones S02E03 1080p WEB-DL']);
});

test('findReleases filters to an allow-set of resolutions and languages, not a cap or single value; untagged releases always pass', async t => {
  const base = await prowlarrMock(t, {
    'The Matrix 1999': [
      release('The Matrix 1999 2160p BluRay', { seeders: 10 }),       // resolution allowed
      release('The Matrix 1999 1080p BluRay', { seeders: 8 }),        // resolution allowed
      release('The Matrix 1999 720p BluRay', { seeders: 20 }),        // resolution not allowed
      release('The Matrix 1999 1080p BluRay ITA', { seeders: 30 }),   // resolution allowed, language not allowed
      release('The Matrix 1999 1080p BluRay FRENCH', { seeders: 1 }), // resolution allowed, language allowed
      release('The Matrix 1999 BluRay', { seeders: 2 }),              // untagged resolution: kept regardless
    ],
  });
  const prowlarr = new ProwlarrClient({ url: base, apiKey: 'k' });
  const wanted: ResolvedTitle = { type: 'movie', imdbId: 'tt1', title: 'The Matrix', alternateTitles: [], year: 1999 };
  const preferences: Settings['preferences'] = { resolutions: [2160, 1080], languages: ['en', 'fr'], codecs: [] };
  const results = await findReleases({ id: idOf(wanted), metadata: fakeMetadata(wanted), prowlarr, signal: AbortSignal.timeout(3000), preferences });
  assert.deepEqual(results.map(c => c.release.title), [
    'The Matrix 1999 1080p BluRay FRENCH', // matches an allowed language: ranked first
    'The Matrix 1999 2160p BluRay',
    'The Matrix 1999 1080p BluRay',
    'The Matrix 1999 BluRay', // untagged resolution never excluded
  ]);
});

test('findReleases filters to an allow-set of codecs; untagged releases always pass', async t => {
  const base = await prowlarrMock(t, {
    'The Matrix 1999': [
      release('The Matrix 1999 1080p BluRay x265', { seeders: 10 }), // codec allowed
      release('The Matrix 1999 1080p BluRay x264', { seeders: 20 }), // codec not allowed
      release('The Matrix 1999 1080p BluRay', { seeders: 5 }),       // untagged codec: kept regardless
    ],
  });
  const prowlarr = new ProwlarrClient({ url: base, apiKey: 'k' });
  const wanted: ResolvedTitle = { type: 'movie', imdbId: 'tt1', title: 'The Matrix', alternateTitles: [], year: 1999 };
  const preferences: Settings['preferences'] = { resolutions: [], languages: [], codecs: ['x265'] };
  const results = await findReleases({ id: idOf(wanted), metadata: fakeMetadata(wanted), prowlarr, signal: AbortSignal.timeout(3000), preferences });
  assert.deepEqual(results.map(c => c.release.title), [
    'The Matrix 1999 1080p BluRay x265', // codec allowed, more seeders
    'The Matrix 1999 1080p BluRay',      // untagged codec never excluded
  ]);
});

test('findReleases does not filter on language, resolution, or codec when no preferences are set', async t => {
  const base = await prowlarrMock(t, {
    'The Matrix 1999': [release('The Matrix 1999 480p BluRay ITA x264', { seeders: 20 })],
  });
  const prowlarr = new ProwlarrClient({ url: base, apiKey: 'k' });
  const wanted: ResolvedTitle = { type: 'movie', imdbId: 'tt1', title: 'The Matrix', alternateTitles: [], year: 1999 };
  const results = await findReleases({ id: idOf(wanted), metadata: fakeMetadata(wanted), prowlarr, signal: AbortSignal.timeout(3000) });
  assert.equal(results.length, 1);
});

test('rankCandidates ranks a release matching any preferred language first, and is unchanged otherwise', () => {
  const make = (title: string, seeders: number): Candidate =>
    ({ release: { title, size: 1, seeders, leechers: 0, indexer: 'i', protocol: 'torrent', guid: title }, parsed: parseReleaseTitle(title) });
  const candidates = [make('A 2160p BluRay', 50), make('B 1080p BluRay ITA', 10)];
  assert.deepEqual(rankCandidates(candidates).map(c => c.release.title[0]), ['A', 'B'], 'no preference: pure quality order');
  assert.deepEqual(rankCandidates(candidates, { languages: ['it'] }).map(c => c.release.title[0]), ['B', 'A'], 'preferred language wins over quality');
  assert.deepEqual(rankCandidates(candidates, { languages: ['de', 'it'] }).map(c => c.release.title[0]), ['B', 'A'], 'matches any language in the set');
  assert.deepEqual(rankCandidates(candidates, { languages: ['de'] }).map(c => c.release.title[0]), ['A', 'B'], 'nobody claims a preferred language: falls back to quality');
});

// helpers ---------------------------------------------------------------------

function idOf(title: ResolvedTitle): MediaId {
  return title.type === 'series'
    ? { type: 'series', imdbId: title.imdbId, season: title.season!, episode: title.episode! }
    : { type: 'movie', imdbId: title.imdbId };
}

function release(title: string, extra: { seeders: number; infoHash?: string }) {
  return {
    title, size: 1_000_000_000, seeders: extra.seeders, leechers: 1, indexer: 'mock',
    protocol: 'torrent' as const, guid: `${title}#${extra.seeders}`,
    ...(extra.infoHash ? { infoHash: extra.infoHash } : {}),
  };
}

async function prowlarrMock(t: TestContext, byQuery: Record<string, unknown[]>) {
  return listen(createServer((request, response) => {
    const query = new URL(request.url!, 'http://x').searchParams.get('query') ?? '';
    response.end(JSON.stringify(byQuery[query] ?? []));
  }), t);
}
