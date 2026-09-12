export interface RetentionSettings { storeLeaseDays: number; days: number; targetRatio: number; graceDays: number; extendOnPlay: boolean; maxCacheGB: number; minFreeSpaceGB: number }
export interface PlaybackSettings { streamWhileDownloading: boolean }
export interface PreferencesSettings { languages: string[]; resolutions: number[]; codecs: string[] }
export interface PathMapping { remote: string; local: string }
export interface BackendFieldDescriptor { key: 'url' | 'username' | 'password'; label: string; input: 'url' | 'text' | 'password'; secret?: boolean; required?: boolean; placeholder: string }
export interface BackendDescriptor { type: string; label: string; description: string; protocol: 'torrent' | 'usenet'; fields: BackendFieldDescriptor[] }
export interface DiscoveryFieldDescriptor { key: 'url' | 'apiKey'; label: string; input: 'url' | 'text' | 'password'; secret?: boolean; required?: boolean; placeholder: string }
export interface DiscoveryProviderDescriptor { type: string; label: string; description: string; fields: DiscoveryFieldDescriptor[] }
export interface PublicDiscoveryProvider { id: string; type: string; url: string; hasApiKey: boolean; preferences: PreferencesSettings }
export interface DiscoveryProviderDraft { id?: string; type: string; url: string; apiKey?: string | null; preferences: PreferencesSettings }
export interface SavedSearchFields { feedUrl: string; protocol: 'torrent' | 'usenet'; titleInclude: string; titleExclude: string; cachedOnly: boolean; queue: boolean; enabled: boolean }
export interface PublicSavedSearch extends SavedSearchFields { id: string }
export interface SavedSearchDraft extends SavedSearchFields { id?: string }
export interface SavedSearchItem { guid: string; title: string; seenAt: number; status: 'added' | 'ignored' | 'error'; error?: string }
export interface SavedSearchState { lastPolledAt?: number; lastError?: string; items: SavedSearchItem[] }

export interface Draft {
  integrations: { mode: string };
  store: { maxActiveDownloads: number };
  downloadBackend: Record<string, unknown>;
  discovery: { providers: DiscoveryProviderDraft[] };
  metadata: Record<string, string | null>;
  playback: PlaybackSettings;
  retention: RetentionSettings;
  connections: { webhookUrl: string; webhookSecret?: string | null };
  rss: { searches: SavedSearchDraft[] };
}

export interface PublicSettings {
  setup: { completed: boolean };
  integrations: { mode: string };
  store: { maxActiveDownloads: number };
  downloadBackend: { id: string; type: string; protocol: 'torrent' | 'usenet'; url: string; username: string; pathMappings: PathMapping[]; hasPassword: boolean };
  discovery: { providers: PublicDiscoveryProvider[] };
  metadata: { provider: string; hasTmdbApiKey: boolean };
  playback: PlaybackSettings;
  retention: RetentionSettings;
  connections: { webhookUrl: string; hasWebhookSecret: boolean };
  rss: { searches: PublicSavedSearch[] };
}

export interface SettingsResponse {
  settings: PublicSettings;
  backends: BackendDescriptor[];
  discoveryProviders: DiscoveryProviderDescriptor[];
  deployment: { appUrl: string; port: number; downloadDir: string };
}

export interface DownloadView {
  retentionStatus?: string;
  lifecycle?: string;
  failure?: string | null;
  origin?: 'search' | 'store';
  infoHash: string;
  name: string;
  imdbId: string | null;
  type: 'movie' | 'series' | null;
  season?: number;
  episode?: number;
  bytes: number;
  addedAt: number;
  expiresAt: number;
  kept: boolean;
  ratio: number | null;
  progress: number | null;
  state: string | null;
  eta: number | null;
}

export type AdminApi = <T>(path: string, method?: string, data?: unknown) => Promise<T>;
