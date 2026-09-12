import { atomicWriteJson } from './storage.js';
import { objectRecord } from './json.js';
import { emptyTorrentBackendSettings, backendProtocol, newBackendId, torrentBackendTypes, type PathMapping, type TorrentBackendSettings } from './backends/config.js';
import { discoveryProviderTypes, newDiscoveryProviderId, type DiscoveryProviderPreferences, type DiscoveryProviderSettings, type DiscoveryProviderType } from './discovery/config.js';
import { newSavedSearchId, savedSearchProtocols, type SavedSearchSettings } from './rss/config.js';
import { currentSettingsVersion } from './settings-migrations.js';

export class SettingsValidationError extends Error {}
export class SettingsStorageError extends Error {}
export const metadataProviders = ['cinemeta', 'tmdb'] as const;
export type MetadataProviderName = typeof metadataProviders[number];
// How Debridarr is fed content: `search` = its own Prowlarr-backed addon only;
// `store` = a debrid backend other addons push torrents into; `both` = either.
export const operatingModes = ['search', 'store', 'both'] as const;
export type OperatingMode = typeof operatingModes[number];
export interface Settings {
  setup: { completed: boolean };
  // `mode` gates route registration and what the addon manifest advertises;
  // nothing else in the request path branches on it.
  integrations: { mode: OperatingMode };
  store: { maxActiveDownloads: number };
  downloadBackend: TorrentBackendSettings;
  // The sole discovery configuration: search aggregates across every
  // configured provider. Each provider carries its own content preferences.
  discovery: { providers: DiscoveryProviderSettings[] };
  metadata: { provider: MetadataProviderName; tmdbApiKey: string };
  playback: { streamWhileDownloading: boolean };
  // `storeLeaseDays` is the lease for torrents added through the `store` front
  // door (no search), kept shorter than `days` because they accumulate faster.
  retention: { days: number; targetRatio: number; graceDays: number; extendOnPlay: boolean; maxCacheGB: number; storeLeaseDays: number; minFreeSpaceGB: number };
  // Fires on a transfer becoming managed/failed, or a confirmed deletion.
  connections: { webhookUrl: string; webhookSecret: string };
  // Feeds Debridarr polls on an interval, adding new matching items the same
  // way a manual or API add would. Poll status (last poll/error, recent
  // items) is runtime state, not settings — see src/rss/state.ts.
  rss: { searches: SavedSearchSettings[] };
}
export const emptySettings = (): Settings => ({
  setup: { completed: false },
  integrations: { mode: 'search' },
  store: { maxActiveDownloads: 20 },
  downloadBackend: emptyTorrentBackendSettings(),
  discovery: { providers: [] },
  metadata: { provider: 'cinemeta', tmdbApiKey: '' },
  playback: { streamWhileDownloading: false },
  retention: { days: 30, targetRatio: 1, graceDays: 0, extendOnPlay: true, maxCacheGB: 0, storeLeaseDays: 14, minFreeSpaceGB: 1 },
  connections: { webhookUrl: '', webhookSecret: '' },
  rss: { searches: [] },
});

// Numeric retention fields, their valid range, and whether they must be whole numbers.
const retentionRules = {
  minFreeSpaceGB: { min: 0, max: 1_000_000, integer: false },
  days: { min: 1, max: 3650, integer: true },
  targetRatio: { min: 0.1, max: 100, integer: false },
  graceDays: { min: 0, max: 3650, integer: true },
  maxCacheGB: { min: 0, max: 1_000_000, integer: false },
  storeLeaseDays: { min: 1, max: 3650, integer: true },
} as const;

// Retention fields are numbers/booleans, not strings, so they get their own
// patch logic instead of the secret/URL rules the other sections use. Every
// field is replaced in place; there is nothing to keep/clear.
function applyRetentionPatch(current: Settings['retention'], fields: Record<string, unknown>): Settings['retention'] {
  const next = { ...current };
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.hasOwn(next, key)) throw new SettingsValidationError('Unknown settings field');
    if (key === 'extendOnPlay') {
      if (typeof value !== 'boolean') throw new SettingsValidationError('retention.extendOnPlay must be a boolean');
      next.extendOnPlay = value;
      continue;
    }
    const rule = retentionRules[key as keyof typeof retentionRules];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max ||
        (rule.integer && !Number.isInteger(value))) {
      throw new SettingsValidationError(`retention.${key} must be a ${rule.integer ? 'whole ' : ''}number between ${rule.min} and ${rule.max}`);
    }
    next[key as keyof Omit<Settings['retention'], 'extendOnPlay'>] = value;
  }
  return next;
}

