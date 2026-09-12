import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, stat, mkdir, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { AddonAccess, sourceIdentity } from '../src/security/addon.js';
import { Admission } from '../src/security/admission.js';
import { fetchTorrentSource, isPublicAddress, publicDestination, pinnedLookup, validateProxy } from '../src/security/torrentSource.js';
import { openConfinedFile } from '../src/playback/paths.js';
import { buildStreams } from '../src/addon/streams.js';
import { parseReleaseTitle } from '../src/search/parse.js';
import { listen, playRequest, tmpDir } from './helpers.js';

const RELEASE_TITLE = 'Movie 2020';
const DOWNLOAD_URL = 'http://prowlarr/1/download?apikey=SECRET&link=abc';
const target = playRequest({ title: RELEASE_TITLE, size: 100, imdbId: 'tt1', type: 'movie', downloadUrl: DOWNLOAD_URL });

test('private key and opaque references persist, expire, rotate, and fail closed on corrupt state', async t => {
  const dir = await tmpDir(t, 'debridarr-access');
  const access = await AddonAccess.open(dir);
  const base = access.base('https://example.test');
  const key = base.split('/').at(-1)!;
  assert.equal(access.valid(key), true);
  assert.equal(access.valid(key.slice(1)), false);
  const [id] = await access.issue([target], 'source', 100);
  assert.match(id!, /^[\w-]{43}$/);
  assert.ok(!Buffer.from(id!, 'base64url').toString().includes('SECRET'));
  assert.deepEqual(access.get(id!, 'source', 100), target);
  assert.equal(access.get(id!, 'changed', 100), undefined);
  assert.equal(access.get(id!, 'source', 100 + 86400000), undefined);
  assert.equal(access.get(Buffer.from(JSON.stringify(target)).toString('base64url'), 'source', 100), undefined);
  const reopened = await AddonAccess.open(dir);
  assert.equal(reopened.base('https://example.test'), base);
  assert.deepEqual(reopened.get(id!, 'source', 100), target);
  assert.equal((await stat(join(dir, 'addon.json'))).mode & 0o777, 0o600);
  await reopened.rotate();
  assert.equal(reopened.valid(key), false);
  assert.equal(reopened.get(id!, 'source', 100), undefined);
  assert.equal((await AddonAccess.open(dir)).base('https://example.test'), reopened.base('https://example.test'));
  await writeFile(join(dir, 'addon.json'), 'broken');
  await assert.rejects(AddonAccess.open(dir), /invalid/);
  assert.equal(await readFile(join(dir, 'addon.json'), 'utf8'), 'broken');
});

test('legacy addon state preserves its installation key while dropping incompatible references', async t => {
  const dir = await tmpDir(t, 'debridarr-access-migration');
  const key = Buffer.alloc(32, 7).toString('base64url');
  const id = Buffer.alloc(32, 8).toString('base64url');
  await writeFile(join(dir, 'addon.json'), JSON.stringify({
    version: 2, key, references: [{ id, created: Date.now(), source: 'legacy', target: { name: 'Old selection' }, bucket: 'search' }],
  }));

  const access = await AddonAccess.open(dir);
  assert.equal(access.valid(key), true);
  assert.equal(access.get(id, 'legacy'), undefined);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'addon.json'), 'utf8')), { version: 3, key, references: [] });
});

test('release references are bounded and source changes invalidate them', async t => {
  const dir = await tmpDir(t, 'debridarr-reference');
  const access = await AddonAccess.open(dir);
  const ids = await access.issue(Array.from({ length: 1001 }, () => target), 'old', 10);
  assert.equal(access.get(ids[0]!, 'old', 10), undefined);
  assert.deepEqual(access.get(ids.at(-1)!, 'old', 10), target);
  assert.equal(JSON.parse(await readFile(join(dir, 'addon.json'), 'utf8')).references.length, 1000);
  await assert.rejects(access.issue([{ ...target, name: 'a'.repeat(20000) }], 'old'), /large/);
  await access.invalidate();
  assert.equal(access.get(ids.at(-1)!, 'old', 10), undefined);
});

