import type { Settings } from '../../settings.js';
import { checkConnection, ConnectionError, serviceFetch, smallText, validVersion } from '../http.js';

// Newznab category ids Prowlarr understands. 2000 = Movies, 5000 = TV.
export const MOVIE_CATEGORIES = [2000];
export const SERIES_CATEGORIES = [5000];

export interface ProwlarrRelease {
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

const SEARCH_LIMIT = 100;
const SEARCH_RESPONSE_BYTES = 4 * 1024 * 1024;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function normalizeRelease(raw: unknown): ProwlarrRelease | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const title = text(r.title);
  const guid = text(r.guid) ?? text(r.infoUrl) ?? text(r.downloadUrl) ?? text(r.magnetUrl);
  if (!title || !guid) return undefined;
  const infoHash = text(r.infoHash)?.toLowerCase();
  return {
    title: title.trim(),
    size: count(r.size),
    seeders: count(r.seeders),
    leechers: count(r.leechers ?? r.peers),
    indexer: text(r.indexer)?.trim() ?? 'unknown',
    protocol: r.protocol === 'usenet' ? 'usenet' : 'torrent',
    guid,
    ...(infoHash && /^[a-f0-9]{40}$/.test(infoHash) ? { infoHash } : {}),
    ...(text(r.magnetUrl) ? { magnetUrl: r.magnetUrl as string } : {}),
    ...(text(r.downloadUrl) ? { downloadUrl: r.downloadUrl as string } : {}),
    ...(text(r.publishDate) ? { publishDate: r.publishDate as string } : {}),
  };
}

export class ProwlarrClient {
  constructor(private readonly settings: Settings['prowlarr']) {}

  get configured(): boolean {
    return Boolean(this.settings.url && this.settings.apiKey);
  }

  async version(signal: AbortSignal): Promise<string> {
    if (!this.configured) throw new ConnectionError('not_configured');
    const response = await serviceFetch(`${this.settings.url}/api/v1/system/status`, signal, {
      headers: { 'X-Api-Key': this.settings.apiKey, Accept: 'application/json' },
    });
    let result: unknown;
    try { result = JSON.parse(await smallText(response)); } catch { throw new ConnectionError('unexpected_response'); }
    if (!result || typeof result !== 'object' || !('version' in result) || !validVersion(result.version)) {
      throw new ConnectionError('unexpected_response');
    }
    return result.version;
  }

  test(timeoutMs = 10_000) { return checkConnection(signal => this.version(signal), timeoutMs); }

  // Full-text release search across the user's indexers. Prowlarr aggregates
  // per-indexer results and failures server-side; a non-2xx here means Prowlarr
  // itself failed. Only torrent results are returned (qBittorrent cannot fetch
  // usenet).
  async search(query: string, signal: AbortSignal, categories: readonly number[] = []): Promise<ProwlarrRelease[]> {
    if (!this.configured) throw new ConnectionError('not_configured');
    const params = new URLSearchParams({ query, type: 'search', limit: String(SEARCH_LIMIT) });
    for (const category of categories) params.append('categories', String(category));
    const response = await serviceFetch(`${this.settings.url}/api/v1/search?${params}`, signal, {
      headers: { 'X-Api-Key': this.settings.apiKey, Accept: 'application/json' },
    });
    let result: unknown;
    try { result = JSON.parse(await smallText(response, SEARCH_RESPONSE_BYTES)); }
    catch { throw new ConnectionError('unexpected_response'); }
    if (!Array.isArray(result)) throw new ConnectionError('unexpected_response');
    const releases: ProwlarrRelease[] = [];
    for (const raw of result) {
      const release = normalizeRelease(raw);
      if (release && release.protocol === 'torrent') releases.push(release);
    }
    return releases;
  }
}
