import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TorrentFile } from '../src/backends/torrent.js';
import { pickFile } from '../src/downloads/pick.js';

const file = (name: string, size: number, over: Partial<TorrentFile> = {}): TorrentFile =>
  ({ id: 0, path: name, bytes: size, progress: 0, selected: true, ...over });

test('movies pick the largest playable video and skip samples and extras', () => {
  const files = [
    file('Movie.2020.1080p/movie.mkv', 8_000_000_000, { id: 0 }),
    file('Movie.2020.1080p/sample.mkv', 50_000_000, { id: 1 }),
    file('Movie.2020.1080p/Extras/deleted-scene.mkv', 9_000_000_000, { id: 2 }),
    file('Movie.2020.1080p/readme.txt', 1000, { id: 3 }),
  ];
  assert.equal(pickFile(files, { type: 'movie' })?.id, 0);
});

test('series pick the file matching the wanted season and episode', () => {
  const files = [
    file('Show.S02/Show.S02E01.mkv', 1_000_000_000, { id: 0 }),
    file('Show.S02/Show.S02E02.mkv', 1_100_000_000, { id: 1 }),
    file('Show.S02/Show.S02E03.mkv', 1_050_000_000, { id: 2 }),
  ];
  assert.equal(pickFile(files, { type: 'series', season: 2, episode: 2 })?.id, 1);
  assert.equal(pickFile(files, { type: 'series', season: 2, episode: 9 }), undefined, 'no such episode in a pack');
});

test('a single-video torrent is used even when the name lacks SxxExx', () => {
  const files = [
    file('random.release.name.mkv', 1_200_000_000, { id: 0 }),
    file('random.release.name.nfo', 500, { id: 1 }),
  ];
  assert.equal(pickFile(files, { type: 'series', season: 3, episode: 7 })?.id, 0);
});

test('no playable video yields undefined', () => {
  assert.equal(pickFile([file('cover.jpg', 1000), file('info.nfo', 500)], { type: 'movie' }), undefined);
});
