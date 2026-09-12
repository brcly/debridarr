import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { TorznabClient } from '../src/integrations/torznab/client.js';
import { listen } from './helpers.js';

test('Torznab test() reads the caps server version and omits the apikey param when unset', async t => {
  let requestUrl = '';
  const base = await listen(createServer((request, response) => {
    requestUrl = request.url!;
    response.setHeader('Content-Type', 'application/xml');
    response.end('<?xml version="1.0"?><caps><server version="1.1" title="Indexer"/></caps>');
  }), t);
  const result = await new TorznabClient({ url: base, apiKey: '' }).test();
  assert.equal(result.ok, true);
  assert.equal(result.version, '1.1');
  const params = new URLSearchParams(requestUrl.split('?')[1]);
  assert.equal(params.get('t'), 'caps');
  assert.equal(params.has('apikey'), false);
});

test('not configured and unexpected caps responses are classified', async t => {
  assert.equal((await new TorznabClient({ url: '', apiKey: '' }).test()).code, 'not_configured');
  const base = await listen(createServer((_request, response) => response.end('<caps></caps>')), t);
  assert.equal((await new TorznabClient({ url: base, apiKey: '' }).test()).code, 'unexpected_response');
});

test('Torznab search sends q/cat/apikey and normalizes items from XML', async t => {
  let requestUrl = '';
  const base = await listen(createServer((request, response) => {
    requestUrl = request.url!;
    response.setHeader('Content-Type', 'application/xml');
    response.end(`<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title>The Matrix 1999 1080p &amp; HDR</title>
          <guid>abc-1</guid>
          <link>magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&amp;dn=x</link>
          <pubDate>Wed, 01 Jan 2020 00:00:00 +0000</pubDate>
          <torznab:attr name="seeders" value="12"/>
          <torznab:attr name="peers" value="15"/>
          <enclosure url="http://ignored/dl" length="5000"/>
        </item>
        <item>
          <title><![CDATA[The Matrix 1999 720p]]></title>
          <link>http://indexer.test/dl/2</link>
          <enclosure url="http://indexer.test/dl/2" length="9999"/>
        </item>
        <item>
          <title></title>
          <link>http://indexer.test/dl/3</link>
        </item>
      </channel></rss>`);
  }), t);
  const releases = await new TorznabClient({ url: base, apiKey: 'k' }).search('The Matrix 1999', AbortSignal.timeout(2000), [2000]);
  const params = new URLSearchParams(requestUrl.split('?')[1]);
  assert.equal(params.get('t'), 'search');
  assert.equal(params.get('q'), 'The Matrix 1999');
  assert.equal(params.get('cat'), '2000');
  assert.equal(params.get('apikey'), 'k');
  assert.deepEqual(releases.map(r => r.title), ['The Matrix 1999 1080p & HDR', 'The Matrix 1999 720p']);
  assert.equal(releases[0]!.magnetUrl, 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=x');
  assert.equal(releases[0]!.infoHash, 'abcdef0123456789abcdef0123456789abcdef01');
  assert.equal(releases[0]!.downloadUrl, undefined);
  assert.equal(releases[0]!.seeders, 12);
  assert.equal(releases[0]!.leechers, 3, 'leechers derive from peers minus seeders when not given directly');
  assert.equal(releases[0]!.publishDate, 'Wed, 01 Jan 2020 00:00:00 +0000');
  assert.equal(releases[0]!.protocol, 'torrent');
  assert.equal(releases[1]!.downloadUrl, 'http://indexer.test/dl/2');
  assert.equal(releases[1]!.size, 9999);
  assert.equal(releases[1]!.indexer, new URL(base).hostname);
});

test('Torznab search rejects a body that is not RSS', async t => {
  const base = await listen(createServer((_request, response) => response.end('not xml')), t);
  await assert.rejects(
    new TorznabClient({ url: base, apiKey: 'k' }).search('x', AbortSignal.timeout(2000)),
    /unexpected/i,
  );
});
