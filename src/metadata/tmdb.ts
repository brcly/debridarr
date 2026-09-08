import type { MediaId } from './id.js';
import { fetchJson } from './http.js';
import { MetadataError, parseYear, resolvedTitle, type MetadataProvider, type ResolvedTitle } from './types.js';

const DEFAULT_BASE = 'https://api.themoviedb.org/3';

interface TmdbEntry {
  title?: unknown;
  name?: unknown;
  original_title?: unknown;
  original_name?: unknown;
  release_date?: unknown;
  first_air_date?: unknown;
}

// Resolves via TMDB's /find endpoint, which is keyed by external (IMDb) id, so no
// separate id mapping is needed. Uses a v3 API key passed as a query parameter.
export class TmdbProvider implements MetadataProvider {
  readonly name = 'tmdb';
  constructor(private readonly apiKey: string, private readonly base: string = DEFAULT_BASE) {}

  async resolve(id: MediaId, signal: AbortSignal): Promise<ResolvedTitle> {
    if (!this.apiKey) throw new MetadataError('not_configured');
    const url = `${this.base}/find/${encodeURIComponent(id.imdbId)}` +
      `?external_source=imdb_id&api_key=${encodeURIComponent(this.apiKey)}`;
    const body = await fetchJson(url, signal) as Record<string, unknown>;
    const list = id.type === 'movie' ? body.movie_results : body.tv_results;
    const entry = Array.isArray(list) ? (list[0] as TmdbEntry | undefined) : undefined;
    const rawTitle = entry && (typeof entry.title === 'string' ? entry.title : typeof entry.name === 'string' ? entry.name : '');
    const title = rawTitle ? rawTitle.trim() : '';
    if (!title) throw new MetadataError('not_found');
    // The original-language title, when TMDB returns one distinct from the
    // localized title — useful for foreign-language films, anime, and
    // internationally retitled releases whose scene names use it instead.
    const rawOriginal = entry && (typeof entry.original_title === 'string' ? entry.original_title : typeof entry.original_name === 'string' ? entry.original_name : '');
    const original = rawOriginal ? rawOriginal.trim() : '';
    const alternateTitles = original && original.toLowerCase() !== title.toLowerCase() ? [original] : [];
    return resolvedTitle(id, title, parseYear(entry?.release_date ?? entry?.first_air_date), alternateTitles);
  }
}