export const knownResolutions = [480, 720, 1080, 2160] as const;
const knownCodecs = ['x265', 'x264', 'av1', 'xvid'] as const;
const languageCodePattern = /^[a-z]{2}$/;

const emptyProviderPreferences = (): DiscoveryProviderPreferences => ({ languages: [], resolutions: [], codecs: [] });

// Preferences fields are arrays (allow-sets), not scalars, so they get their
// own patch logic. A provided array replaces the field wholesale; there is
// nothing to merge/append. Deduped, so repeated saves stay tidy. Scoped to one
// provider's preferences — each `discovery.providers[]` entry has its own.
function applyProviderPreferencesPatch(current: DiscoveryProviderPreferences, fields: Record<string, unknown>): DiscoveryProviderPreferences {
  const next = { ...current };
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.hasOwn(next, key)) throw new SettingsValidationError('Unknown settings field');
    if (!Array.isArray(value)) throw new SettingsValidationError(`preferences.${key} must be an array`);
    if (key === 'languages') {
      if (!value.every(v => typeof v === 'string' && languageCodePattern.test(v))) {
        throw new SettingsValidationError('preferences.languages must each be a 2-letter lowercase language code');
      }
      next.languages = [...new Set(value as string[])];
    } else if (key === 'resolutions') {
      if (!value.every(v => knownResolutions.includes(v as typeof knownResolutions[number]))) {
        throw new SettingsValidationError(`preferences.resolutions must each be one of: ${knownResolutions.join(', ')}`);
      }
      next.resolutions = [...new Set(value as number[])] as DiscoveryProviderPreferences['resolutions'];
    } else if (key === 'codecs') {
      if (!value.every(v => knownCodecs.includes(v as typeof knownCodecs[number]))) {
        throw new SettingsValidationError(`preferences.codecs must each be one of: ${knownCodecs.join(', ')}`);
      }
      next.codecs = [...new Set(value as string[])] as DiscoveryProviderPreferences['codecs'];
    }
  }
  return next;
}

// One enum field. Kept separate from the string sections so it never picks up
// the keep/clear secret rules or URL normalisation.
function applyIntegrationsPatch(current: Settings['integrations'], fields: Record<string, unknown>): Settings['integrations'] {
  const next = { ...current };
  for (const [key, value] of Object.entries(fields)) {
    if (key !== 'mode') throw new SettingsValidationError('Unknown settings field');
    if (typeof value !== 'string' || !operatingModes.includes(value as OperatingMode)) {
      throw new SettingsValidationError(`integrations.mode must be one of: ${operatingModes.join(', ')}`);
    }
    next.mode = value as OperatingMode;
  }
  return next;
}

// Stricter than the generic `url()` below: a webhook target must be HTTPS,
// since the body can carry a title and the signature secret guards against
// tampering, not eavesdropping.
function webhookUrl(value: string): string {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    throw new SettingsValidationError('connections.webhookUrl must be an HTTPS URL without credentials, query, or fragment');
  }
}

function applyConnectionsPatch(current: Settings['connections'], fields: Record<string, unknown>): Settings['connections'] {
  const next = { ...current };
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'webhookUrl') {
      if (typeof value !== 'string') throw new SettingsValidationError('connections.webhookUrl must be text');
      next.webhookUrl = webhookUrl(value.trim());
      continue;
    }
    if (key !== 'webhookSecret') throw new SettingsValidationError('Unknown settings field');
    if (value === null) { next.webhookSecret = ''; continue; }
    if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new SettingsValidationError('connections.webhookSecret must be text without control characters (maximum 4096 characters)');
    }
    if (value === '') throw new SettingsValidationError('Omit connections.webhookSecret to keep it, or use null to clear it');
    next.webhookSecret = value;
  }
  return next;
}

function record(value: unknown): Record<string, unknown> {
  const parsed = objectRecord(value);
  if (!parsed) throw new SettingsValidationError('Settings must be a JSON object');
  return parsed;
}

