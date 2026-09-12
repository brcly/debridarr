import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { appFixture } from './app-fixture.js';
import { SAMPLE_HASH as HASH } from './fake-qbt.js';

async function fixture(t: TestContext) {
  const f = await appFixture(t, { prefix: 'debridarr-dav-', mode: 'store', seedPlaybackFile: true });
  const dav = (path: string, opts: { method?: string; auth?: string | null; headers?: Record<string, string> } = {}) =>
    fetch(`${f.base}/dav${path}`, {
      method: opts.method ?? 'PROPFIND',
      headers: {
        ...(opts.auth === null ? {} : { Authorization: opts.auth ?? `Basic ${Buffer.from(`x:${f.token}`).toString('base64')}` }),
        ...(opts.method === 'PROPFIND' || opts.method === undefined ? { Depth: '1' } : {}),
        ...opts.headers,
      },
    });
  const created = await fetch(`${f.base}/store/v1/magnets`, {
    method: 'POST', headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ infoHash: HASH }),
  });
  assert.equal(created.status, 201);
  return { ...f, dav };
}

test('OPTIONS advertises read-only DAV compliance without authentication', async t => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/dav/`, { method: 'OPTIONS' });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('dav'), '1');
  assert.equal(response.headers.get('allow'), 'OPTIONS, PROPFIND, GET, HEAD');
});

test('PROPFIND requires a token, via Basic (password) or Bearer, and the read+link scopes', async t => {
  const { dav, tokens } = await fixture(t);
  const noAuth = await dav('/', { auth: null });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.headers.get('www-authenticate'), 'Basic realm="Debridarr"');

  assert.equal((await dav('/', { auth: 'Basic ' + Buffer.from('x:not-a-real-token').toString('base64') })).status, 401);

  const noLink = (await tokens.create({ name: 'nolink', scopes: ['read', 'write'] })).token;
  assert.equal((await dav('/', { auth: `Basic ${Buffer.from(`x:${noLink}`).toString('base64')}` })).status, 403);

  const { token: bearerToken } = await tokens.create({ name: 'bearer' });
  assert.equal((await dav('/', { auth: `Bearer ${bearerToken}` })).status, 207);
});

test('the root lists managed transfers by name; a transfer lists only selected, complete video files', async t => {
  const { dav } = await fixture(t);

  const root = await dav('/');
  assert.equal(root.status, 207);
  assert.equal(root.headers.get('content-type'), 'application/xml; charset=utf-8');
  const rootXml = await root.text();
  assert.match(rootXml, /<D:href>\/dav\/<\/D:href>/);
  assert.match(rootXml, /<D:href>\/dav\/Torrent%20[\w]+\/<\/D:href>/);
  const slug = /<D:href>\/dav\/(Torrent%20[\w]+)\/<\/D:href>/.exec(rootXml)![1]!;
  assert.match(rootXml, /<D:resourcetype><D:collection\/><\/D:resourcetype>/);

  const inside = await dav(`/${slug}/`);
  assert.equal(inside.status, 207);
  const insideXml = await inside.text();
  assert.equal((insideXml.match(/<D:response>/g) ?? []).length, 2, 'self + exactly one eligible file');
  assert.match(insideXml, new RegExp(`<D:href>/dav/${slug}/movie\\.mkv</D:href>`));
  assert.ok(!insideXml.includes('unselected.mkv'), 'an unselected file is excluded');
  assert.ok(!insideXml.includes('readme.nfo'), 'a non-video file is excluded');
  assert.match(insideXml, /<D:getcontentlength>100<\/D:getcontentlength>/);
  assert.match(insideXml, /<D:getcontenttype>video\/x-matroska<\/D:getcontenttype>/);

  // Depth: 0 on the same folder reports only itself.
  const depthZero = await dav(`/${slug}/`, { headers: { Depth: '0' } });
  assert.equal((await depthZero.text()).match(/<D:response>/g)?.length, 1);

  assert.equal((await dav('/', { headers: { Depth: 'infinity' } })).status, 403);
  assert.equal((await dav('/unknown-transfer/')).status, 404);
  assert.equal((await dav(`/${slug}/no-such-file.mkv`)).status, 404);
  assert.equal((await dav(`/${slug}/movie.mkv/nested`)).status, 404, 'a file is not a folder');
  // Both a literal and a percent-encoded ".." are normalized away by URL
  // parsing before this ever reaches dav routing (collapsing down to a path
  // outside /dav/, which the generic fallback answers with 405 for a method
  // it does not recognize) — never anything resembling a served file.
  // Resolution-level protection (a ".." segment can never match a real
  // torrent path) is proven directly in dav-tree.test.ts.
  const traversal = await dav(`/${slug}/%2e%2e/%2e%2e/etc/passwd`);
  assert.ok([404, 405].includes(traversal.status), `expected a safe non-content status, got ${traversal.status}`);
  assert.ok(!(await traversal.text()).includes('root:'), 'never anything resembling file content');
});

test('GET streams the complete file with Range support; a folder, HEAD, and write methods behave correctly', async t => {
  const { dav, base, token } = await fixture(t);
  const root = await (await dav('/')).text();
  const slug = /<D:href>\/dav\/(Torrent%20[\w]+)\/<\/D:href>/.exec(root)![1]!;
  const auth = `Basic ${Buffer.from(`x:${token}`).toString('base64')}`;

  const full = await fetch(`${base}/dav/${slug}/movie.mkv`, { headers: { Authorization: auth } });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/x-matroska');
  assert.equal(await full.text(), '0123456789'.repeat(10));

  const ranged = await fetch(`${base}/dav/${slug}/movie.mkv`, { headers: { Authorization: auth, Range: 'bytes=0-9' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 0-9/100');
  assert.equal(await ranged.text(), '0123456789');

  const head = await fetch(`${base}/dav/${slug}/movie.mkv`, { method: 'HEAD', headers: { Authorization: auth } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '100');

  // A folder cannot be GET; only PROPFIND lists it.
  const folderGet = await fetch(`${base}/dav/${slug}/`, { headers: { Authorization: auth } });
  assert.equal(folderGet.status, 405);
  assert.equal(folderGet.headers.get('allow'), 'OPTIONS, PROPFIND, GET, HEAD');

  for (const method of ['PUT', 'DELETE', 'MKCOL', 'MOVE', 'PROPPATCH', 'LOCK']) {
    const response = await fetch(`${base}/dav/${slug}/movie.mkv`, { method, headers: { Authorization: auth } });
    assert.equal(response.status, 405, method);
  }
});

test('Search-only mode has no DAV surface', async t => {
  const f = await appFixture(t, { prefix: 'debridarr-dav-search-', mode: 'search' });
  const response = await fetch(`${f.base}/dav/`, { method: 'PROPFIND', headers: { Depth: '1', Authorization: `Basic ${Buffer.from(`x:${f.token}`).toString('base64')}` } });
  assert.equal(response.status, 404, 'the mount itself is gone in Search mode, checked before auth');
});
