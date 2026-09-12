import { checkConnection, ConnectionError, serviceFetch, smallText, validVersion } from '../http.js';
import { attrValue, isRssDocument, parseRssItems, RSS_RESPONSE_BYTES } from '../../discovery/rss.js';
import type { Release, ReleaseSource } from '../../discovery/source.js';
import { CONNECTION_TEST_TIMEOUT_MS } from '../../timeouts.js';

const SEARCH_LIMIT = 100;

export class TorznabClient implements ReleaseSource {
  private readonly settings: { url: string; apiKey: string };
  constructor(settings: { url: string; apiKey: string }) {
    this.settings = settings;
  }

  get configured(): boolean {
    return Boolean(this.settings.url);
  }

  // Direct Torznab endpoints have no shared identity like Prowlarr's
  // per-indexer name, so the configured host stands in for it.
  private get indexerLabel(): string {
    try { return new URL(this.settings.url).hostname; } catch { return 'torznab'; }
  }

  private params(extra: Record<string, string>): URLSearchParams {
    const params = new URLSearchParams(extra);
    if (this.settings.apiKey) params.set('apikey', this.settings.apiKey);
    return params;
  }

  async version(signal: AbortSignal): Promise<string> {
    if (!this.configured) throw new ConnectionError('not_configured');
    const response = await serviceFetch(`${this.settings.url}?${this.params({ t: 'caps' })}`, signal, {
      headers: { Accept: 'application/xml' },
    });
    const version = attrValue(await smallText(response), 'server', 'version');
    if (!version || !validVersion(version)) throw new ConnectionError('unexpected_response');
    return version;
  }

  test(timeoutMs = CONNECTION_TEST_TIMEOUT_MS) { return checkConnection(signal => this.version(signal), timeoutMs); }

  // Torznab has no aggregator to pre-filter by protocol, so this endpoint is
  // treated as a torrent indexer end to end, matching what the registered
  // download backends can actually consume.
  async search(query: string, signal: AbortSignal, categories: readonly number[] = []): Promise<Release[]> {
    if (!this.configured) throw new ConnectionError('not_configured');
    const params = this.params({ t: 'search', q: query, extended: '1' });
    if (categories.length) params.set('cat', categories.join(','));
    const response = await serviceFetch(`${this.settings.url}?${params}`, signal, { headers: { Accept: 'application/xml' } });
    const body = await smallText(response, RSS_RESPONSE_BYTES);
    if (!isRssDocument(body)) throw new ConnectionError('unexpected_response');
    return parseRssItems(body, this.indexerLabel, 'torrent', SEARCH_LIMIT);
  }
}
