import { magnetInfoHash } from '../downloads/magnet.js';
import { HEX40, parseHex40 } from '../domain/ids.js';
import { objectRecord } from '../json.js';

export interface TransferMedia {
  imdbId: string;
  type: 'movie' | 'series';
  season?: number;
  episode?: number;
}

export type DirectTransferSource =
  | { infoHash: string }
  | { magnet: string }
  | { torrent: Buffer }
  | { nzb: Buffer };

export type TransferSource = DirectTransferSource | { downloadUrl: string };

// The subset of sources that can be persisted in a playback reference: raw
// `.torrent` bytes are added immediately, never deferred behind a link.
export type PersistableSource = { infoHash: string } | { magnet: string } | { downloadUrl: string };

export interface ResolvedTransferSource {
  bytes?: Buffer;
  magnet?: string;
  nzb?: Buffer;
}

export type TransferSourceResolver = (url: string, signal: AbortSignal) => Promise<ResolvedTransferSource>;

export interface TransferFileReference {
  id: number;
  path: string;
  bytes: number;
  marker: string;
}

export interface PrepareTransferRequest {
  source: TransferSource;
  origin: 'search' | 'store';
  name: string;
  bytes: number;
  media?: TransferMedia;
  selection?: {
    file: TransferFileReference;
    behavior: 'require-existing' | 'allow-select';
  };
}

export interface Transfer {
  id: string;
  name: string;
  bytes: number;
  addedAt: number;
  expiresAt: number;
  kept: boolean;
  lifecycle: string;
  media?: TransferMedia;
}

export interface TransferFile {
  id: string;
  path: string;
  bytes: number;
  progress: number;
  video: boolean;
  selected: boolean;
}

export interface TransferPreview {
  id: string;
  name: string;
  bytes: number;
  seeders?: number;
  files: TransferFile[];
}

export interface TransferStatus {
  state: 'queued' | 'downloading' | 'ready' | 'missing' | 'error';
  progress: number;
  bytes: number;
}

export interface TransferLink {
  url: string;
  name: string;
  file: TransferFile;
}

export interface TransferLinkRequest {
  title: string;
  bytes: number;
  transferId: string;
  file: TransferFileReference;
}

export interface TransferLinkIssuer {
  issue(requests: TransferLinkRequest[]): Promise<string[]>;
}

// The v1 infohash a source names up front, if any. `downloadUrl` sources only
// reveal one after the backend resolves them.
export function sourceInfoHash(source: TransferSource): string | undefined {
  if ('infoHash' in source) return parseHex40(source.infoHash);
  if ('magnet' in source) return magnetInfoHash(source.magnet);
  return undefined;
}

function isPersistableSource(value: unknown): value is PersistableSource {
  const source = objectRecord(value);
  if (!source || Object.keys(source).length !== 1) return false;
  if ('infoHash' in source) return typeof source.infoHash === 'string' && HEX40.test(source.infoHash);
  if ('magnet' in source) return typeof source.magnet === 'string' && source.magnet.startsWith('magnet:');
  if ('downloadUrl' in source) return typeof source.downloadUrl === 'string' && /^https?:\/\/\S+$/.test(source.downloadUrl);
  return false;
}

function isTransferMedia(value: unknown): value is TransferMedia {
  const media = objectRecord(value);
  if (!media) return false;
  if (!/^tt\d{1,10}$/.test(String(media.imdbId))) return false;
  if (media.type === 'movie') return media.season === undefined && media.episode === undefined;
  return media.type === 'series'
    && Number.isInteger(media.season) && (media.season as number) >= 0
    && Number.isInteger(media.episode) && (media.episode as number) >= 0;
}

function isSelection(value: unknown): value is PrepareTransferRequest['selection'] {
  const selection = objectRecord(value);
  if (!selection) return false;
  if (Object.keys(selection).sort().join() !== 'behavior,file') return false;
  if (selection.behavior !== 'require-existing' && selection.behavior !== 'allow-select') return false;
  const file = objectRecord(selection.file);
  return !!file && Object.keys(file).sort().join() === 'bytes,id,marker,path'
    && Number.isSafeInteger(file.id) && (file.id as number) >= 0
    && typeof file.path === 'string' && (file.path as string).length > 0
    && Number.isSafeInteger(file.bytes) && (file.bytes as number) > 0
    && typeof file.marker === 'string' && (file.marker as string).length > 0;
}

// A persisted playback reference must be a well-formed prepare request with a
// JSON-safe source (raw `.torrent` bytes are added immediately, never deferred).
// The byte-size cap is enforced by the reference store / link signer, not here.
export function isPrepareTransferRequest(value: unknown): value is PrepareTransferRequest {
  const request = objectRecord(value);
  if (!request) return false;
  if (Object.keys(request).some(key => !['source', 'origin', 'name', 'bytes', 'media', 'selection'].includes(key))) return false;
  if (!isPersistableSource(request.source)) return false;
  if (request.origin !== 'search' && request.origin !== 'store') return false;
  if (typeof request.name !== 'string' || !request.name) return false;
  if (typeof request.bytes !== 'number' || !Number.isFinite(request.bytes) || request.bytes < 0) return false;
  if (request.media !== undefined && !isTransferMedia(request.media)) return false;
  if (request.selection !== undefined && !isSelection(request.selection)) return false;
  return true;
}
