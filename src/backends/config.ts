import { createHash, randomUUID } from 'node:crypto';
import type { DownloadProtocol, PathMapping } from './download.js';

export type { PathMapping };

// `apiKey` is carried on every backend type for a uniform downloadBackend
// shape (the same convention already used for `username`, which Deluge's
// own form never exposes either) but is only meaningful for qbittorrent:
// its >=5.2.0 API key (Authorization: Bearer), an alternative to
// username/password that takes priority when set and skips the
// session-cookie login flow entirely.
export interface QBittorrentBackendSettings {
  id: string;
  type: 'qbittorrent';
  protocol: DownloadProtocol;
  url: string;
  username: string;
  password: string;
  apiKey: string;
  pathMappings: PathMapping[];
}

export interface TransmissionBackendSettings {
  id: string;
  type: 'transmission';
  protocol: DownloadProtocol;
  url: string;
  username: string;
  password: string;
  apiKey: string;
  pathMappings: PathMapping[];
}

export interface DelugeBackendSettings {
  id: string;
  type: 'deluge';
  protocol: DownloadProtocol;
  url: string;
  username: string;
  password: string;
  apiKey: string;
  pathMappings: PathMapping[];
}

export interface SabnzbdBackendSettings {
  id: string;
  type: 'sabnzbd';
  protocol: DownloadProtocol;
  url: string;
  username: string;
  password: string;
  apiKey: string;
  pathMappings: PathMapping[];
}

export type TorrentBackendSettings = QBittorrentBackendSettings | TransmissionBackendSettings | DelugeBackendSettings | SabnzbdBackendSettings;
export const torrentBackendTypes = ['qbittorrent', 'transmission', 'deluge', 'sabnzbd'] as const;
export type TorrentBackendType = typeof torrentBackendTypes[number];

// The protocol each registered client speaks. Kept beside the types so
// settings can derive (and migration can default) `protocol` without
// depending on the adapter registry.
const backendProtocols: Record<TorrentBackendType, DownloadProtocol> = {
  qbittorrent: 'torrent',
  transmission: 'torrent',
  deluge: 'torrent',
  sabnzbd: 'usenet',
};

export const backendProtocol = (type: TorrentBackendType): DownloadProtocol => backendProtocols[type];

export function emptyTorrentBackendSettings(): TorrentBackendSettings {
  return { id: 'default', type: 'qbittorrent', protocol: 'torrent', url: '', username: '', password: '', apiKey: '', pathMappings: [] };
}

// Matches the identity used before backend instances had persisted IDs, so an
// upgraded installation keeps ownership of its existing downloads.
export function legacyBackendId(url: string): string {
  return createHash('sha256').update(JSON.stringify({ url })).digest('hex');
}

export function newBackendId(): string {
  return randomUUID();
}