test('a different reference source cannot read another source\'s references', async t => {
  const dir = await tmpDir(t, 'debridarr-reference-sources');
  const access = await AddonAccess.open(dir);
  const [a] = await access.issue([target], 'source-a', 10);
  const [b] = await access.issue([target], 'source-b', 10);
  assert.deepEqual(access.get(a!, 'source-a', 10), target);
  assert.equal(access.get(a!, 'source-b', 10), undefined);
  assert.deepEqual(access.get(b!, 'source-b', 10), target);
});

test('stream responses expose neither Prowlarr keys nor torrent sources', async t => {
  const dir = await tmpDir(t, 'debridarr-streams');
  const access = await AddonAccess.open(dir);
  const streams = await buildStreams([{ release: { title: RELEASE_TITLE, size: 100, seeders: 1, leechers: 0,
    indexer: 'test', protocol: 'torrent', guid: 'test', downloadUrl: DOWNLOAD_URL }, parsed: parseReleaseTitle(RELEASE_TITLE), preferences: { languages: [] } }],
  { type: 'movie', imdbId: 'tt1' }, access.base('https://test'), targets => access.issue(targets, 'source'));
  assert.ok(!JSON.stringify(streams).includes('SECRET'));
  assert.ok(!JSON.stringify(streams).includes('prowlarr'));
  assert.deepEqual(access.get(streams[0]!.url.split('/').at(-1)!, 'source'), target);
  assert.notEqual(sourceIdentity({ url: 'a', apiKey: 'a' }), sourceIdentity({ url: 'a', apiKey: 'b' }));
});

test('admission limits bound active work and request rate without accumulating queues', () => {
  const admission = new Admission(2, 3);
  const first = admission.enter(0), second = admission.enter(0);
  assert.throws(() => admission.enter(0), /busy/);
  first(); first();
  const third = admission.enter(0);
  second(); third();
  assert.throws(() => admission.enter(0), /busy/);
  admission.enter(60_000)();
});

