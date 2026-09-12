import { serviceFetch, smallText } from '../integrations/http.js';
import { isRssDocument, parseRssItems, RSS_RESPONSE_BYTES } from '../discovery/rss.js';
import { releaseSource } from '../search/requests.js';
import { TransferError } from '../application/transfers.js';
import { transferServiceFor } from '../application/factory.js';
import { DownloadError } from '../downloads/manager.js';
import { ConflictError } from '../downloads/coordinator.js';
import { BusyError } from '../security/admission.js';
import { createDownloadBackend } from '../backends/factory.js';
import type { DownloadBackend } from '../backends/download.js';
import type { DownloadsRepository, SettingsRepository } from '../state/repositories.js';
import type { Settings } from '../settings.js';
import type { SavedSearchSettings } from './config.js';
import { isItemSeen, pruneSearches, recordItem, recordPoll } from './state.js';
import { FEED_TIMEOUT_MS } from '../timeouts.js';

const ITEM_LIMIT = 50;

function titleMatches(title: string, search: SavedSearchSettings): boolean {
  const lower = title.toLowerCase();
  if (search.titleInclude && !lower.includes(search.titleInclude.toLowerCase())) return false;
  if (search.titleExclude && lower.includes(search.titleExclude.toLowerCase())) return false;
  return true;
}

function indexerLabel(feedUrl: string): string {
  try { return new URL(feedUrl).hostname; } catch { return 'rss'; }
}

// Fetches one search's feed and adds every new, filtered item through
// TransferService.add — the same entry point a manual or API add uses, so
// admission caps, free-space checks, and idempotent-by-identity dedup all
// apply unchanged. Exported separately from pollSavedSearches so the admin
// dashboard's "poll now" can run a single search on demand.
export async function pollSavedSearch(search: SavedSearchSettings, settings: Settings, backend: DownloadBackend, downloads: DownloadsRepository): Promise<void> {
  let body: string;
  try {
    const response = await serviceFetch(search.feedUrl, AbortSignal.timeout(FEED_TIMEOUT_MS), {
      headers: { Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
    });
    body = await smallText(response, RSS_RESPONSE_BYTES);
    if (!isRssDocument(body)) throw new Error('The feed did not return an RSS document.');
  } catch (error) {
    recordPoll(search.id, error instanceof Error ? error.message : 'Could not reach the feed.');
    return;
  }
  const items = parseRssItems(body, indexerLabel(search.feedUrl), search.protocol, ITEM_LIMIT);
  // The feed's own origin is trusted for its own items' links, the same way a
  // discovery provider's origin is trusted for its own search results.
  const service = transferServiceFor({
    settings, downloads, backend, resolveSources: true,
    extraProxyTargets: [{ url: search.feedUrl, apiKey: '', type: 'torznab' }],
  });
  for (const release of items) {
    if (!titleMatches(release.title, search) || isItemSeen(search.id, release.guid)) continue;
    const source = releaseSource(release);
    if (!source) {
      recordItem(search.id, { guid: release.guid, title: release.title, status: 'error', error: 'No usable magnet, torrent, or NZB link in this item.' });
      continue;
    }
    try {
      await service.add({ source, name: release.title, queue: search.queue, cachedOnly: search.cachedOnly });
      recordItem(search.id, { guid: release.guid, title: release.title, status: 'added' });
    } catch (error) {
      const message = error instanceof TransferError || error instanceof DownloadError || error instanceof ConflictError || error instanceof BusyError
        ? error.message : 'Could not add this item.';
      recordItem(search.id, { guid: release.guid, title: release.title, status: 'error', error: message });
    }
  }
  recordPoll(search.id);
}

export interface RssPollDeps {
  store: SettingsRepository;
  downloads: DownloadsRepository;
  backendFactory?: (settings: Settings['downloadBackend']) => DownloadBackend;
}

// One recurring job, not one per search: it iterates every enabled saved
// search on each tick. Saved searches add to the store front door, so they
// are as meaningless in Search-only mode as the "Cache a torrent" card and
// API tokens, and are skipped the same way rather than erroring.
export async function pollSavedSearches(deps: RssPollDeps): Promise<void> {
  const settings = deps.store.snapshot();
  pruneSearches(settings.rss.searches.map(search => search.id));
  if (settings.integrations.mode === 'search') return;
  const backend = (deps.backendFactory ?? createDownloadBackend)(settings.downloadBackend);
  for (const search of settings.rss.searches) {
    if (!search.enabled) continue;
    await pollSavedSearch(search, settings, backend, deps.downloads);
  }
}
