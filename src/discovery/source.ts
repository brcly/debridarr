import type { ConnectionResult } from '../integrations/http.js';

// Newznab category ids. Independent of any specific indexer or aggregator so
// additional release sources (direct Torznab, RSS, manual entry) can be added
// without touching search or the addon layer.
export const MOVIE_CATEGORIES = [2000];
export const SERIES_CATEGORIES = [5000];

export interface Release {
  title: string;
  size: number;
  seeders: number;
  leechers: number;
  indexer: string;
  protocol: 'torrent' | 'usenet';
  guid: string;
  infoHash?: string;
  magnetUrl?: string;
  downloadUrl?: string;
  publishDate?: string;
}

// The contract every discovery adapter (Prowlarr today; direct Torznab/RSS
// later) implements. Search and the addon layer depend only on this, not on
// any concrete adapter, so a new source does not change either.
export interface ReleaseSource {
  readonly configured: boolean;
  test(timeoutMs?: number): Promise<ConnectionResult>;
  search(query: string, signal: AbortSignal, categories?: readonly number[]): Promise<Release[]>;
}
