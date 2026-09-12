import type { BackendOwnership } from '../backends/torrent.js';
import { objectRecord } from '../json.js';

export class DownloadsStorageError extends Error {}

// The media a download represents. Present for every `search` record and for a
// `store` record whose caller supplied an id; absent for a bare magnet added
// through the store front door (reachable only by its `db:` id).
export interface RecordMedia {
  imdbId: string;
  type: 'movie' | 'series';
  season?: number;
  episode?: number;
}

export interface DownloadRecord {
  // `search` = added by Debridarr's own Prowlarr-backed addon; `store` = pushed
  // in through the admin panel or the /store API by another addon.
  origin: 'search' | 'store';
  infoHash: string;
  name: string;
  media?: RecordMedia;
  fileIndex: number;
  fileName: string;
  bytes: number;
  addedAt: number;
  expiresAt: number;
  kept: boolean;
  lifecycle?: 'registering' | 'managed' | 'failed' | 'deleting' | 'conflict' | 'queued';
  owner?: BackendOwnership;
  // Present only while `lifecycle === 'queued'`: enough to submit later without
  // a second client round-trip. Dropped when the transfer is admitted.
  queuedSource?: QueuedSource;
  // `auto` marks a file enqueued to fill out a season pack rather than one the
  // user explicitly played — it only becomes a browsable copy once downloaded.
  selectedFiles?: { index: number; name: string; bytes: number; auto?: boolean; media?: RecordMedia }[];
  failure?: string;
}

export type QueuedSource =
  | { infoHash: string }
  | { magnet: string }
  | { torrent: string }
  | { nzb: string }
  | { downloadUrl: string };

export const FILE = 'downloads.json';

export function toQueuedSource(source:
  | { infoHash: string }
  | { magnet: string }
  | { torrent: Buffer }
  | { nzb: Buffer }
  | { downloadUrl: string }
): QueuedSource {
  if ('infoHash' in source) return { infoHash: source.infoHash.toLowerCase() };
  if ('magnet' in source) return { magnet: source.magnet };
  if ('torrent' in source) return { torrent: source.torrent.toString('base64') };
  if ('nzb' in source) return { nzb: source.nzb.toString('base64') };
  return { downloadUrl: source.downloadUrl };
}

export function isQueuedSource(value: unknown): value is QueuedSource {
  const o = objectRecord(value);
  if (!o) return false;
  const keys = Object.keys(o);
  if (keys.length !== 1) return false;
  if (typeof o.infoHash === 'string') return /^[a-f0-9]{40}$/i.test(o.infoHash);
  if (typeof o.magnet === 'string') return o.magnet.startsWith('magnet:');
  if (typeof o.downloadUrl === 'string') return /^https?:\/\//.test(o.downloadUrl);
  if (typeof o.torrent === 'string') return o.torrent.length > 0;
  if (typeof o.nzb === 'string') return o.nzb.length > 0;
  return false;
}

function isMedia(value: unknown): value is RecordMedia {
  const m = objectRecord(value);
  if (!m) return false;
  return /^tt\d{1,10}$/.test(String(m.imdbId))
    && (m.type === 'movie' || m.type === 'series')
    && (m.season === undefined || (Number.isInteger(m.season) && (m.season as number) >= 0))
    && (m.episode === undefined || (Number.isInteger(m.episode) && (m.episode as number) >= 0));
}

// Schema 1/2 records had flat imdbId/type/season/episode and no origin; lift
// them into `media` and mark them `search`.
export function migrateLegacyRecord(value: unknown): unknown {
  const record = objectRecord(value);
  if (!record) return value;
  const { imdbId, type, season, episode, ...rest } = record;
  return {
    origin: 'search',
    media: { imdbId, type, ...(season === undefined ? {} : { season }), ...(episode === undefined ? {} : { episode }) },
    ...rest,
  };
}

// Schema 1-3 named ownership after qBittorrent categories and tags. Preserve
// those values while moving the record to backend-neutral terminology.
export function migrateOwnership(value: unknown): unknown {
  const record = objectRecord(value);
  if (!record) return value;
  const owner = objectRecord(record.owner);
  if (!owner) return value;
  if (typeof owner.client !== 'string' || typeof owner.category !== 'string' || typeof owner.tag !== 'string') return value;
  return { ...record, owner: { backend: owner.client, scope: owner.category, marker: owner.tag } };
}

export function isRecord(value: unknown): value is DownloadRecord {
  const r = objectRecord(value);
  if (!r) return false;
  const owner = objectRecord(r.owner);
  return /^[a-f0-9]{40}$/.test(String(r.infoHash))
    && typeof r.name === 'string'
    && ((r.origin === 'search' && isMedia(r.media))
      || (r.origin === 'store' && (r.media === undefined || isMedia(r.media))))
    && Number.isInteger(r.fileIndex) && (r.fileIndex as number) >= 0
    && typeof r.fileName === 'string'
    && Number.isFinite(r.bytes) && (r.bytes as number) >= 0
    && Number.isFinite(r.addedAt) && Number.isFinite(r.expiresAt)
    && typeof r.kept === 'boolean'
    && (r.lifecycle === undefined || ['registering','managed','failed','deleting','conflict','queued'].includes(String(r.lifecycle)))
    && (r.queuedSource === undefined || isQueuedSource(r.queuedSource))
    && (r.owner === undefined || (!!owner && typeof owner.backend === 'string' && typeof owner.marker === 'string' && typeof owner.scope === 'string'))
    && (r.selectedFiles === undefined || (Array.isArray(r.selectedFiles) && r.selectedFiles.every(f => f && Number.isInteger(f.index) && f.index >= 0 && typeof f.name === 'string' && Number.isFinite(f.bytes) && f.bytes >= 0
      && (f.auto === undefined || typeof f.auto === 'boolean')
      && (f.media === undefined || (f.media && /^tt\d{1,10}$/.test(f.media.imdbId) && (f.media.type === 'movie'
        || (f.media.type === 'series' && Number.isInteger(f.media.season) && f.media.season >= 0 && Number.isInteger(f.media.episode) && f.media.episode >= 0)))))))
    && (r.failure === undefined || typeof r.failure === 'string');
}

export function normalize(record: DownloadRecord): DownloadRecord {
  return structuredClone({ ...record, infoHash: record.infoHash.toLowerCase() });
}

export { JsonDownloadsStore as DownloadsStore } from '../state/json/downloads.js';
