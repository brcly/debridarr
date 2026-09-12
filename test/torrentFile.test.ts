import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseInfoHash, parseTorrentName } from '../src/downloads/torrentFile.js';

// A minimal, hand-built bencode dict: d <key><value> ... e
function bencodeString(value: string): Buffer {
  const bytes = Buffer.from(value, 'latin1');
  return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]);
}
function bencodeInt(value: number): Buffer {
  return Buffer.from(`i${value}e`);
}
function bencodeDict(entries: [string, Buffer][]): Buffer {
  return Buffer.concat([Buffer.from('d'), ...entries.flatMap(([key, value]) => [bencodeString(key), value]), Buffer.from('e')]);
}

// A plausible single-file info dict: {length, name, piece length, pieces}.
const infoValue = bencodeDict([
  ['length', bencodeInt(1_000_000)],
  ['name', bencodeString('Movie.2020.1080p.mkv')],
  ['piece length', bencodeInt(16_384)],
  ['pieces', bencodeString('A'.repeat(20))],
]);

function expectedHash(value: Buffer): string {
  return createHash('sha1').update(value).digest('hex');
}

test('parseInfoHash hashes the exact bytes of the "info" value', () => {
  const torrent = bencodeDict([
    ['announce', bencodeString('http://tracker.example/announce')],
    ['info', infoValue],
  ]);
  assert.equal(parseInfoHash(torrent), expectedHash(infoValue));
});

test('parseInfoHash finds "info" regardless of position among sibling keys', () => {
  const before = bencodeDict([['announce', bencodeString('http://a')], ['info', infoValue]]);
  const after = bencodeDict([['info', infoValue], ['announce', bencodeString('http://a')]]);
  const withExtras = bencodeDict([
    ['announce-list', Buffer.from('l' + bencodeString('http://a').toString('latin1') + 'e')],
    ['comment', bencodeString('made by a test')],
    ['info', infoValue],
    ['creation date', bencodeInt(1_700_000_000)],
  ]);
  const hash = expectedHash(infoValue);
  assert.equal(parseInfoHash(before), hash);
  assert.equal(parseInfoHash(after), hash);
  assert.equal(parseInfoHash(withExtras), hash);
});

test('parseInfoHash handles a nested "files" list (multi-file torrent)', () => {
  const multiInfo = bencodeDict([
    ['name', bencodeString('Show.S01')],
    ['piece length', bencodeInt(16_384)],
    ['pieces', bencodeString('B'.repeat(40))],
    ['files', Buffer.concat([
      Buffer.from('l'),
      bencodeDict([['length', bencodeInt(500)], ['path', Buffer.concat([Buffer.from('l'), bencodeString('e01.mkv'), Buffer.from('e')])]]),
      bencodeDict([['length', bencodeInt(600)], ['path', Buffer.concat([Buffer.from('l'), bencodeString('e02.mkv'), Buffer.from('e')])]]),
      Buffer.from('e'),
    ])],
  ]);
  const torrent = bencodeDict([['announce', bencodeString('http://a')], ['info', multiInfo]]);
  assert.equal(parseInfoHash(torrent), expectedHash(multiInfo));
});

test('parseInfoHash returns undefined for malformed, truncated, or info-less input', () => {
  assert.equal(parseInfoHash(Buffer.from('not bencode')), undefined);
  assert.equal(parseInfoHash(Buffer.from('le')), undefined, 'a list, not a dict, at the top level');
  assert.equal(parseInfoHash(bencodeDict([['announce', bencodeString('http://a')]])), undefined, 'no "info" key');
  const valid = bencodeDict([['info', infoValue]]);
  assert.equal(parseInfoHash(valid.subarray(0, valid.length - 10)), undefined, 'truncated');
  assert.equal(parseInfoHash(Buffer.from('d3:foo')), undefined, 'dict missing its value and terminator');
  assert.equal(parseInfoHash(Buffer.alloc(0)), undefined, 'empty buffer');
});

// Adversarial coverage: bencode is the one format here parsed from bytes an
// indexer or API client fully controls. Every case below asserts the parser
// never throws and never hangs — a crash or an infinite loop is the actual
// failure mode malformed .torrent bytes should never be able to trigger.

test('every truncation of a valid .torrent is handled without throwing', () => {
  const torrent = bencodeDict([['announce', bencodeString('http://a')], ['info', infoValue]]);
  for (let end = 0; end < torrent.length; end++) {
    const slice = torrent.subarray(0, end);
    const hash = parseInfoHash(slice);
    const name = parseTorrentName(slice);
    assert.ok(hash === undefined || (typeof hash === 'string' && /^[0-9a-f]{40}$/.test(hash)), `hash at truncation ${end}`);
    assert.ok(name === undefined || typeof name === 'string', `name at truncation ${end}`);
  }
});

test('a dict nested far past the depth limit returns undefined instead of overflowing the stack', () => {
  const depth = 5000;
  const open = Buffer.from('d1:a'.repeat(depth));
  const close = Buffer.from('e'.repeat(depth));
  const nested = Buffer.concat([open, bencodeInt(1), close]);
  assert.equal(parseInfoHash(nested), undefined);
  assert.equal(parseTorrentName(nested), undefined);
  // The same shape, but with a real "info" key past the depth limit: still
  // must not be found, since skipValue bails out rather than descending forever.
  const withInfo = bencodeDict([['info', Buffer.concat([open, bencodeInt(1), close])]]);
  assert.equal(parseInfoHash(withInfo), undefined);
});

test('an oversized or negative string length prefix is rejected, not trusted', () => {
  for (const length of ['99999999999999999999', '-5', '1e400', 'NaN', String(Number.MAX_SAFE_INTEGER)]) {
    // As the dict key itself.
    assert.equal(parseInfoHash(Buffer.from(`d${length}:`)), undefined, `key length prefix ${length}`);
    // As the "info" value: a length that fits Number.isSafeInteger (like
    // MAX_SAFE_INTEGER) still fails because it claims far more bytes than
    // the buffer actually has.
    assert.equal(parseInfoHash(Buffer.from(`d4:info${length}:short`)), undefined, `info value length prefix ${length}`);
  }
});

test('a duplicate "info" key resolves to the first occurrence, deterministically', () => {
  const first = bencodeDict([['info', infoValue], ['info', bencodeString('decoy')]]);
  const second = bencodeDict([['info', bencodeString('decoy')], ['info', infoValue]]);
  assert.equal(parseInfoHash(first), expectedHash(infoValue), 'first "info" wins when it comes first');
  assert.equal(parseInfoHash(second), expectedHash(bencodeString('decoy')), 'first "info" wins even when a better one follows');
});

test('non-UTF8 bytes in the name field do not throw and never crash the hash computation', () => {
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x41]);
  const info = bencodeDict([['name', Buffer.concat([Buffer.from(`${invalidUtf8.length}:`), invalidUtf8])]]);
  const torrent = bencodeDict([['info', info]]);
  assert.equal(parseInfoHash(torrent), expectedHash(info));
  const name = parseTorrentName(torrent);
  assert.equal(typeof name, 'string');
});

test('random byte sequences of every small size never throw and complete quickly', () => {
  const started = Date.now();
  for (let size = 0; size < 300; size++) {
    const buffer = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buffer[i] = (i * 2654435761 + size) & 0xff; // deterministic pseudo-random fill
    parseInfoHash(buffer);
    parseTorrentName(buffer);
  }
  assert.ok(Date.now() - started < 2000, 'fuzzing 300 buffer sizes should be fast, not pathological');
});