test('redirect destinations reject private, mapped, reserved, and mixed IPv6 addresses', async () => {
  for (const address of ['0.0.0.0','10.1.2.3','127.0.0.1','169.254.169.254','172.20.0.1','192.168.1.1','100.64.0.1',
    '192.0.2.1','198.18.0.1','224.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::','64:ff9b::7f00:1','3fff::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  await assert.rejects(publicDestination(new URL('http://localhost/')), /Unsafe/);
  assert.deepEqual(await publicDestination(new URL('https://1.1.1.1/')), { address: '1.1.1.1', family: 4 });
});

test('only configured Prowlarr proxy paths can receive the current API key; private redirects make no second request', async t => {
  let hits = 0;
  const secret = await listen(createServer((_req, res) => { hits++; res.end('private'); }), t);
  const prowlarr = await listen(createServer((req, res) => {
    assert.equal(req.headers['x-api-key'], 'current-key');
    assert.ok(!req.url!.includes('old-key'));
    res.writeHead(302, { Location: `${secret}/secret` }); res.end();
  }), t);
  const providers = [{ url: `${prowlarr}/base`, apiKey: 'current-key', type: 'prowlarr' as const }];
  for (const url of [secret, `${prowlarr}/api/v1/config`, `${prowlarr}/base/1/download/extra?link=x`, `${prowlarr}/base/%31/download?link=x`]) {
    assert.throws(() => validateProxy(url, providers));
  }
  await assert.rejects(fetchTorrentSource(`${prowlarr}/base/1/download?apikey=old-key&link=x`, AbortSignal.timeout(1000), providers), /Unsafe/);
  assert.equal(hits, 0);
});

test('Prowlarr magnet redirects preserve tracker information and reject unsupported schemes', async t => {
  const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}&tr=${encodeURIComponent('https://tracker.example/announce')}`;
  let location = magnet;
  const base = await listen(createServer((_req,res) => { res.writeHead(302, { Location: location }); res.end(); }), t);
  const request = () => fetchTorrentSource(`${base}/1/download?link=x`, AbortSignal.timeout(1000), [{ url: base, apiKey: 'key', type: 'prowlarr' }]);
  assert.deepEqual(await request(), { magnet });
  location = 'file:///etc/passwd';
  await assert.rejects(request(), /Unsafe/);
});

test('descriptor confinement refuses file/directory symlinks and keeps the opened inode across replacement', async t => {
  const dir = await tmpDir(t, 'debridarr-confinement');
  const root = join(dir, 'downloads');
  await mkdir(root);
  await writeFile(join(dir, 'secret'), 'SECRET');
  await symlink(join(dir, 'secret'), join(root, 'link.mkv'));
  await symlink(dir, join(root, 'escape'));
  await assert.rejects(openConfinedFile(join(root, 'link.mkv'), root));
  await assert.rejects(openConfinedFile(join(root, 'escape/secret'), root));
  await assert.rejects(openConfinedFile(join(root, '../secret'), root));
  await mkdir(join(root, 'directory'));
  await assert.rejects(openConfinedFile(join(root, 'directory'), root), /regular file/);
  const path = join(root, 'movie.mkv');
  await writeFile(path, 'MOVIE');
  const opened = await openConfinedFile(path, root);
  await rename(path, join(root, 'old.mkv'));
  await symlink(join(dir, 'secret'), path);
  try { assert.equal(await opened.readFile('utf8'), 'MOVIE'); } finally { await opened.close(); }
});

test('redirect DNS validation rejects mixed answers and pins the validated address across rebinding', async () => {
  let calls = 0;
  const resolver = async () => [{ address: calls++ === 0 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
  const url = new URL('https://redirect.example/file');
  const destination = await publicDestination(url, resolver);
  const connectLookup = pinnedLookup(destination);
  await new Promise<void>((resolve, reject) => connectLookup(url.hostname, {}, (error, address, family) => {
    if (error) { reject(error); return; }
    assert.equal(address, '8.8.8.8'); assert.equal(family, 4); resolve();
  }));
  assert.equal(calls, 1, 'connection uses the vetted answer, never DNS again');
  await assert.rejects(publicDestination(url, resolver), /Unsafe/);
  await assert.rejects(publicDestination(url, async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), /Unsafe/);
  const controller = new AbortController();
  const pending = publicDestination(url, () => new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
});

test('a configured discovery provider origin may serve a release download link; other origins may not', async t => {
  const torznab = { url: 'http://indexer:9117/torznab/api', apiKey: 'indexer-key', type: 'torznab' as const };
  const providers = [torznab];
  // The provider's own link: apikey is filled in when the link carries none,
  // and an existing one is never replaced.
  assert.equal(validateProxy('http://indexer:9117/download/abc', providers).searchParams.get('apikey'), 'indexer-key');
  assert.equal(validateProxy('http://indexer:9117/download/abc?apikey=link-key', providers).searchParams.get('apikey'), 'link-key');
  for (const url of ['http://indexer:9117/', 'http://other:9117/download/abc', 'file:///etc/passwd', 'http://user:pw@indexer:9117/download/a', 'http://indexer:9117/download/a#frag']) {
    assert.throws(() => validateProxy(url, providers), /Invalid torrent proxy/, url);
  }
  // A Prowlarr provider keeps its strict /<n>/download shape and never lets a
  // key ride along in the query string.
  const prowlarr = [{ url: 'http://prowlarr:9696/base', apiKey: 'prowlarr-key', type: 'prowlarr' as const }];
  assert.equal(validateProxy('http://prowlarr:9696/base/1/download?apikey=old-key&link=x', prowlarr).searchParams.has('apikey'), false);
  assert.throws(() => validateProxy('http://indexer:9117/download/abc', prowlarr), /Invalid torrent proxy/);

  let apiKeyHeader: string | undefined;
  const indexer = await listen(createServer((req, res) => { apiKeyHeader = req.headers['x-api-key'] as string | undefined; res.end('d4:infod4:name4:testee'); }), t);
  const fetched = await fetchTorrentSource(`${indexer}/download/abc`, AbortSignal.timeout(1000), [{ url: indexer, apiKey: 'indexer-key', type: 'torznab' }]);
  assert.ok(fetched.bytes, 'the provider download link is fetched');
  assert.equal(apiKeyHeader, undefined, 'a provider is authenticated by its own apikey parameter, never Prowlarr\u2019s header');
});
