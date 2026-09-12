import { legacyBackendId } from './backends/config.js';
import { objectRecord } from './json.js';
import { applySettingsPatch, emptySettings, knownResolutions, type Settings } from './settings.js';

export const currentSettingsVersion = 17;

// Settings schema history, oldest first:
//    1  prowlarr + qbittorrent
//    2  + metadata
//    3  + retention
//    4  + preferences (single language + result cap)
//    5  preferences become allow-sets (languages, resolutions)
//    6  + codecs allow-set
//    7  + integrations, retention.storeLeaseDays
//    8  + store.maxActiveDownloads
//    9  + first-run setup state
//   10  + retention.minFreeSpaceGB
//   11  + playback.streamWhileDownloading (opt-in)
//   12  qbittorrent becomes a typed downloadBackend with a stable ID and path maps
//   13  + discovery.providers (empty by default; prowlarr is still seeded separately)
//   14  downloadBackend carries its protocol ('torrent' today), derived from the type
//   15  discovery providers carry their own preferences; prowlarr/preferences sections removed
//   16  + connections.webhookUrl / webhookSecret (completion webhook)
//   17  + rss.searches (saved RSS/Torznab searches)
// An older file is migrated in memory: missing sections fall back to their
// defaults and the file is rewritten at the current version on the next save.
const settingsSections = [
  ['prowlarr', 1, 15],
  ['metadata', 2],
  ['retention', 3],
  ['preferences', 4, 15],
  ['integrations', 7],
  ['store', 8],
  ['setup', 9],
  ['playback', 11],
  ['downloadBackend', 12],
  ['discovery', 13],
  ['connections', 16],
  ['rss', 17],
] as const;

function invalidSavedSettings(path: string, expectation: string): never {
  throw new Error(`Invalid saved settings: ${path} ${expectation}`);
}

function savedObject(value: unknown, path: string): Record<string, unknown> {
  const parsed = objectRecord(value);
  if (!parsed) invalidSavedSettings(path, 'must be an object');
  return parsed;
}

// Best-effort object coercion for merging legacy fields into a raw, not-yet-
// validated provider entry; a non-object entry is left to fail its own shape
// check inside `discoveryProviders()` with a proper error message.
function looseObject(value: unknown): Record<string, unknown> {
  return objectRecord(value) ?? {};
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) {
    invalidSavedSettings(path, `must contain exactly: ${expected.join(', ')}`);
  }
}

function requireStringFields(value: Record<string, unknown>, fields: readonly string[], path: string): void {
  if (fields.some(field => typeof value[field] !== 'string')) {
    invalidSavedSettings(path, 'must contain text values');
  }
}

function isSupportedSettingsVersion(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= currentSettingsVersion;
}

