import type { Settings } from '../settings.js';
import { CinemetaProvider } from './cinemeta.js';
import { TmdbProvider } from './tmdb.js';
import type { MetadataProvider } from './types.js';

export { MetadataError } from './types.js';
export type { MetadataErrorCode, MetadataProvider, ResolvedTitle } from './types.js';
export { parseMediaId } from './id.js';
export type { MediaId, MediaType } from './id.js';

export function createMetadataProvider(settings: Settings['metadata']): MetadataProvider {
  return settings.provider === 'tmdb'
    ? new TmdbProvider(settings.tmdbApiKey)
    : new CinemetaProvider();
}
