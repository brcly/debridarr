import { randomUUID } from 'node:crypto';

// A saved RSS/Torznab feed search. `titleInclude`/`titleExclude` are plain
// case-insensitive substring filters — good enough for "only x265" or "skip
// CAM" without pulling in a pattern language. `cachedOnly`/`queue` mirror the
// same-named `POST /api/v1/transfers` options (see Slice 1): a feed item is
// added exactly like a manual or API add, just triggered by a poll instead.
export interface SavedSearchSettings {
  id: string;
  feedUrl: string;
  protocol: 'torrent' | 'usenet';
  titleInclude: string;
  titleExclude: string;
  cachedOnly: boolean;
  queue: boolean;
  enabled: boolean;
}

export const savedSearchProtocols = ['torrent', 'usenet'] as const;

export function newSavedSearchId(): string {
  return randomUUID();
}
