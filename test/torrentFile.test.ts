import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseInfoHash } from '../src/downloads/torrentFile.js';

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
