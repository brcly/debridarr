import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStreams, sizeLabel } from '../src/addon/streams.js';
import type { PlayTarget } from '../src/addon/play.js';
import { parseReleaseTitle } from '../src/search/parse.js';
import type { Candidate } from '../src/search/rank.js';

test('sizeLabel is human readable', () => {
  assert.equal(sizeLabel(0), 'size unknown');
  assert.equal(sizeLabel(512), '512 B');
  assert.equal(sizeLabel(1024 * 1024), '1.0 MB');
  assert.equal(sizeLabel(3.5 * 1024 * 1024 * 1024), '3.5 GB');
});

test('buildStreams maps ranked releases to absolute Stremio stream URLs with media identity', async () => {
  const candidate = (title: string, over: Partial<Candidate['release']> = {}): Candidate => ({
    release: { title, size: 2_147_483_648, seeders: 21, leechers: 3, indexer: 'YTS', protocol: 'torrent', guid: title, infoHash: 'c'.repeat(40), ...over },
    parsed: parseReleaseTitle(title),
  });
  let targets: PlayTarget[] = [];
  const [stream] = await buildStreams(
    [candidate('The Matrix 1999 2160p BluRay x265-GRP')],
    { type: 'movie', imdbId: 'tt0133093' },
    'https://addon.example',
    async entries => { targets = entries; return ['opaque-reference']; },
  );
  assert.equal(stream!.name, 'Debridarr 2160p');
  assert.ok(stream!.title.startsWith('The Matrix 1999 2160p BluRay x265-GRP\n'));
  assert.match(stream!.title, /2160p · bluray · 2.0 GB · 21 seed · YTS/);
  assert.match(stream!.url, /^https:\/\/addon\.example\/play\/[A-Za-z0-9_-]+$/);
  assert.equal(stream!.behaviorHints.notWebReady, true);
  assert.deepEqual(targets[0], {
    title: 'The Matrix 1999 2160p BluRay x265-GRP', size: 2_147_483_648,
    imdbId: 'tt0133093', type: 'movie', infoHash: 'c'.repeat(40),
  });
});
