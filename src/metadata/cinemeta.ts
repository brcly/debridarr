import type { MediaId } from './id.js';
import { fetchJson } from './http.js';
import { objectRecord } from '../json.js';
import { MetadataError, parseYear, resolvedTitle, type MetadataProvider, type ResolvedTitle } from './types.js';

// Stremio's own IMDb-keyed catalogue. No credentials; same titles Stremio shows.
const DEFAULT_BASE = 'https://v3-cinemeta.strem.io';

export class CinemetaProvider implements MetadataProvider {
  readonly name = 'cinemeta';
  private readonly base: string;
  constructor(base: string = DEFAULT_BASE) {
    this.base = base;
  }

  async resolve(id: MediaId, signal: AbortSignal): Promise<ResolvedTitle> {
    const body = objectRecord(await fetchJson(`${this.base}/meta/${id.type}/${encodeURIComponent(id.imdbId)}.json`, signal));
    const record = objectRecord(body?.meta);
    if (!record) throw new MetadataError('not_found');
    const title = typeof record.name === 'string' ? record.name.trim() : '';
    if (!title) throw new MetadataError('not_found');
    return resolvedTitle(id, title, parseYear(record.year ?? record.releaseInfo));
  }
}
