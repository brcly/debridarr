import { checkConnection, ConnectionError, serviceFetch, smallText, validVersion } from '../http.js';
import { CONNECTION_TEST_TIMEOUT_MS } from '../../timeouts.js';
import { objectRecord } from '../../json.js';
import { MOVIE_CATEGORIES, SERIES_CATEGORIES, type Release, type ReleaseSource } from '../../discovery/source.js';

export { MOVIE_CATEGORIES, SERIES_CATEGORIES };
export type ProwlarrRelease = Release;

const SEARCH_LIMIT = 100;
const SEARCH_RESPONSE_BYTES = 4 * 1024 * 1024;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function normalizeRelease(raw: unknown): ProwlarrRelease | undefined {
  const r = objectRecord(raw);
  if (!r) return undefined;
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

export class ProwlarrClient implements ReleaseSource {
  private readonly settings: { url: string; apiKey: string };
  constructor(settings: { url: string; apiKey: string }) {
    this.settings = settings;
  }

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

  test(timeoutMs = CONNECTION_TEST_TIMEOUT_MS) { return checkConnection(signal => this.version(signal), timeoutMs); }

  // Full-text release search across the user's indexers. Prowlarr aggregates
  // per-indexer results and failures server-side; a non-2xx here means Prowlarr
  // itself failed. Protocol filtering (torrent vs usenet) happens in search,
  // so a Usenet backend can see NZB results from the same indexer list.
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
      if (release) releases.push(release);
    }
    return releases;
  }
}