function url(value: string, field: string): string {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.search || parsed.hash) throw new Error();
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    throw new SettingsValidationError(`${field} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
}

function absolutePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || !value.startsWith('/')) {
    throw new SettingsValidationError(`${field} must be an absolute path without control characters`);
  }
  const normalized = value.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  if (normalized.split('/').some(part => part === '..' || part === '.')) {
    throw new SettingsValidationError(`${field} cannot contain dot path segments`);
  }
  return normalized;
}

function pathMappings(value: unknown): PathMapping[] {
  if (!Array.isArray(value) || value.length > 20) throw new SettingsValidationError('downloadBackend.pathMappings must be an array with at most 20 entries');
  const mappings = value.map((entry, index) => {
    const fields = record(entry);
    if (Object.keys(fields).length !== 2 || !Object.hasOwn(fields, 'remote') || !Object.hasOwn(fields, 'local')) {
      throw new SettingsValidationError(`downloadBackend.pathMappings[${index}] must contain remote and local paths`);
    }
    return {
      remote: absolutePath(fields.remote, `downloadBackend.pathMappings[${index}].remote`),
      local: absolutePath(fields.local, `downloadBackend.pathMappings[${index}].local`),
    };
  });
  if (new Set(mappings.map(mapping => mapping.remote)).size !== mappings.length) {
    throw new SettingsValidationError('downloadBackend.pathMappings cannot contain the same remote path more than once');
  }
  return mappings;
}

function applyDownloadBackendPatch(current: TorrentBackendSettings, fields: Record<string, unknown>): TorrentBackendSettings {
  const next = structuredClone(current);
  for (const [key, rawValue] of Object.entries(fields)) {
    if (key === 'id') throw new SettingsValidationError('downloadBackend.id cannot be changed');
    // Derived from the type, not client-settable: a patch may echo it back
    // (publicSettings exposes it) but it never changes on its own.
    if (key === 'protocol') continue;
    if (key === 'type') {
      if (typeof rawValue !== 'string' || !torrentBackendTypes.includes(rawValue as TorrentBackendSettings['type'])) {
        throw new SettingsValidationError(`downloadBackend.type must be one of: ${torrentBackendTypes.join(', ')}`);
      }
      if (rawValue !== next.type) next.id = newBackendId();
      next.type = rawValue as TorrentBackendSettings['type'];
      next.protocol = backendProtocol(next.type);
      continue;
    }
    if (key === 'pathMappings') { next.pathMappings = pathMappings(rawValue); continue; }
    if (key !== 'url' && key !== 'username' && key !== 'password') throw new SettingsValidationError('Unknown settings field');
    const secret = key === 'password';
    if (rawValue === null && secret) { next.password = ''; continue; }
    if (typeof rawValue !== 'string' || rawValue.length > 4096 || /[\x00-\x1f\x7f]/.test(rawValue)) {
      throw new SettingsValidationError(`downloadBackend.${key} must be text without control characters (maximum 4096 characters)`);
    }
    if (secret && rawValue === '') throw new SettingsValidationError('Omit downloadBackend.password to keep it, or use null to clear it');
    next[key] = key === 'url' ? url(rawValue.trim(), 'downloadBackend.url') : secret ? rawValue : rawValue.trim();
  }
  return next;
}

const discoveryProviderIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

// The array is replaced wholesale, but secrets may be omitted for an existing
// provider. Matching by stable id lets the admin UI keep a saved key without
// ever receiving it. null or an empty string clears a key; other strings
// replace it. Preferences follow the same preserve-by-id rule: omitted on an
// update keeps the saved allow-sets, omitted on a new entry defaults to "no
// filter", and a supplied object is validated field by field.
function discoveryProviders(value: unknown, current: DiscoveryProviderSettings[]): DiscoveryProviderSettings[] {
  if (!Array.isArray(value) || value.length > 10) {
    throw new SettingsValidationError('discovery.providers must be an array with at most 10 entries');
  }
  const providers = value.map((entry, index) => {
    const fields = record(entry);
    const allowedKeys = ['id', 'type', 'url', 'apiKey', 'preferences'];
    if (!['type', 'url'].every(key => Object.hasOwn(fields, key)) || Object.keys(fields).some(key => !allowedKeys.includes(key))) {
      throw new SettingsValidationError(`discovery.providers[${index}] must contain type and url, and may contain id, apiKey, and preferences`);
    }
    if (typeof fields.type !== 'string' || !discoveryProviderTypes.includes(fields.type as DiscoveryProviderType)) {
      throw new SettingsValidationError(`discovery.providers[${index}].type must be one of: ${discoveryProviderTypes.join(', ')}`);
    }
    if (typeof fields.url !== 'string') throw new SettingsValidationError(`discovery.providers[${index}].url must be text`);
    const id = Object.hasOwn(fields, 'id') && fields.id ? fields.id : newDiscoveryProviderId();
    if (typeof id !== 'string' || !discoveryProviderIdPattern.test(id)) {
      throw new SettingsValidationError(`discovery.providers[${index}].id is invalid`);
    }
    const saved = current.find(provider => provider.id === id);
    const rawApiKey = Object.hasOwn(fields, 'apiKey') ? fields.apiKey : saved?.apiKey ?? '';
    if (rawApiKey !== null && (typeof rawApiKey !== 'string' || rawApiKey.length > 4096 || /[\x00-\x1f\x7f]/.test(rawApiKey))) {
      throw new SettingsValidationError(`discovery.providers[${index}].apiKey must be text without control characters (maximum 4096 characters)`);
    }
    const basePreferences = saved?.preferences ?? emptyProviderPreferences();
    const preferences = Object.hasOwn(fields, 'preferences')
      ? applyProviderPreferencesPatch(basePreferences, record(fields.preferences))
      : basePreferences;
    return {
      id, type: fields.type as DiscoveryProviderType,
      url: url(fields.url.trim(), `discovery.providers[${index}].url`), apiKey: rawApiKey ?? '',
      preferences,
    } as DiscoveryProviderSettings;
  });
  if (new Set(providers.map(provider => provider.id)).size !== providers.length) {
    throw new SettingsValidationError('discovery.providers cannot contain the same id more than once');
  }
  return providers;
}

function applyDiscoveryPatch(current: Settings['discovery'], fields: Record<string, unknown>): Settings['discovery'] {
  const next = { ...current };
  for (const [key, value] of Object.entries(fields)) {
    if (key !== 'providers') throw new SettingsValidationError('Unknown settings field');
    next.providers = discoveryProviders(value, current.providers);
  }
  return next;
}

const savedSearchIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Unlike `url()` below, a feed URL keeps its query string — that's how a
// Torznab/Newznab "copy RSS link" encodes the search and its API key — and
// allows plain HTTP, since self-hosted indexers are often LAN-only.
function feedUrl(value: string, field: string): string {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    return parsed.toString();
  } catch {
    throw new SettingsValidationError(`${field} must be an HTTP(S) URL without credentials`);
  }
}

function titleFilter(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new SettingsValidationError(`${field} must be text without control characters (maximum 200 characters)`);
  }
  return value.trim();
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new SettingsValidationError(`${field} must be a boolean`);
  return value;
}

// The array is replaced wholesale, but a stable id lets the admin UI keep an
// existing search's omitted fields (its filters, or `enabled`) unchanged
// across an edit, same as `discoveryProviders` above.
function savedSearches(value: unknown, current: SavedSearchSettings[]): SavedSearchSettings[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new SettingsValidationError('rss.searches must be an array with at most 20 entries');
  }
  const searches = value.map((entry, index) => {
    const fields = record(entry);
    const allowedKeys = ['id', 'feedUrl', 'protocol', 'titleInclude', 'titleExclude', 'cachedOnly', 'queue', 'enabled'];
    if (!['feedUrl', 'protocol'].every(key => Object.hasOwn(fields, key)) || Object.keys(fields).some(key => !allowedKeys.includes(key))) {
      throw new SettingsValidationError(`rss.searches[${index}] must contain feedUrl and protocol, and may contain id, titleInclude, titleExclude, cachedOnly, queue, and enabled`);
    }
    if (typeof fields.protocol !== 'string' || !savedSearchProtocols.includes(fields.protocol as typeof savedSearchProtocols[number])) {
      throw new SettingsValidationError(`rss.searches[${index}].protocol must be one of: ${savedSearchProtocols.join(', ')}`);
    }
    if (typeof fields.feedUrl !== 'string') throw new SettingsValidationError(`rss.searches[${index}].feedUrl must be text`);
    const id = Object.hasOwn(fields, 'id') && fields.id ? fields.id : newSavedSearchId();
    if (typeof id !== 'string' || !savedSearchIdPattern.test(id)) {
      throw new SettingsValidationError(`rss.searches[${index}].id is invalid`);
    }
    const saved = current.find(search => search.id === id);
    return {
      id, feedUrl: feedUrl(fields.feedUrl.trim(), `rss.searches[${index}].feedUrl`),
      protocol: fields.protocol as typeof savedSearchProtocols[number],
      titleInclude: Object.hasOwn(fields, 'titleInclude') ? titleFilter(fields.titleInclude, `rss.searches[${index}].titleInclude`) : saved?.titleInclude ?? '',
      titleExclude: Object.hasOwn(fields, 'titleExclude') ? titleFilter(fields.titleExclude, `rss.searches[${index}].titleExclude`) : saved?.titleExclude ?? '',
      cachedOnly: Object.hasOwn(fields, 'cachedOnly') ? requireBoolean(fields.cachedOnly, `rss.searches[${index}].cachedOnly`) : saved?.cachedOnly ?? false,
      queue: Object.hasOwn(fields, 'queue') ? requireBoolean(fields.queue, `rss.searches[${index}].queue`) : saved?.queue ?? false,
      enabled: Object.hasOwn(fields, 'enabled') ? requireBoolean(fields.enabled, `rss.searches[${index}].enabled`) : saved?.enabled ?? true,
    };
  });
  if (new Set(searches.map(search => search.id)).size !== searches.length) {
    throw new SettingsValidationError('rss.searches cannot contain the same id more than once');
  }
  return searches;
}

function applyRssPatch(current: Settings['rss'], fields: Record<string, unknown>): Settings['rss'] {
  const next = { ...current };
  for (const [key, value] of Object.entries(fields)) {
    if (key !== 'searches') throw new SettingsValidationError('Unknown settings field');
    next.searches = savedSearches(value, current.searches);
  }
  return next;
}

// Omitted fields are kept; null explicitly clears secrets. Blank secrets are not masks.
export function applySettingsPatch(current: Settings, input: unknown): Settings {
  const patch = record(input);
  const result = structuredClone(current);
  for (const [section, rawFields] of Object.entries(patch)) {
    if (section !== 'setup' && section !== 'store' && section !== 'integrations' && section !== 'downloadBackend' && section !== 'discovery' && section !== 'metadata' && section !== 'playback' && section !== 'retention' && section !== 'connections' && section !== 'rss') {
      throw new SettingsValidationError('Unknown settings section');
    }
    const fields = record(rawFields);
    if (section === 'setup') {
      for (const [key, value] of Object.entries(fields)) {
        if (key !== 'completed' || typeof value !== 'boolean') throw new SettingsValidationError('setup.completed must be a boolean');
        result.setup.completed = value;
      }
      continue;
    }
    if (section === 'store') {
      for (const [key, value] of Object.entries(fields)) {
        if (key !== 'maxActiveDownloads' || !Number.isInteger(value) || (value as number) < 1 || (value as number) > 1000) throw new SettingsValidationError('store.maxActiveDownloads must be a whole number between 1 and 1000');
        result.store.maxActiveDownloads = value as number;
      }
      continue;
    }
    if (section === 'integrations') {
      result.integrations = applyIntegrationsPatch(result.integrations, fields);
      continue;
    }
    if (section === 'downloadBackend') {
      result.downloadBackend = applyDownloadBackendPatch(result.downloadBackend, fields);
      continue;
    }
    if (section === 'discovery') {
      result.discovery = applyDiscoveryPatch(result.discovery, fields);
      continue;
    }
    if (section === 'playback') {
      for (const [key, value] of Object.entries(fields)) {
        if (key !== 'streamWhileDownloading' || typeof value !== 'boolean') {
          throw new SettingsValidationError('playback.streamWhileDownloading must be a boolean');
        }
        result.playback.streamWhileDownloading = value;
      }
      continue;
    }
    if (section === 'retention') {
      result.retention = applyRetentionPatch(result.retention, fields);
      continue;
    }
    if (section === 'connections') {
      result.connections = applyConnectionsPatch(result.connections, fields);
      continue;
    }
    if (section === 'rss') {
      result.rss = applyRssPatch(result.rss, fields);
      continue;
    }
    const target = result[section] as Record<string, string>;
    for (const [key, rawValue] of Object.entries(fields)) {
      if (!Object.hasOwn(target, key)) throw new SettingsValidationError('Unknown settings field');
      const secret = key === 'apiKey' || key === 'password' || key === 'tmdbApiKey';
      if (rawValue === null && secret) { target[key] = ''; continue; }
      if (typeof rawValue !== 'string' || rawValue.length > 4096 || /[\x00-\x1f\x7f]/.test(rawValue)) {
        throw new SettingsValidationError(`${section}.${key} must be text without control characters (maximum 4096 characters)`);
      }
      const value = secret ? rawValue : rawValue.trim();
      if (secret && value === '') throw new SettingsValidationError(`Omit ${section}.${key} to keep it, or use null to clear it`);
      if (key === 'provider' && !metadataProviders.includes(value as MetadataProviderName)) {
        throw new SettingsValidationError(`metadata.provider must be one of: ${metadataProviders.join(', ')}`);
      }
      target[key] = key === 'url' ? url(value, `${section}.url`) : value;
    }
  }
  return result;
}

export function seedSettings(env: NodeJS.ProcessEnv): Settings {
  const metadata: Record<string, string | null> = {
    tmdbApiKey: env.TMDB_API_KEY?.trim() ? env.TMDB_API_KEY : null,
  };
  if (env.METADATA_PROVIDER?.trim()) metadata.provider = env.METADATA_PROVIDER;
  const integrations: Record<string, string> = {};
  if (env.DEBRIDARR_MODE?.trim()) integrations.mode = env.DEBRIDARR_MODE.trim();
  const settings = applySettingsPatch(emptySettings(), {
    ...(Object.keys(integrations).length ? { integrations } : {}),
    // Blank means unset: an empty PROWLARR_URL seeds no provider at all,
    // rather than an empty-url provider row.
    ...(env.PROWLARR_URL ? { discovery: { providers: [{
      type: 'prowlarr', url: env.PROWLARR_URL,
      apiKey: env.PROWLARR_API_KEY?.trim() ? env.PROWLARR_API_KEY : null,
    }] } } : {}),
    downloadBackend: {
      url: env.QBITTORRENT_URL ?? '', username: env.QBITTORRENT_USERNAME ?? '',
      password: env.QBITTORRENT_PASSWORD?.trim() ? env.QBITTORRENT_PASSWORD : null,
    },
    metadata,
  });
  settings.downloadBackend.id = newBackendId();
  return settings;
}

export function publicSettings(settings: Settings) {
  return {
    setup: { ...settings.setup },
    integrations: { ...settings.integrations },
    store: { ...settings.store },
    downloadBackend: {
      id: settings.downloadBackend.id,
      type: settings.downloadBackend.type,
      protocol: settings.downloadBackend.protocol,
      url: settings.downloadBackend.url,
      username: settings.downloadBackend.username,
      pathMappings: settings.downloadBackend.pathMappings,
      hasPassword: !!settings.downloadBackend.password,
    },
    discovery: { providers: settings.discovery.providers.map(provider => ({
      id: provider.id, type: provider.type, url: provider.url, hasApiKey: !!provider.apiKey,
      preferences: provider.preferences,
    })) },
    metadata: { provider: settings.metadata.provider, hasTmdbApiKey: !!settings.metadata.tmdbApiKey },
    playback: { ...settings.playback },
    retention: { ...settings.retention },
    connections: { webhookUrl: settings.connections.webhookUrl, hasWebhookSecret: !!settings.connections.webhookSecret },
    rss: { searches: settings.rss.searches.map(search => ({ ...search })) },
  };
}

export async function writeSettings(path: string, settings: Settings): Promise<void> {
  await atomicWriteJson(path, { version: currentSettingsVersion, settings });
}

export { JsonSettingsStore as SettingsStore } from './state/json/settings.js';
export { currentSettingsVersion, readSavedSettings } from './settings-migrations.js';
