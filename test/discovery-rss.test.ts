import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attrValue, isRssDocument, parseRssItems } from '../src/discovery/rss.js';

const item = (inner: string) => `<item>${inner}</item>`;
const feed = (items: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${items}</channel></rss>`;

test('parseRssItems normalizes title, guid, magnet, size, seeders/leechers, and entities', () => {
  const xml = feed(item(`
    <title>The Matrix 1999 &amp; HDR</title>
    <guid>abc-1</guid>
    <link>magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&amp;dn=x</link>
    <pubDate>Wed, 01 Jan 2020 00:00:00 +0000</pubDate>
    <torznab:attr name="seeders" value="12"/>
    <torznab:attr name="peers" value="20"/>
    <enclosure url="http://x/movie.torrent" length="1048576"/>
  `));
  const [release] = parseRssItems(xml, 'test-indexer', 'torrent', 10);
  assert.equal(release?.title, 'The Matrix 1999 & HDR');
  assert.equal(release?.guid, 'abc-1');
  assert.equal(release?.infoHash, 'abcdef0123456789abcdef0123456789abcdef01');
  assert.equal(release?.size, 1_048_576);
  assert.equal(release?.seeders, 12);
  assert.equal(release?.leechers, 8, 'no explicit leechers falls back to peers - seeders');
  assert.equal(release?.publishDate, 'Wed, 01 Jan 2020 00:00:00 +0000');
});

test('an item missing both title and guid/link is dropped, not defaulted', () => {
  assert.deepEqual(parseRssItems(feed(item('<title>Only a title</title>')), 'i', 'torrent', 10), []);
  assert.deepEqual(parseRssItems(feed(item('<guid>only-guid</guid>')), 'i', 'torrent', 10), []);
  assert.deepEqual(parseRssItems(feed(''), 'i', 'torrent', 10), []);
});

test('isRssDocument requires an <rss> or <channel> tag, case-insensitively, anywhere in the body', () => {
  assert.equal(isRssDocument('<rss version="2.0"><channel/></rss>'), true);
  assert.equal(isRssDocument('<RSS><CHANNEL/></RSS>'), true);
  assert.equal(isRssDocument('<html><body>not a feed</body></html>'), false);
  assert.equal(isRssDocument(''), false);
  assert.equal(isRssDocument('crossref'), false, 'substring match on the word "rss" must not false-positive');
});

// Adversarial coverage: this reader intentionally uses regexes instead of a
// DOM parser (see src/discovery/rss.ts's header comment) against XML an
// indexer or a saved-search feed URL fully controls. Every case below
// asserts the parser never throws and never hangs.

test('the limit is honoured even when a feed offers far more items than requested', () => {
  const items = Array.from({ length: 5000 }, (_, i) => item(`<title>t${i}</title><guid>g${i}</guid>`)).join('');
  const started = Date.now();
  const releases = parseRssItems(feed(items), 'i', 'torrent', 25);
  assert.equal(releases.length, 25);
  assert.ok(Date.now() - started < 2000, 'parsing 5000 items down to a limit of 25 should be fast');
});

test('deeply nested and unclosed tags do not throw and do not hang', () => {
  const pathological = [
    feed(item('<title>' + '<a>'.repeat(20_000) + 'x</title><guid>g</guid>')),
    feed(item('<title>unterminated')),
    feed('<item>' + item('nested item, not a sibling') + '</item>'),
    feed(item('<title>' + 'a'.repeat(500_000) + '</title><guid>g</guid>')),
    '<item>'.repeat(50_000),
    feed(item('<title>&amp;'.repeat(10_000) + '</title><guid>g</guid>')),
  ];
  for (const xml of pathological) {
    const started = Date.now();
    assert.doesNotThrow(() => parseRssItems(xml, 'i', 'torrent', 50));
    assert.ok(Date.now() - started < 2000, 'pathological input must not cause catastrophic backtracking');
  }
});

test('malformed entity references pass through unchanged instead of throwing', () => {
  const xml = feed(item('<title>A &notanentity; B &amp C &#zz; D &#xzz; E</title><guid>g</guid>'));
  const [release] = parseRssItems(xml, 'i', 'torrent', 10);
  assert.equal(release?.title, 'A &notanentity; B &amp C &#zz; D &#xzz; E');
});

test('non-UTF8-safe and control-character bytes in tag text do not throw', () => {
  const weird = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x1b]).toString('latin1');
  const xml = feed(item(`<title>${weird}</title><guid>g</guid>`));
  assert.doesNotThrow(() => parseRssItems(xml, 'i', 'torrent', 10));
});

test('CDATA-wrapped and attribute-shaped hostile input is handled without throwing', () => {
  const cases = [
    feed(item('<title><![CDATA[' + '<title>'.repeat(1000) + ']]></title><guid>g</guid>')),
    feed(item('<title><![CDATA[unterminated cdata')),
    '<caps><server version="' + '"'.repeat(10_000) + '1.0"/></caps>',
  ];
  for (const xml of cases) {
    assert.doesNotThrow(() => parseRssItems(xml, 'i', 'torrent', 10));
    assert.doesNotThrow(() => attrValue(xml, 'server', 'version'));
  }
});
