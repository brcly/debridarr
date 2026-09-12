import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildManifest } from '../src/addon/manifest.js';
import { catalogExtras, libraryMeta, libraryMetas } from '../src/addon/library.js';
import { isPrepareTransferRequest, type Transfer } from '../src/application/types.js';

const HASH = 'b'.repeat(40);

const item = (over: Partial<Transfer> = {}): Transfer => ({
  id: HASH, name: 'Some.Pack.2021.1080p.WEB-DL', bytes: 100, addedAt: 1, expiresAt: 2, kept: false, lifecycle: 'managed', ...over,
});

test('buildManifest advertises db catalog/meta only outside search mode', () => {
  const search = buildManifest('search');
  assert.deepEqual(search.catalogs, []);
  assert.deepEqual(search.resources, [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] }]);

  for (const mode of ['store', 'both'] as const) {
    const m = buildManifest(mode);
    assert.deepEqual(m.catalogs, [{
      type: 'other', id: 'debridarr-library', name: 'Debridarr Library',
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }],
    }]);
    assert.deepEqual(m.types, ['movie', 'series', 'other']);
    assert.deepEqual(m.resources, [
      { name: 'stream', types: ['movie', 'series', 'other'], idPrefixes: ['tt', 'db'] },
      { name: 'meta', types: ['other'], idPrefixes: ['db'] },
    ]);
  }
});

test('isPrepareTransferRequest guards persisted playback references', () => {
  const file = { id: 0, path: 'movie.mkv', bytes: 10, marker: 'own' };
  assert.equal(isPrepareTransferRequest({ source: { infoHash: HASH }, origin: 'search', name: 'x', bytes: 10, media: { imdbId: 'tt1', type: 'movie' } }), true);
  assert.equal(isPrepareTransferRequest({ source: { magnet: `magnet:?xt=urn:btih:${HASH}` }, origin: 'search', name: 'x', bytes: 0 }), true);
  assert.equal(isPrepareTransferRequest({ source: { infoHash: HASH }, origin: 'store', name: 'x', bytes: 10, selection: { file, behavior: 'require-existing' } }), true);
  assert.equal(isPrepareTransferRequest({ source: { torrent: Buffer.from('x') }, origin: 'store', name: 'x', bytes: 1 }), false, 'raw torrent bytes are not persistable');
  assert.equal(isPrepareTransferRequest({ origin: 'search', name: 'x', bytes: 1 }), false, 'a source is required');
  assert.equal(isPrepareTransferRequest({ source: { infoHash: HASH }, origin: 'search', name: 'x', bytes: 1, media: { imdbId: 'tt1', type: 'series' } }), false, 'a series needs season and episode');
  assert.equal(isPrepareTransferRequest({ source: { infoHash: HASH }, origin: 'search', name: 'x', bytes: 1, selection: { file: { ...file, bytes: 0 }, behavior: 'allow-select' } }), false);
});

test('libraryMetas / libraryMeta map store items to db: catalog rows', () => {
  const items = [item(), item({ id: 'c'.repeat(40), name: 'Linked', media: { imdbId: 'tt7', type: 'movie' } })];
  const { metas } = libraryMetas(items);
  assert.deepEqual(metas[0], { id: `db:${HASH}`, type: 'other', name: 'Some.Pack.2021.1080p.WEB-DL', posterShape: 'square' });
  assert.equal((metas[1] as { description?: string }).description, 'Linked to tt7');

  assert.equal(libraryMeta(items, 'db:not-a-hash'), undefined);
  assert.equal(libraryMeta(items, `db:${'d'.repeat(40)}`), undefined);
  const meta = libraryMeta(items, `db:${HASH}`)?.meta as {
    name: string;
    behaviorHints?: { defaultVideoId: string };
    videos?: { id: string; title: string; released: string }[];
  };
  assert.equal(meta.name, 'Some.Pack.2021.1080p.WEB-DL');
  assert.equal(meta.behaviorHints?.defaultVideoId, `db:${HASH}`);
  assert.equal(meta.videos?.length, 1);
  assert.equal(meta.videos?.[0]?.id, `db:${HASH}`);
  assert.equal(meta.videos?.[0]?.title, 'Some.Pack.2021.1080p.WEB-DL');
  assert.equal(meta.videos?.[0]?.released, new Date(1).toISOString());
});

test('library catalog extras skip and search', () => {
  const items = [
    item(),
    item({ id: 'c'.repeat(40), name: 'Linked', media: { imdbId: 'tt7', type: 'movie' } }),
  ];
  assert.deepEqual(catalogExtras(undefined), { skip: 0, search: '' });
  assert.deepEqual(catalogExtras('skip=1&search=Linked'), { skip: 1, search: 'Linked' });
  assert.equal(libraryMetas(items, { skip: 1 }).metas.length, 1);
  assert.equal(libraryMetas(items, { skip: 1 }).metas[0]?.name, 'Linked');
  assert.equal(libraryMetas(items, { search: 'linked' }).metas.length, 1);
  assert.equal(libraryMetas(items, { search: 'missing' }).metas.length, 0);
});
