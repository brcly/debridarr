import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { parseInfoHash } from '../src/downloads/torrentFile.js';
import { verifyLink } from '../src/api/v1/links.js';
import { appFixture } from './app-fixture.js';
import { SAMPLE_HASH as HASH, SAMPLE_TORRENT as TORRENT } from './fake-qbt.js';
import { RealDebridError, RealDebridRestClient } from './realdebrid-client.js';

async function fixture(t: TestContext) {
  const f = await appFixture(t, { prefix: 'debridarr-rd-', tokenName: 'RD' });
  return {
    base: f.base, token: f.token, client: new RealDebridRestClient(f.base, f.token),
    settings: f.settings, tokens: f.tokens, setFilesReady: f.qbt.setFilesReady,
  };
}

test('pinned REST 1.0 client completes user, addMagnet, info, selectFiles, unrestrict and delete', async t => {
  const { base, client, tokens } = await fixture(t);
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json() as { info: { description: string } };
  assert.match(spec.info.description, /Real-Debrid/);
  const user = await client.user();
  assert.equal(user.type, 'premium');
  assert.ok(user.premium > 0);
  assert.equal(user.username, 'RD');
  assert.deepEqual(await client.availableHosts(), [{ host: 'debridarr.local', max_file_size: 2147483647 }]);

  const added = await client.addMagnet(`magnet:?xt=urn:btih:${HASH}&dn=Movie`);
  assert.equal(added.id, HASH);
  assert.equal(added.uri, `/rest/1.0/torrents/info/${HASH}`);

  const info = await client.torrentInfo(HASH);
  assert.equal(info.hash, HASH);
  assert.equal(info.status, 'downloaded');
  assert.equal(info.progress, 100);
  assert.ok(info.files.some(f => f.id === 1 && f.path === '/movie.mkv' && f.selected === 1));
  assert.equal(info.files.find(f => f.path.endsWith('readme.nfo'))?.id, 3);
  assert.ok(info.links[0]?.startsWith('https://debridarr.local/d/'));

  await client.selectFiles(HASH, 'all');
  const unrestricted = await client.unrestrict(info.links[0]!);
  assert.match(unrestricted.download, /^https:\/\/public\.example\/api\/v1\/download\/[\w-]+\.[\w-]+$/);
  assert.equal(unrestricted.streamable, 1);
  assert.equal(verifyLink(tokens.linkSecret(), unrestricted.download.split('/').at(-1)!, Date.now())?.fileId, 0);

  const listed = await client.torrents();
  assert.equal(listed.length, 1);
  assert.equal(listed.totalCount, 1);
  assert.equal((await client.activeCount()).nb, 0);

  await client.delete(HASH);
  await assert.rejects(client.torrentInfo(HASH), (e: unknown) => e instanceof RealDebridError && e.status === 404 && e.errorCode === 7);
});

test('addTorrent PUT, infohash add, pagination, aliases and X-HTTP-Verb match the published schema', async t => {
  const { base, token, client } = await fixture(t);
  const torrentHash = parseInfoHash(TORRENT)!;
  const uploaded = await client.addTorrent(TORRENT);
  assert.equal(uploaded.id, torrentHash);
  const hashed = await client.addMagnet(HASH);
  assert.equal(hashed.id, HASH);

  const page = await client.torrents({ limit: 1 });
  assert.equal(page.length, 1);
  assert.equal(page.totalCount, 2);
  assert.equal((await client.torrents({ offset: 1, limit: 1 })).length, 1);
  assert.equal((await client.torrents({ page: 2, limit: 1 })).length, 1);

  const short = new RealDebridRestClient(base, token, '/store/realdebrid');
  assert.equal((await short.user()).type, 'premium');
  const nested = new RealDebridRestClient(base, token, '/store/realdebrid/rest/1.0');
  assert.equal((await nested.torrentInfo(HASH)).id, HASH);

  await short.verb('DELETE', `/torrents/delete/${HASH}`);
  await assert.rejects(client.torrentInfo(HASH), (e: unknown) => e instanceof RealDebridError && e.errorCode === 7);
});

test('registering torrents report magnet_conversion; selectFiles stays 204 after auto-start', async t => {
  const { client, setFilesReady } = await fixture(t);
  setFilesReady(false);
  const added = await client.addMagnet(`magnet:?xt=urn:btih:${HASH}`);
  assert.equal(added.id, HASH);
  const info = await client.torrentInfo(HASH);
  assert.equal(info.status, 'magnet_conversion');
  setFilesReady(true);
  await client.selectFiles(HASH, '1');
  const ready = await client.torrentInfo(HASH);
  assert.equal(ready.status, 'downloaded');
  await client.selectFiles(HASH, 'all');
});

test('auth, scopes, hoster unlocking and search-mode 404 follow the documented envelope', async t => {
  const { base, token, client, tokens, settings } = await fixture(t);
  const unauth = await fetch(`${base}/rest/1.0/user`);
  assert.equal(unauth.status, 401);
  assert.deepEqual(await unauth.json(), { error: 'bad_token', error_code: 8 });
  assert.equal(unauth.headers.get('access-control-allow-origin'), null);

  const read = await tokens.create({ name: 'Read', scopes: ['read'] });
  const reader = new RealDebridRestClient(base, read.token);
  assert.equal((await reader.user()).username, 'Read');
  await assert.rejects(reader.addMagnet(HASH), (e: unknown) => e instanceof RealDebridError && e.status === 403 && e.errorCode === 9);

  const write = await tokens.create({ name: 'Write', scopes: ['write'] });
  const writer = new RealDebridRestClient(base, write.token);
  await writer.addMagnet(HASH);
  const info = await client.torrentInfo(HASH);
  await assert.rejects(writer.unrestrict(info.links[0]!), (e: unknown) => e instanceof RealDebridError && e.errorCode === 9);
  await assert.rejects(client.unrestrict('https://example.com/file.bin'), (e: unknown) => e instanceof RealDebridError && e.status === 503 && e.errorCode === 16);

  const missing = await fetch(`${base}/rest/1.0/traffic`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error_code, 3);

  const instant = await fetch(`${base}/rest/1.0/torrents/instantAvailability/${HASH}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(instant.status, 501);
  assert.equal((await instant.json()).error_code, 37);

  await settings.update({ integrations: { mode: 'search' } });
  assert.equal((await fetch(`${base}/rest/1.0/user`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
});
