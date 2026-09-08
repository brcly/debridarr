import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson } from './storage.js';

export class SettingsValidationError extends Error {}
export class SettingsStorageError extends Error {}
export const metadataProviders = ['cinemeta', 'tmdb'] as const;
export type MetadataProviderName = typeof metadataProviders[number];
export interface Settings {
  prowlarr: { url: string; apiKey: string };
  qbittorrent: { url: string; username: string; password: string };
  metadata: { provider: MetadataProviderName; tmdbApiKey: string };
  retention: { days: number; targetRatio: number; graceDays: number; extendOnPlay: boolean; maxCacheGB: number };
  // Allow-sets, not caps/single values: empty means no filter. Checking a box
  // is itself the requirement — there's no separate "require" toggle.
  preferences: { languages: string[]; resolutions: (480 | 720 | 1080 | 2160)[]; codecs: ('x265' | 'x264' | 'av1' | 'xvid')[] };
}
export const emptySettings = (): Settings => ({
  prowlarr: { url: '', apiKey: '' },
  qbittorrent: { url: '', username: '', password: '' },
  metadata: { provider: 'cinemeta', tmdbApiKey: '' },
  retention: { days: 30, targetRatio: 1, graceDays: 0, extendOnPlay: true, maxCacheGB: 0 },
  preferences: { languages: [], resolutions: [], codecs: [] },
});

// Numeric retention fields, their valid range, and whether they must be whole numbers.
const retentionRules = {
  days: { min: 1, max: 3650, integer: true },
  targetRatio: { min: 0.1, max: 100, integer: false },
  graceDays: { min: 0, max: 3650, integer: true },
  maxCacheGB: { min: 0, max: 1_000_000, integer: false },
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

const knownResolutions = [480, 720, 1080, 2160] as const;
const knownCodecs = ['x265', 'x264', 'av1', 'xvid'] as const;
const languageCodePattern = /^[a-z]{2}$/;

// Preferences fields are arrays (allow-sets), not scalars, so they get their
// own patch logic. A provided array replaces the field wholesale; there is
// nothing to merge/append. Deduped, so repeated saves stay tidy.
function applyPreferencesPatch(current: Settings['preferences'], fields: Record<string, unknown>): Settings['preferences'] {
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
      next.resolutions = [...new Set(value as number[])] as Settings['preferences']['resolutions'];
    } else if (key === 'codecs') {
      if (!value.every(v => knownCodecs.includes(v as typeof knownCodecs[number]))) {
        throw new SettingsValidationError(`preferences.codecs must each be one of: ${knownCodecs.join(', ')}`);
      }
      next.codecs = [...new Set(value as string[])] as Settings['preferences']['codecs'];
    }
  }
  return next;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SettingsValidationError('Settings must be a JSON object');
  }
  return value as Record<string, unknown>;
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

