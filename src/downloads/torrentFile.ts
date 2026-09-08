import { createHash } from 'node:crypto';
import { fetchTorrentSource } from '../security/torrentSource.js';
import type { Settings } from '../settings.js';

const MAX_TORRENT_BYTES = 10 * 1024 * 1024;
const MAX_DEPTH = 64;

class BencodeError extends Error {}

function readLength(buffer: Buffer, pos: { i: number }): number {
  const colon = buffer.indexOf(0x3a /* ':' */, pos.i);
  if (colon < 0) throw new BencodeError('unterminated string length');
  const digits = buffer.toString('ascii', pos.i, colon);
  if (!/^\d+$/.test(digits)) throw new BencodeError('bad string length');
  const length = Number(digits);
  if (!Number.isSafeInteger(length)) throw new BencodeError('bad string length');
  pos.i = colon + 1;
  return length;
}

function readStringSpan(buffer: Buffer, pos: { i: number }): { start: number; end: number } {
  const length = readLength(buffer, pos);
  const start = pos.i;
  const end = start + length;
  if (end > buffer.length) throw new BencodeError('string runs past end of buffer');
  pos.i = end;
  return { start, end };
}

// Advances pos.i past one bencoded value without materializing it — all we
// need is where it ends, not what it contains.
function skipValue(buffer: Buffer, pos: { i: number }, depth: number): void {
  if (depth > MAX_DEPTH) throw new BencodeError('too deeply nested');
  if (pos.i >= buffer.length) throw new BencodeError('unexpected end of buffer');
  const marker = buffer[pos.i]!;
  if (marker === 0x64 /* 'd' */) {
    pos.i += 1;
    for (;;) {
      if (pos.i >= buffer.length) throw new BencodeError('unterminated dict');
      if (buffer[pos.i] === 0x65 /* 'e' */) { pos.i += 1; return; }
      readStringSpan(buffer, pos); // key
      skipValue(buffer, pos, depth + 1); // value
    }
  } else if (marker === 0x6c /* 'l' */) {
    pos.i += 1;
    for (;;) {
      if (pos.i >= buffer.length) throw new BencodeError('unterminated list');
      if (buffer[pos.i] === 0x65) { pos.i += 1; return; }
      skipValue(buffer, pos, depth + 1);
    }
  } else if (marker === 0x69 /* 'i' */) {
    pos.i += 1;
    const end = buffer.indexOf(0x65, pos.i);
    if (end < 0) throw new BencodeError('unterminated integer');
    pos.i = end + 1;
  } else if (marker >= 0x30 && marker <= 0x39 /* '0'-'9' */) {
    readStringSpan(buffer, pos);
  } else {
    throw new BencodeError('unknown value type');
  }
}

// Finds the "info" key in a .torrent file's top-level dictionary and hashes
// the exact original bytes of its value — the standard way to compute a v1
// infohash without needing a bencode *encoder*. BEP3 already requires dict
// keys to be sorted, so the source bytes are already the canonical encoding;
// slicing them is both simpler and safer than decoding and re-encoding.
// Never throws: anything malformed, truncated, or without an "info" key
// yields undefined.
export function parseInfoHash(buffer: Buffer): string | undefined {
  try {
    const pos = { i: 0 };
    if (buffer[pos.i] !== 0x64 /* 'd' */) return undefined; // must be a top-level dict
    pos.i += 1;
    for (;;) {
      if (pos.i >= buffer.length) return undefined;
      if (buffer[pos.i] === 0x65 /* 'e' */) return undefined; // no "info" key found
      const key = readStringSpan(buffer, pos);
      const keyText = buffer.toString('latin1', key.start, key.end);
      if (keyText === 'info') {
        const start = pos.i;
        skipValue(buffer, pos, 0);
        return createHash('sha1').update(buffer.subarray(start, pos.i)).digest('hex');
      }
      skipValue(buffer, pos, 0);
    }
  } catch {
    return undefined;
  }
}

// Compatibility helper for callers requiring bytes; all network access is constrained.
export async function fetchTorrentFile(url: string, signal: AbortSignal, prowlarr: Settings['prowlarr']): Promise<Buffer> {
  const source = await fetchTorrentSource(url, prowlarr, signal);
  if (!source.bytes) throw new Error('Torrent source is a magnet');
  return source.bytes;
}
