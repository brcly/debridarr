import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStreams, sizeLabel } from '../src/addon/streams.js';
import type { PrepareTransferRequest } from '../src/application/types.js';
import { parseReleaseTitle } from '../src/search/parse.js';
import type { Candidate } from '../src/search/rank.js';
import { playRequest } from './helpers.js';

test('sizeLabel is human readable', () => {
  assert.equal(sizeLabel(0), 'Size unknown');
  assert.equal(sizeLabel(512), '512 B');
  assert.equal(sizeLabel(1024 * 1024), '1.0 MB');
  assert.equal(sizeLabel(3.5 * 1024 * 1024 * 1024), '3.5 GB');
});

test('buildStreams maps ranked releases to absolute Stremio stream URLs with media identity', async () => {
  const candidate = (title: string, over: Partial<Candidate['release']> = {}): Candidate => ({
    release: { title, size: 2_147_483_648, seeders: 21, leechers: 3, indexer: 'YTS', protocol: 'torrent', guid: title, infoHash: 'c'.repeat(40), ...over },
    parsed: parseReleaseTitle(title),
    preferences: { languages: [] },
  });
  let targets: PrepareTransferRequest[] = [];
  const [stream] = await buildStreams(
    [candidate('The Matrix 1999 2160p BluRay x265-GRP')],
    { type: 'movie', imdbId: 'tt0133093' },
    'https://addon.example',
    async entries => { targets = entries; return ['opaque-reference']; },
  );
  assert.equal(stream!.name, 'Debridarr\n4K');
  assert.equal(stream!.title, 'The Matrix 1999 2160p BluRay x265-GRP\n🎬 BluRay · H.265 · GRP\n👤 21 · 💾 2.0 GB · ⚙️ YTS');
  assert.equal(stream!.title.split('\n').length, 3);
  assert.match(stream!.url, /^https:\/\/addon\.example\/play\/[A-Za-z0-9_-]+$/);
  assert.equal(stream!.behaviorHints.notWebReady, true);
  assert.deepEqual(targets[0], playRequest({
    title: 'The Matrix 1999 2160p BluRay x265-GRP', size: 2_147_483_648,
    imdbId: 'tt0133093', type: 'movie', infoHash: 'c'.repeat(40),
  }));
});

test('cached and fresh labels show the release name but never its file path', async () => {
  const { buildStreamList } = await import('../src/addon/streams.js');
  const title = 'The.Lost.Boys.1987.1080p.WEB-DL.H265.DDP5.1.ENG-GROUP';
  const release = { title, size: 3_000_000_000, seeders: 1600, leechers: 0, indexer: 'Example', protocol: 'torrent' as const, guid: title, infoHash: 'a'.repeat(40) };
  const issue = async (requests: PrepareTransferRequest[]) => requests.map((_, i) => `reference-${i}`);
  const [fresh] = await buildStreams([{ release, parsed: parseReleaseTitle(title), preferences: { languages: [] } }], { type: 'movie', imdbId: 'tt1' }, 'https://addon.example', issue);
  const { streams: [cached] } = await buildStreamList([{ progress: 1, request: playRequest({
    title, size: 2_990_000_000, type: 'movie', imdbId: 'tt1', infoHash: release.infoHash,
    cachedFile: { index: 0, name: 'folder/private-long-release-name.mkv', bytes: 2_990_000_000, ownerTag: 'owner' },
  }) }], [], { type: 'movie', imdbId: 'tt1' }, {
    appUrl: 'https://addon.example', issue,
  });
  assert.match(fresh!.title, /👤 1,600/);
  assert.match(fresh!.title, /🇬🇧/);
  assert.match(cached!.name, /⚡ Cached/);
  assert.match(cached!.title, /▶️ Ready to play/);
  for (const stream of [fresh!, cached!]) {
    assert.equal(stream.title.split('\n')[0], title, 'release name leads the detail block');
    assert.equal(stream.description, stream.title, 'description mirrors title for the addon SDK deprecation');
    assert.equal(stream.behaviorHints.notWebReady, true);
    assert.match(stream.behaviorHints.bingeGroup, /^debridarr-/);
    assert.doesNotMatch(stream.title, /private-long|folder|owner/, 'the on-disk file path stays server-side');
  }
});

test('series labels distinguish an episode from a season pack from a full-series torrent', async () => {
  const { streamLabel } = await import('../src/addon/presentation.js');
  const label = (name: string) => streamLabel(name, parseReleaseTitle(name), 1_000_000_000, { seeders: 5 });

  const episode = label('The Show S02E05 1080p WEB-DL x265-GRP');
  assert.equal(episode.name, 'Debridarr\n1080p · S02E05');
  assert.match(episode.title, /^The Show S02E05 1080p WEB-DL x265-GRP\n📺 /);
  assert.equal(episode.description, episode.title);

  assert.equal(label('The Show S02 COMPLETE 1080p WEB-DL x265-GRP').name, 'Debridarr\n1080p · Season 2');
  assert.equal(label('The Show COMPLETE 1080p WEB-DL x265-GRP').name, 'Debridarr\n1080p · Complete');
  assert.equal(label('The Show S01-S03 1080p WEB-DL x265-GRP').name, 'Debridarr\n1080p · Complete', 'a season span reads as full-series, not season 1');

  const movie = label('The Movie 2020 1080p BluRay x264-GRP');
  assert.equal(movie.name, 'Debridarr\n1080p');
  assert.match(movie.title, /\n🎬 /);
});
