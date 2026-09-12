import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import { CinemetaProvider } from '../src/metadata/cinemeta.js';
import { TmdbProvider } from '../src/metadata/tmdb.js';
import { createMetadataProvider, MetadataError, parseMediaId } from '../src/metadata/index.js';
import { emptySettings } from '../src/settings.js';
import { listen } from './helpers.js';

test('parseMediaId accepts movies, episodes, specials, and rejects the rest', () => {
  assert.deepEqual(parseMediaId('movie', 'tt1254207'), { type: 'movie', imdbId: 'tt1254207' });
  assert.deepEqual(parseMediaId('series', 'tt0944947:1:2'),
    { type: 'series', imdbId: 'tt0944947', season: 1, episode: 2 });
  assert.deepEqual(parseMediaId('series', 'tt0944947:0:1'),
    { type: 'series', imdbId: 'tt0944947', season: 0, episode: 1 });
  for (const [type, id] of [['movie', 'tt'], ['movie', 'nm123'], ['movie', 'tt1:1:1'],
    ['series', 'tt1254207'], ['series', 'tt1:1'], ['channel', 'tt1'], ['movie', 'tt12345678901']]) {
    assert.equal(parseMediaId(type!, id!), undefined, `${type}/${id}`);
  }
});

async function mock(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  return listen(createServer(handler), t);
}

test('Cinemeta resolves movie and series titles and maps HTTP failures to codes', async t => {
  const base = await mock(t, (request, response) => {
    if (request.url === '/meta/movie/tt1254207.json') {
      response.end(JSON.stringify({ meta: { name: 'The Matrix', year: '1999' } }));
    } else if (request.url === '/meta/series/tt0944947.json') {
      response.end(JSON.stringify({ meta: { name: 'Game of Thrones', releaseInfo: '2011-2019' } }));
    } else if (request.url === '/meta/movie/tt0000005.json') {
      response.statusCode = 500; response.end('boom');
    } else if (request.url === '/meta/movie/tt0000009.json') {
      response.end('not json');
    } else {
      response.statusCode = 404; response.end('{}');
    }
  });
  const provider = new CinemetaProvider(base);
  assert.deepEqual(await provider.resolve({ type: 'movie', imdbId: 'tt1254207' }, AbortSignal.timeout(2000)),
    { type: 'movie', imdbId: 'tt1254207', title: 'The Matrix', alternateTitles: [], year: 1999 });
  assert.deepEqual(
    await provider.resolve({ type: 'series', imdbId: 'tt0944947', season: 2, episode: 3 }, AbortSignal.timeout(2000)),
    { type: 'series', imdbId: 'tt0944947', title: 'Game of Thrones', alternateTitles: [], year: 2011, season: 2, episode: 3 });
  await assert.rejects(provider.resolve({ type: 'movie', imdbId: 'tt0000001' }, AbortSignal.timeout(2000)),
    (error: unknown) => error instanceof MetadataError && error.code === 'not_found');
  await assert.rejects(provider.resolve({ type: 'movie', imdbId: 'tt0000005' }, AbortSignal.timeout(2000)),
    (error: unknown) => error instanceof MetadataError && error.code === 'unavailable');
  await assert.rejects(provider.resolve({ type: 'movie', imdbId: 'tt0000009' }, AbortSignal.timeout(2000)),
    (error: unknown) => error instanceof MetadataError && error.code === 'unavailable');
});

test('TMDB uses the find endpoint, sends the key, and classifies auth and misses', async t => {
  const seen: string[] = [];
  const base = await mock(t, (request, response) => {
    seen.push(request.url!);
    const url = new URL(request.url!, 'http://x');
    if (url.searchParams.get('api_key') !== 'tmdb-key') { response.statusCode = 401; response.end('{}'); return; }
    if (url.pathname === '/find/tt1254207') {
      // original_title differs from the localized title: kept as an alternate.
      response.end(JSON.stringify({ movie_results: [{ title: 'The Matrix', original_title: 'The Matrix', release_date: '1999-03-31' }], tv_results: [] }));
    } else if (url.pathname === '/find/tt0944947') {
      response.end(JSON.stringify({ movie_results: [], tv_results: [{ name: 'Game of Thrones', first_air_date: '2011-04-17' }] }));
    } else if (url.pathname === '/find/tt0245429') {
      response.end(JSON.stringify({ movie_results: [{ title: 'Spirited Away', original_title: 'Sen to Chihiro no Kamikakushi', release_date: '2001-07-20' }], tv_results: [] }));
    } else {
      response.end(JSON.stringify({ movie_results: [], tv_results: [] }));
    }
  });
  const provider = new TmdbProvider('tmdb-key', base);
  assert.deepEqual(await provider.resolve({ type: 'movie', imdbId: 'tt1254207' }, AbortSignal.timeout(2000)),
    { type: 'movie', imdbId: 'tt1254207', title: 'The Matrix', alternateTitles: [], year: 1999 },
    'identical original_title is not kept as an alternate');
  assert.deepEqual(
    await provider.resolve({ type: 'series', imdbId: 'tt0944947', season: 1, episode: 1 }, AbortSignal.timeout(2000)),
    { type: 'series', imdbId: 'tt0944947', title: 'Game of Thrones', alternateTitles: [], year: 2011, season: 1, episode: 1 });
  assert.deepEqual(await provider.resolve({ type: 'movie', imdbId: 'tt0245429' }, AbortSignal.timeout(2000)),
    { type: 'movie', imdbId: 'tt0245429', title: 'Spirited Away', alternateTitles: ['Sen to Chihiro no Kamikakushi'], year: 2001 },
    'a differing original_title is kept as an alternate');
  await assert.rejects(provider.resolve({ type: 'movie', imdbId: 'tt7777777' }, AbortSignal.timeout(2000)),
    (error: unknown) => error instanceof MetadataError && error.code === 'not_found');
  assert.ok(seen.every(url => url.includes('external_source=imdb_id')));

  await assert.rejects(new TmdbProvider('', base).resolve({ type: 'movie', imdbId: 'tt1' }, AbortSignal.timeout(2000)),
    (error: unknown) => error instanceof MetadataError && error.code === 'not_configured');
  await assert.rejects(new TmdbProvider('wrong', base).resolve({ type: 'movie', imdbId: 'tt1254207' }, AbortSignal.timeout(2000)),
    (error: unknown) => error instanceof MetadataError && error.code === 'not_configured');
});

test('createMetadataProvider follows the configured provider', () => {
  const settings = emptySettings();
  assert.equal(createMetadataProvider(settings.metadata).name, 'cinemeta');
  assert.equal(createMetadataProvider({ provider: 'tmdb', tmdbApiKey: 'k' }).name, 'tmdb');
});
