import { randomUUID } from 'node:crypto';

// Allow-sets, not caps/single values: empty means no filter. Checking a box
// is itself the requirement — there's no separate "require" toggle. Carried
// per provider so one installation can take 1080p from its torrent indexers
// and 2160p from a Usenet one.
export interface DiscoveryProviderPreferences {
  languages: string[];
  resolutions: (480 | 720 | 1080 | 2160)[];
  codecs: ('x265' | 'x264' | 'av1' | 'xvid')[];
}

export interface ProwlarrDiscoveryProviderSettings {
  id: string;
  type: 'prowlarr';
  url: string;
  apiKey: string;
  preferences: DiscoveryProviderPreferences;
}

// A direct Torznab/Newznab indexer endpoint, searched without an aggregator
// in front of it. Shape matches Prowlarr's on purpose (apiKey is allowed to
// be an empty string here, since public indexers often don't require one).
export interface TorznabDiscoveryProviderSettings {
  id: string;
  type: 'torznab';
  url: string;
  apiKey: string;
  preferences: DiscoveryProviderPreferences;
}

export type DiscoveryProviderSettings = ProwlarrDiscoveryProviderSettings | TorznabDiscoveryProviderSettings;
export const discoveryProviderTypes = ['prowlarr', 'torznab'] as const;
export type DiscoveryProviderType = typeof discoveryProviderTypes[number];

export function newDiscoveryProviderId(): string {
  return randomUUID();
}