// Omitted fields are kept; null explicitly clears secrets. Blank secrets are not masks.
export function applySettingsPatch(current: Settings, input: unknown): Settings {
  const patch = record(input);
  const result = structuredClone(current);
  for (const [section, rawFields] of Object.entries(patch)) {
    if (section !== 'prowlarr' && section !== 'qbittorrent' && section !== 'metadata' && section !== 'retention' && section !== 'preferences') {
      throw new SettingsValidationError('Unknown settings section');
    }
    const fields = record(rawFields);
    if (section === 'retention') {
      result.retention = applyRetentionPatch(result.retention, fields);
      continue;
    }
    if (section === 'preferences') {
      result.preferences = applyPreferencesPatch(result.preferences, fields);
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
  return applySettingsPatch(emptySettings(), {
    prowlarr: { url: env.PROWLARR_URL ?? '', apiKey: env.PROWLARR_API_KEY?.trim() ? env.PROWLARR_API_KEY : null },
    qbittorrent: {
      url: env.QBITTORRENT_URL ?? '', username: env.QBITTORRENT_USERNAME ?? '',
      password: env.QBITTORRENT_PASSWORD?.trim() ? env.QBITTORRENT_PASSWORD : null,
    },
    metadata,
  });
}

export function publicSettings(settings: Settings) {
  return {
    prowlarr: { url: settings.prowlarr.url, hasApiKey: !!settings.prowlarr.apiKey },
    qbittorrent: { url: settings.qbittorrent.url, username: settings.qbittorrent.username, hasPassword: !!settings.qbittorrent.password },
    metadata: { provider: settings.metadata.provider, hasTmdbApiKey: !!settings.metadata.tmdbApiKey },
    retention: { ...settings.retention },
    preferences: { ...settings.preferences },
  };
}

export async function writeSettings(path: string, settings: Settings): Promise<void> {
  await atomicWriteJson(path, { version: 6, settings });
}

// Reads version 1 (prowlarr + qbittorrent), version 2 (adds metadata),
// version 3 (adds retention), version 4 (adds preferences as a single
// language + cap), version 5 (preferences become allow-sets: languages,
// resolutions), and version 6 (adds codecs to the allow-sets). A file older
// than the current version is migrated in memory by falling back to the
// relevant section's defaults; it is rewritten at the current version on the
// next save.
function readSavedSettings(contents: string): Settings {
  const document = record(JSON.parse(contents));
  if ((document.version !== 1 && document.version !== 2 && document.version !== 3 && document.version !== 4 &&
       document.version !== 5 && document.version !== 6) ||
      Object.keys(document).sort().join() !== 'settings,version') throw new Error();
  const withMetadata = document.version >= 2;
  const withRetention = document.version >= 3;
  const withPreferencesV4 = document.version === 4;
  const withPreferencesV5 = document.version === 5;
  const withPreferencesV6 = document.version === 6;
  const withPreferences = withPreferencesV4 || withPreferencesV5 || withPreferencesV6;
  const saved = record(document.settings);
  const expectedKeys = [
    'prowlarr', 'qbittorrent', ...(withMetadata ? ['metadata'] : []),
    ...(withRetention ? ['retention'] : []), ...(withPreferences ? ['preferences'] : []),
  ];
  if (Object.keys(saved).sort().join() !== expectedKeys.sort().join()) throw new Error();
  const prowlarr = record(saved.prowlarr);
  const qbittorrent = record(saved.qbittorrent);
  if (Object.keys(prowlarr).sort().join() !== 'apiKey,url' ||
      Object.keys(qbittorrent).sort().join() !== 'password,url,username' ||
      [...Object.values(prowlarr), ...Object.values(qbittorrent)].some(v => typeof v !== 'string')) throw new Error();
  const patch: Record<string, unknown> = {
    prowlarr: { ...prowlarr, apiKey: prowlarr.apiKey || null },
    qbittorrent: { ...qbittorrent, password: qbittorrent.password || null },
  };
  if (withMetadata) {
    const metadata = record(saved.metadata);
    if (Object.keys(metadata).sort().join() !== 'provider,tmdbApiKey' ||
        Object.values(metadata).some(v => typeof v !== 'string')) throw new Error();
    patch.metadata = { ...metadata, tmdbApiKey: metadata.tmdbApiKey || null };
  }
  if (withRetention) {
    const retention = record(saved.retention);
    if (Object.keys(retention).sort().join() !== 'days,extendOnPlay,graceDays,maxCacheGB,targetRatio') throw new Error();
    patch.retention = retention;
  }
  if (withPreferencesV4) {
    // Migrate to the allow-set shape, preserving actual filtering behavior
    // rather than the raw values: a cap becomes the set of resolutions it
    // used to let through; a non-required language (never excluded anything)
    // becomes no filter, since there's no "soft preference" concept in the
    // new model to carry it into. No codec concept existed yet, so no filter.
    const old = record(saved.preferences);
    if (Object.keys(old).sort().join() !== 'language,maxResolution,requireLanguage') throw new Error();
    const { language, requireLanguage, maxResolution } = old;
    if (typeof language !== 'string' || typeof requireLanguage !== 'boolean' || typeof maxResolution !== 'number') throw new Error();
    patch.preferences = {
      languages: requireLanguage && language ? [language] : [],
      resolutions: maxResolution > 0 ? knownResolutions.filter(r => r <= maxResolution) : [],
      codecs: [],
    };
  } else if (withPreferencesV5) {
    // Same allow-set shape; just adds the (unfiltered) codecs field.
    const old = record(saved.preferences);
    if (Object.keys(old).sort().join() !== 'languages,resolutions') throw new Error();
    patch.preferences = { ...old, codecs: [] };
  } else if (withPreferencesV6) {
    const preferences = record(saved.preferences);
    if (Object.keys(preferences).sort().join() !== 'codecs,languages,resolutions') throw new Error();
    patch.preferences = preferences;
  }
  return applySettingsPatch(emptySettings(), patch);
}

export class SettingsStore {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private readonly path: string, private settings: Settings, private readonly writer: typeof writeSettings) {}

  static async open(dataDir: string, env: NodeJS.ProcessEnv, writer = writeSettings): Promise<SettingsStore> {
    const path = join(dataDir, 'settings.json');
    let contents: string | undefined;
    try {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      try { contents = await readFile(path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } catch { throw new SettingsStorageError('Cannot read settings storage. Check DATA_DIR and its permissions.'); }
    let settings: Settings;
    if (contents !== undefined) {
      try { settings = readSavedSettings(contents); }
      catch { throw new SettingsStorageError('Saved settings are invalid or unsupported. Restore settings.json from a backup; it has not been reset.'); }
      try { await chmod(path, 0o600); }
      catch { throw new SettingsStorageError('Cannot protect saved settings. Check DATA_DIR ownership.'); }
    } else {
      settings = seedSettings(env);
      try { await writer(path, settings); }
      catch { throw new SettingsStorageError('Cannot initialize settings storage. Check DATA_DIR and its permissions.'); }
    }
    return new SettingsStore(path, settings, writer);
  }

  snapshot(): Settings { return structuredClone(this.settings); }

  update(input: unknown): Promise<Settings> {
    const patch = structuredClone(input);
    const operation = this.queue.then(async () => {
      const next = applySettingsPatch(this.settings, patch);
      try { await this.writer(this.path, next); }
      catch { throw new SettingsStorageError('Settings could not be saved. Previous settings remain active.'); }
      this.settings = next;
      return this.snapshot();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
