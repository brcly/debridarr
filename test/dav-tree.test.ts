import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWithin, transferSlugs } from '../src/dav/tree.js';
import type { TransferFile } from '../src/application/types.js';

const file = (over: Partial<TransferFile> = {}): TransferFile => ({
  id: '0', path: 'movie.mkv', bytes: 100, progress: 1, video: true, selected: true, ...over,
});

test('transferSlugs: sanitizes, and disambiguates only on collision, deterministically', () => {
  const single = transferSlugs([{ id: 'a'.repeat(40), name: 'Movie (2024)/Cut' }]);
  assert.equal(single[0]!.slug, 'Movie (2024)_Cut', 'slashes cannot create unintended folders');

  const collide = transferSlugs([
    { id: 'a'.repeat(40), name: 'Movie' },
    { id: 'b'.repeat(40), name: 'Movie' },
  ]);
  assert.notEqual(collide[0]!.slug, collide[1]!.slug);
  assert.ok(collide.every(t => t.slug.startsWith('Movie-')));
  assert.equal(new Set(collide.map(t => t.slug)).size, 2);

  const unique = transferSlugs([{ id: 'a'.repeat(40), name: 'Movie' }, { id: 'b'.repeat(40), name: 'Other' }]);
  assert.equal(unique[0]!.slug, 'Movie', 'no collision, no suffix');

  assert.equal(transferSlugs([{ id: 'a'.repeat(40), name: '   ' }])[0]!.slug, 'transfer', 'blank name falls back');
});

test('resolveWithin: root, nested folders, and exact files from a flat eligible-files list', () => {
  const files = [
    file({ id: '0', path: 'Season 01/S01E01.mkv' }),
    file({ id: '1', path: 'Season 01/S01E02.mkv', bytes: 200 }),
    file({ id: '2', path: 'Season 02/S02E01.mkv', bytes: 300 }),
    file({ id: '3', path: 'extras/behind-the-scenes.mkv', bytes: 50 }),
  ];

  const root = resolveWithin(files, []);
  assert.equal(root?.kind, 'collection');
  const rootNames = root!.kind === 'collection' ? root.children.map(c => c.name).sort() : [];
  assert.deepEqual(rootNames, ['Season 01', 'Season 02', 'extras']);
  assert.ok(root!.kind === 'collection' && root.children.every(c => c.collection));

  const season1 = resolveWithin(files, ['Season 01']);
  assert.equal(season1?.kind, 'collection');
  const season1Names = season1!.kind === 'collection' ? season1.children.map(c => c.name).sort() : [];
  assert.deepEqual(season1Names, ['S01E01.mkv', 'S01E02.mkv']);
  assert.ok(season1!.kind === 'collection' && season1.children.every(c => !c.collection));

  const exact = resolveWithin(files, ['Season 01', 'S01E02.mkv']);
  assert.equal(exact?.kind, 'file');
  assert.equal(exact!.kind === 'file' ? exact.file.id : undefined, '1');
  assert.equal(exact!.kind === 'file' ? exact.file.bytes : undefined, 200);

  assert.equal(resolveWithin(files, ['Season 03']), undefined, 'unknown folder');
  assert.equal(resolveWithin(files, ['Season 01', 'S01E99.mkv']), undefined, 'unknown file');
  assert.equal(resolveWithin(files, ['Season 01', 'S01E01.mkv', 'extra']), undefined, 'past a file is not a folder');
});

test('resolveWithin: a flat (non-nested) file sits directly at the transfer root', () => {
  const files = [file({ id: '0', path: 'movie.mkv' })];
  const root = resolveWithin(files, []);
  assert.equal(root?.kind, 'collection');
  assert.deepEqual(root!.kind === 'collection' ? root.children.map(c => [c.name, c.collection]) : [], [['movie.mkv', false]]);
  const leaf = resolveWithin(files, ['movie.mkv']);
  assert.equal(leaf?.kind, 'file');
});

test('resolveWithin: a literal ".." segment never resolves, even nested past real folders', () => {
  const files = [file({ id: '0', path: 'Season 01/S01E01.mkv' })];
  // HTTP-layer URL normalization already collapses ".."/"%2e%2e" before a
  // request reaches this far (see dav.test.ts); this proves the second,
  // independent layer — even a literal ".." segment can only ever be
  // compared for equality against real file-path segments, never
  // interpreted as "go up a directory".
  assert.equal(resolveWithin(files, ['..']), undefined);
  assert.equal(resolveWithin(files, ['Season 01', '..', 'S01E01.mkv']), undefined);
  assert.equal(resolveWithin(files, ['..', '..', 'etc', 'passwd']), undefined);
});

test('resolveWithin: an empty eligible-files list is still a valid (empty) root folder', () => {
  const root = resolveWithin([], []);
  assert.deepEqual(root, { kind: 'collection', children: [] });
  assert.equal(resolveWithin([], ['anything']), undefined);
});
