import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { ProwlarrClient } from '../src/integrations/prowlarr/client.js';
import { QBittorrentClient } from '../src/integrations/qbittorrent/client.js';
import { listen } from './helpers.js';

test('Prowlarr sends the API key and respects the base path', async t => {
  const base = await listen(createServer((request, response) => {
    assert.equal(request.url, '/prowlarr/api/v1/system/status');
    assert.equal(request.headers['x-api-key'], 'secret-key');
    response.end(JSON.stringify({ version: '1.2.3.4' }));
  }), t);
  const result = await new ProwlarrClient({ url: base + '/prowlarr', apiKey: 'secret-key' }).test();
  assert.equal(result.ok, true);
  assert.equal(result.version, '1.2.3.4');
});

test('qBittorrent logs in with form encoding and uses its SID on authenticated requests', async t => {
  const paths: string[] = [];
  const base = await listen(createServer((request, response) => {
    paths.push(request.url!);
    assert.equal(request.headers.origin, `http://${request.headers.host}`);
    if (request.url?.endsWith('/auth/login')) {
      assert.equal(request.method, 'POST');
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        assert.deepEqual(Object.fromEntries(new URLSearchParams(body)), { username: 'admin', password: 'a&b= c' });
        response.setHeader('Set-Cookie', ['unrelated=1; Path=/', 'SID=abc123; HttpOnly; Path=/']);
        response.end('Ok.');
      });
    } else {
      assert.equal(request.headers.cookie, 'SID=abc123');
      response.end('v5.0.4');
    }
  }), t);
  const result = await new QBittorrentClient({ url: base + '/qbt', username: 'admin', password: 'a&b= c' }).test();
  assert.equal(result.ok, true);
  assert.deepEqual(paths, ['/qbt/api/v2/auth/login', '/qbt/api/v2/app/version']);
});

test('connection errors are classified, redirects refused, and response bodies never exposed', async t => {
  let mode = 'unauthorized';
  let redirected = false;
  const base = await listen(createServer((request, response) => {
    if (request.url === '/redirected') redirected = true;
    if (mode === 'unauthorized') response.statusCode = 401;
    if (mode === 'redirect') { response.statusCode = 302; response.setHeader('Location', '/redirected'); }
    if (mode === 'timeout') return;
    response.end(mode === 'oversized' ? 's'.repeat(70000) : 'secret-raw-response');
  }), t);
  for (const [value, expected] of [['unauthorized', 'authentication'], ['redirect', 'unexpected_response'],
    ['malformed', 'unexpected_response'], ['oversized', 'unexpected_response'], ['timeout', 'timeout']]) {
    mode = value!;
    const result = await new ProwlarrClient({ url: base, apiKey: 'secret' }).test(100);
    assert.equal(result.code, expected);
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
  assert.equal(redirected, false);
  const offline = await new ProwlarrClient({ url: 'http://127.0.0.1:1', apiKey: 'key' }).test();
  assert.equal(offline.code, 'unreachable');
  assert.equal((await new ProwlarrClient({ url: '', apiKey: '' }).test()).code, 'not_configured');
});

test('Prowlarr search sends query and categories, keeps torrent and usenet results, and normalizes fields', async t => {
  let requestUrl = '';
  const base = await listen(createServer((request, response) => {
    requestUrl = request.url!;
    assert.equal(request.headers['x-api-key'], 'secret-key');
    response.end(JSON.stringify([
      { title: 'The Matrix 1999 1080p', size: 5, seeders: 12, leechers: 3, indexer: 'YTS', protocol: 'torrent',
        guid: 'g1', infoHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01', magnetUrl: 'magnet:?x' },
      { title: 'The Matrix 1999 Usenet', protocol: 'usenet', guid: 'g2', size: 9, seeders: 0 },
      { title: '', protocol: 'torrent', guid: 'g3' },
      { title: 'The Matrix 1999 720p', protocol: 'torrent', downloadUrl: 'http://p/dl/4', seeders: -1, size: 'big' },
    ]));
  }), t);
  const releases = await new ProwlarrClient({ url: base + '/prowlarr', apiKey: 'secret-key' })
    .search('The Matrix 1999', AbortSignal.timeout(2000), [2000]);
  assert.match(requestUrl, /^\/prowlarr\/api\/v1\/search\?/);
  const params = new URLSearchParams(requestUrl.split('?')[1]);
  assert.equal(params.get('query'), 'The Matrix 1999');
  assert.equal(params.get('type'), 'search');
  assert.equal(params.get('categories'), '2000');
  assert.deepEqual(releases.map(r => r.title), ['The Matrix 1999 1080p', 'The Matrix 1999 Usenet', 'The Matrix 1999 720p']);
  assert.equal(releases[1]!.protocol, 'usenet');
  assert.equal(releases[0]!.infoHash, 'abcdef0123456789abcdef0123456789abcdef01');
  assert.equal(releases[0]!.magnetUrl, 'magnet:?x');
  assert.equal(releases[2]!.seeders, 0, 'negative seeders clamp to 0');
  assert.equal(releases[2]!.size, 0, 'non-numeric size clamps to 0');
});

test('Prowlarr search rejects a non-array body', async t => {
  const base = await listen(createServer((_request, response) => response.end('{"not":"an array"}')), t);
  await assert.rejects(
    new ProwlarrClient({ url: base, apiKey: 'k' }).search('x', AbortSignal.timeout(2000)),
    /unexpected/i,
  );
});

test('qBittorrent HTTP 200 alone is insufficient for authentication', async t => {
  let mode = 'fails';
  const base = await listen(createServer((request, response) => {
    if (request.url?.endsWith('/auth/login')) {
      if (mode !== 'missing-cookie') response.setHeader('Set-Cookie', 'SID=token; Path=/');
      response.end(mode === 'fails' ? 'Fails.' : 'Ok.');
    } else if (mode === 'denied') { response.statusCode = 403; response.end('secret'); }
    else if (mode === 'timeout') { /* overall deadline includes the version request */ }
    else response.end('<html>login page</html>');
  }), t);
  for (const [value, expected] of [['fails', 'authentication'], ['missing-cookie', 'authentication'],
    ['denied', 'authentication'], ['html', 'unexpected_response'], ['timeout', 'timeout']]) {
    mode = value!;
    const result = await new QBittorrentClient({ url: base, username: 'admin', password: 'secret' }).test(100);
    assert.equal(result.code, expected);
  }
});
