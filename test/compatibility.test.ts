import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { appFixture } from './app-fixture.js';
import { SAMPLE_HASH as HASH } from './fake-qbt.js';

// Pinned consumer clients for Stage 7.6. Source-verified against these tags;
// a deployed Comet/AIOStreams stack is not part of this suite.
const COMET = 'v2.58.0';
const AIOSTREAMS = 'v2.34.0';

async function fixture(t: TestContext, mode: 'search' | 'store' | 'both' = 'store') {
  const f = await appFixture(t, {
    prefix: 'debridarr-compat-',
    mode,
    tokenName: 'Compat',
    files: [{ index: 0, name: 'movie.mkv', size: 100, progress: 1, priority: 1 }],
  });
  return { base: f.base, token: f.token, access: f.access, addon: f.access.base(f.base) };
}

test('Stremio addon protocol: search-mode manifest, empty streams, CORS, and store-mode catalog/meta/stream', async t => {
  const search = await fixture(t, 'search');
  const manifest = await fetch(`${search.addon}/manifest.json`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get('access-control-allow-origin'), '*');
  const body = await manifest.json() as {
    id: string; version: string; resources: unknown[]; catalogs: unknown[]; types: string[];
    behaviorHints: { configurable: boolean; configurationRequired: boolean };
  };
  assert.equal(body.id, 'org.debridarr.addon');
  assert.equal(typeof body.version, 'string');
  assert.deepEqual(body.types, ['movie', 'series']);
  assert.deepEqual(body.catalogs, []);
  assert.deepEqual(body.resources, [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] }]);
  assert.equal(body.behaviorHints.configurable, true);
  assert.equal(body.behaviorHints.configurationRequired, false);

  for (const path of ['/stream/movie/tt1254207.json', '/stream/series/tt0944947:1:1.json']) {
    const streams = await fetch(`${search.addon}${path}`);
    assert.equal(streams.status, 200, path);
    assert.deepEqual(await streams.json(), { streams: [] });
  }

  const store = await fixture(t, 'store');
  const storeManifest = await (await fetch(`${store.addon}/manifest.json`)).json() as {
    types: string[]; catalogs: { type: string; id: string }[]; resources: { name: string; idPrefixes: string[] }[];
  };
  assert.deepEqual(storeManifest.types, ['movie', 'series', 'other']);
  assert.equal(storeManifest.catalogs[0]?.id, 'debridarr-library');
  assert.ok(storeManifest.resources.some(r => r.name === 'stream' && r.idPrefixes.includes('db')));
  assert.ok(storeManifest.resources.some(r => r.name === 'meta' && r.idPrefixes.includes('db')));

  const added = await fetch(`${store.base}/store/v1/magnets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${store.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ magnet: `magnet:?xt=urn:btih:${HASH}&dn=Movie.1080p` }),
  });
  assert.equal(added.status, 201);

  const catalog = await (await fetch(`${store.addon}/catalog/other/debridarr-library.json`)).json() as { metas: { id: string; type: string; name: string }[] };
  assert.equal(catalog.metas.length, 1);
  assert.equal(catalog.metas[0]!.id, `db:${HASH}`);
  assert.equal(catalog.metas[0]!.type, 'other');

  const skipped = await (await fetch(`${store.addon}/catalog/other/debridarr-library/skip=1.json`)).json() as { metas: unknown[] };
  assert.equal(skipped.metas.length, 0);
  const searched = await (await fetch(`${store.addon}/catalog/other/debridarr-library/search=Movie.json`)).json() as { metas: { name: string }[] };
  assert.equal(searched.metas.length, 1);
  assert.match(searched.metas[0]!.name, /Movie/);
  const missed = await (await fetch(`${store.addon}/catalog/other/debridarr-library/search=nope.json`)).json() as { metas: unknown[] };
  assert.equal(missed.metas.length, 0);

  const meta = await (await fetch(`${store.addon}/meta/other/db:${HASH}.json`)).json() as { meta: { id: string; type: string; name: string } };
  assert.equal(meta.meta.id, `db:${HASH}`);
  assert.equal(meta.meta.type, 'other');

  const streams = await (await fetch(`${store.addon}/stream/other/db:${HASH}.json`)).json() as {
    streams: { name: string; title: string; description: string; url: string; behaviorHints: { notWebReady: boolean; bingeGroup: string } }[];
  };
  assert.equal(streams.streams.length, 1);
  const stream = streams.streams[0]!;
  assert.equal(stream.description, stream.title);
  assert.match(stream.url, /\/api\/v1\/download\//);
  assert.equal(stream.behaviorHints.notWebReady, true);
  assert.match(stream.behaviorHints.bingeGroup, /^debridarr-store-/);
});

test(`Comet ${COMET} StremThru client: header-only auth, client_ip/sid query, premium stub, 500-hash batch`, async t => {
  const { base, token } = await fixture(t, 'store');
  const comet = (path: string) => fetch(`${base}${path}`, {
    headers: {
      'X-StremThru-Store-Name': 'realdebrid',
      'X-StremThru-Store-Authorization': `Bearer ${token}`,
    },
  });

  const user = await comet(`/v0/store/user?client_ip=203.0.113.1`);
  assert.equal(user.status, 200);
  assert.equal((await user.json()).data.subscription_status, 'premium');

  const check = await comet(`/v0/store/magnets/check?magnet=${HASH}&client_ip=203.0.113.1&sid=tt0133093`);
  assert.equal(check.status, 200);
  assert.equal((await check.json()).data.items[0]!.status, 'unknown');

  const hashes = Array.from({ length: 500 }, (_, i) => i.toString(16).padStart(40, '0'));
  const batch = await comet(`/v0/store/magnets/check?magnet=${hashes.join(',')}`);
  assert.equal(batch.status, 200);
  assert.equal((await batch.json()).data.items.length, 500);

  const listed = await comet(`/v0/store/magnets?limit=500&offset=0&client_ip=203.0.113.1`);
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).data.total_items, 0);
});

test(`AIOStreams ${AIOSTREAMS} uses the same StremThru magnet Store v0 contract as the pinned SDK`, async t => {
  // AIOStreams v2.34.0 depends on stremthru ^0.11.0 and talks through StremThruService
  // (packages/core/src/debrid/stremthru.ts). The official SDK at 0.13.0 is exercised in
  // test/store-api.test.ts; this check locks the service-slot wiring those clients share.
  const { base, token } = await fixture(t, 'store');
  const add = await fetch(`${base}/v0/store/magnets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ magnet: `magnet:?xt=urn:btih:${HASH}` }),
  });
  assert.equal(add.status, 200);
  const item = (await add.json()).data as { id: string; hash: string; status: string; files: { link: string; name: string; path: string; size: number; index: number }[] };
  assert.equal(item.hash, HASH);
  assert.equal(item.status, 'downloaded');
  assert.equal(item.files[0]!.index, 0);
  assert.match(item.files[0]!.link, /^debridarr:/);

  const link = await fetch(`${base}/v0/store/link/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ link: item.files[0]!.link }),
  });
  assert.equal(link.status, 200);
  assert.match((await link.json()).data.link, /\/api\/v1\/download\//);
});