export function readSavedSettings(contents: string): Settings {
  const document = savedObject(JSON.parse(contents), 'root');
  requireExactKeys(document, ['version', 'settings'], 'root');

  const versionValue = document.version;
  if (!isSupportedSettingsVersion(versionValue)) {
    invalidSavedSettings('version', `must be a whole number from 1 to ${currentSettingsVersion}`);
  }
  const version = versionValue;

  const saved = savedObject(document.settings, 'settings');
  const expectedSections: string[] = settingsSections
    .filter(([, introduced, removedAt]) => version >= introduced && (removedAt === undefined || version < removedAt))
    .map(([section]) => section);
  if (version < 12) expectedSections.push('qbittorrent');
  requireExactKeys(saved, expectedSections, 'settings');

  let downloadBackend: Record<string, unknown>;
  if (version < 12) {
    const qbittorrent = savedObject(saved.qbittorrent, 'settings.qbittorrent');
    requireExactKeys(qbittorrent, ['url', 'username', 'password'], 'settings.qbittorrent');
    requireStringFields(qbittorrent, ['url', 'username', 'password'], 'settings.qbittorrent');
    downloadBackend = {
      id: String(qbittorrent.url) ? legacyBackendId(String(qbittorrent.url)) : 'default',
      type: 'qbittorrent', protocol: 'torrent', ...qbittorrent, pathMappings: [],
    };
  } else {
    downloadBackend = savedObject(saved.downloadBackend, 'settings.downloadBackend');
    requireExactKeys(downloadBackend, version >= 14
      ? ['id', 'type', 'protocol', 'url', 'username', 'password', 'pathMappings']
      : ['id', 'type', 'url', 'username', 'password', 'pathMappings'], 'settings.downloadBackend');
    requireStringFields(downloadBackend, ['id', 'type', 'url', 'username', 'password'], 'settings.downloadBackend');
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(downloadBackend.id))) invalidSavedSettings('settings.downloadBackend.id', 'is invalid');
    // Pre-14 files predate the protocol field; every type back then was torrent.
    if (version < 14) downloadBackend = { ...downloadBackend, protocol: 'torrent' };
    // Use patch validation for the path collection and backend type below.
  }

  const patch: Record<string, unknown> = {
    // Upgrades keep existing installations on the dashboard.
    setup: { completed: true },
    retention: { minFreeSpaceGB: 0 },
    downloadBackend: (() => {
      const { id: _id, ...editable } = downloadBackend;
      return { ...editable, password: downloadBackend.password || null };
    })(),
  };
  if (version >= 9) {
    const setup = savedObject(saved.setup, 'settings.setup');
    requireExactKeys(setup, ['completed'], 'settings.setup');
    patch.setup = setup;
  }
  if (version >= 8) {
    const limits = savedObject(saved.store, 'settings.store');
    requireExactKeys(limits, ['maxActiveDownloads'], 'settings.store');
    patch.store = limits;
  }
  if (version >= 7) {
    const integrations = savedObject(saved.integrations, 'settings.integrations');
    requireExactKeys(integrations, ['mode'], 'settings.integrations');
    patch.integrations = { mode: integrations.mode };
  }
  if (version >= 2) {
    const metadata = savedObject(saved.metadata, 'settings.metadata');
    requireExactKeys(metadata, ['provider', 'tmdbApiKey'], 'settings.metadata');
    requireStringFields(metadata, ['provider', 'tmdbApiKey'], 'settings.metadata');
    patch.metadata = { ...metadata, tmdbApiKey: metadata.tmdbApiKey || null };
  }
  if (version >= 11) {
    const playback = savedObject(saved.playback, 'settings.playback');
    requireExactKeys(playback, ['streamWhileDownloading'], 'settings.playback');
    patch.playback = playback;
  }
  if (version >= 3) {
    const retention = savedObject(saved.retention, 'settings.retention');
    const retentionFields = ['days', 'targetRatio', 'graceDays', 'extendOnPlay', 'maxCacheGB'];
    if (version >= 7) retentionFields.push('storeLeaseDays');
    if (version >= 10) retentionFields.push('minFreeSpaceGB');
    requireExactKeys(retention, retentionFields, 'settings.retention');
    patch.retention = { ...retention, ...(version < 10 ? { minFreeSpaceGB: 0 } : {}) };
  }

  if (version >= 15) {
    // Every provider already carries its own preferences; shape validation
    // happens through discoveryProviders() below, same as a normal patch.
    const discovery = savedObject(saved.discovery, 'settings.discovery');
    requireExactKeys(discovery, ['providers'], 'settings.discovery');
    if (!Array.isArray(discovery.providers)) invalidSavedSettings('settings.discovery.providers', 'must be an array');
    patch.discovery = discovery;
  } else {
    // Pre-15: `prowlarr` and the instance-wide `preferences` section both
    // existed separately. Fold them into per-provider preferences so reading
    // an old file preserves prior filtering behavior exactly: every existing
    // provider inherits the old global preferences; if the provider list was
    // empty but `prowlarr` had a URL, it becomes one provider entry carrying
    // that URL/key and the global preferences; if both were empty, providers
    // stays empty (nothing was configured before or after).
    const prowlarr = savedObject(saved.prowlarr, 'settings.prowlarr');
    requireExactKeys(prowlarr, ['url', 'apiKey'], 'settings.prowlarr');
    requireStringFields(prowlarr, ['url', 'apiKey'], 'settings.prowlarr');

    let legacyPreferences: Record<string, unknown>;
    if (version === 4) {
      // Migrate to the allow-set shape, preserving actual filtering behavior
      // rather than the raw values: a cap becomes the set of resolutions it
      // used to let through; a non-required language (never excluded
      // anything) becomes no filter, since there's no "soft preference"
      // concept in the new model to carry it into. No codec concept existed
      // yet, so no filter.
      const old = savedObject(saved.preferences, 'settings.preferences');
      requireExactKeys(old, ['language', 'requireLanguage', 'maxResolution'], 'settings.preferences');
      const { language, requireLanguage, maxResolution } = old;
      if (typeof language !== 'string' || typeof requireLanguage !== 'boolean' || typeof maxResolution !== 'number') {
        invalidSavedSettings('settings.preferences', 'contains invalid version 4 values');
      }
      legacyPreferences = {
        languages: requireLanguage && language ? [language] : [],
        resolutions: maxResolution > 0 ? knownResolutions.filter(r => r <= maxResolution) : [],
        codecs: [],
      };
    } else if (version === 5) {
      // Same allow-set shape; just adds the (unfiltered) codecs field.
      const old = savedObject(saved.preferences, 'settings.preferences');
      requireExactKeys(old, ['languages', 'resolutions'], 'settings.preferences');
      legacyPreferences = { ...old, codecs: [] };
    } else if (version >= 6) {
      const preferences = savedObject(saved.preferences, 'settings.preferences');
      requireExactKeys(preferences, ['languages', 'resolutions', 'codecs'], 'settings.preferences');
      legacyPreferences = preferences;
    } else {
      // Versions 1-3 predate the preferences section entirely.
      legacyPreferences = { languages: [], resolutions: [], codecs: [] };
    }

    let rawProviders: unknown[] = [];
    if (version >= 13) {
      const discovery = savedObject(saved.discovery, 'settings.discovery');
      requireExactKeys(discovery, ['providers'], 'settings.discovery');
      if (!Array.isArray(discovery.providers)) invalidSavedSettings('settings.discovery.providers', 'must be an array');
      rawProviders = discovery.providers;
    }

    const providers = rawProviders.length
      ? rawProviders.map(entry => ({ ...looseObject(entry), preferences: legacyPreferences }))
      : prowlarr.url
        ? [{ type: 'prowlarr', url: prowlarr.url, apiKey: prowlarr.apiKey, preferences: legacyPreferences }]
        : [];
    patch.discovery = { providers };
  }

  if (version >= 16) {
    const connections = savedObject(saved.connections, 'settings.connections');
    requireExactKeys(connections, ['webhookUrl', 'webhookSecret'], 'settings.connections');
    requireStringFields(connections, ['webhookUrl', 'webhookSecret'], 'settings.connections');
    patch.connections = { ...connections, webhookSecret: connections.webhookSecret || null };
  }

  if (version >= 17) {
    // Shape validation happens through savedSearches() below, same as discovery.
    const rss = savedObject(saved.rss, 'settings.rss');
    requireExactKeys(rss, ['searches'], 'settings.rss');
    if (!Array.isArray(rss.searches)) invalidSavedSettings('settings.rss.searches', 'must be an array');
    patch.rss = rss;
  }

  const result = applySettingsPatch(emptySettings(), patch);
  result.downloadBackend.id = String(downloadBackend.id);
  return result;
}
