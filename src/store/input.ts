import { HttpError } from '../http.js';
import { objectRecord } from '../json.js';
import { parseInfoHash } from '../downloads/torrentFile.js';
import { isNzb } from '../downloads/nzb.js';
import { validateMagnet } from '../security/torrentSource.js';
import { CONTROL_CHARACTERS } from '../security/text.js';
import type { RecordMedia } from '../downloads/store.js';
import type { TransferSource } from '../application/types.js';
import { parseHex40 } from '../domain/ids.js';

export const MAX_TORRENT = 2 * 1024 * 1024;
export const MAX_NZB = MAX_TORRENT;

function decodeBase64(value: unknown, label: string, maxBytes: number): Buffer {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new HttpError(400, `${label} must be base64.`);
  }
  if (Buffer.byteLength(value, 'base64') > maxBytes) throw new HttpError(413, `${label === 'nzb' ? 'NZB' : 'Torrent'} is too large.`);
  return Buffer.from(value, 'base64');
}

function httpDownloadUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, 'downloadUrl must be an http(s) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new HttpError(400, 'downloadUrl must be an http(s) URL without credentials or a fragment.');
  }
  if (url.pathname === '/' || url.pathname === '') throw new HttpError(400, 'downloadUrl must include a path.');
  return url.href;
}

// Parse a cache-this-source request: a magnet, a bare infohash, base64
// `.torrent` or NZB bytes, or a remote download URL (NZB or torrent, fetched
// later through the discovery-provider allowlist). Media is optional — an
// id-less item is reachable only through the My Library catalog.
export function parseStoreAdd(input: unknown): { source: TransferSource; media?: RecordMedia; keep: boolean; name?: string; queue: boolean; cachedOnly: boolean } {
  const b = objectRecord(input);
  if (!b) throw new HttpError(400, 'Provide a JSON object.');
  if (['source', 'magnet', 'infoHash', 'torrent', 'nzb', 'downloadUrl'].filter(k => b[k] !== undefined).length !== 1) {
    throw new HttpError(400, 'Provide exactly one magnet, infoHash, torrent, nzb, or downloadUrl.');
  }
  if (b.name !== undefined && (typeof b.name !== 'string' || b.name.length > 300 || CONTROL_CHARACTERS.test(b.name))) {
    throw new HttpError(400, 'name must be text up to 300 characters without control characters.');
  }
  if (b.queue !== undefined && b.queue !== true && b.queue !== false) throw new HttpError(400, 'queue must be a boolean.');
  if (b.cachedOnly !== undefined && b.cachedOnly !== true && b.cachedOnly !== false) throw new HttpError(400, 'cachedOnly must be a boolean.');
  let source: TransferSource;
  if (b.torrent !== undefined) {
    const bytes = decodeBase64(b.torrent, 'torrent', MAX_TORRENT);
    if (!bytes.length || !parseInfoHash(bytes)) throw new HttpError(400, 'That does not look like a .torrent file.');
    source = { torrent: bytes };
  } else if (b.nzb !== undefined) {
    const bytes = decodeBase64(b.nzb, 'nzb', MAX_NZB);
    if (!bytes.length || !isNzb(bytes)) throw new HttpError(400, 'That does not look like an NZB file.');
    source = { nzb: bytes };
  } else if (b.downloadUrl !== undefined) {
    if (typeof b.downloadUrl !== 'string') throw new HttpError(400, 'downloadUrl must be an http(s) URL.');
    source = { downloadUrl: httpDownloadUrl(b.downloadUrl.trim()) };
  } else {
    const value = b.source ?? b.magnet ?? b.infoHash;
    const raw = typeof value === 'string' ? value.trim() : '';
    const infoHash = parseHex40(raw);
    if (infoHash) source = { infoHash };
    else {
      try { source = { magnet: validateMagnet(raw) }; }
      catch { throw new HttpError(400, 'Provide a magnet link, a 40-character infohash, a .torrent file, an NZB, or a download URL.'); }
    }
  }
  let media: RecordMedia | undefined;
  if (b.media !== undefined && b.media !== null) {
    const m = objectRecord(b.media) ?? {};
    if (!/^tt\d{1,10}$/.test(String(m.imdbId))) throw new HttpError(400, 'media.imdbId must look like tt1234567.');
    if (m.type !== 'movie' && m.type !== 'series') throw new HttpError(400, 'media.type must be "movie" or "series".');
    media = { imdbId: m.imdbId as string, type: m.type };
    if (m.type === 'series') {
      if (!Number.isInteger(m.season) || (m.season as number) < 0 || !Number.isInteger(m.episode) || (m.episode as number) < 0) {
        throw new HttpError(400, 'A series needs a whole-number season and episode.');
      }
      media.season = m.season as number;
      media.episode = m.episode as number;
    }
  }
  return {
    source, keep: b.keep === true, queue: b.queue === true, cachedOnly: b.cachedOnly === true,
    ...(media ? { media } : {}), ...(typeof b.name === 'string' ? { name: b.name } : {}),
  };
}
