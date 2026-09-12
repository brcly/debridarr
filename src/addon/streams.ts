import { configuredDiscoverySources } from '../discovery/registry.js';
import { createMetadataProvider, MetadataError, parseMediaId, type MediaId } from '../metadata/index.js';
import { findReleases, type Candidate } from '../search/index.js';
import type { Settings } from '../settings.js';
import { sourceInfoHash, type PrepareTransferRequest } from '../application/types.js';
import { releaseRequest } from './requests.js';
import { cachedCopies, type CacheContext, type CachedCopy } from './cached.js';
import { parseReleaseTitle } from '../search/parse.js';
import { magnetInfoHash } from '../downloads/magnet.js';
import { streamLabel } from './presentation.js';
import { log } from '../log.js';
import { CACHED_COPIES_TIMEOUT_MS, SEARCH_DEADLINE_MS } from '../timeouts.js';

export { sizeLabel } from './presentation.js';

export { parseMediaId };
export type { MediaId, MediaType } from '../metadata/index.js';

export interface StreamContext {
  settings: Pick<Settings, 'discovery' | 'metadata' | 'downloadBackend'>;
  appUrl: string;
  issue: (requests: PrepareTransferRequest[]) => Promise<string[]>;
  cache?: CacheContext;
}

export interface StremioStream {
  name: string;
  title: string;
  description: string;
  url: string;
  behaviorHints: { notWebReady: boolean; bingeGroup: string };
}

// Ranked releases become server-side references; browsing never starts downloads.
export async function buildStreams(candidates: Candidate[], id: MediaId, appUrl: string, issue: StreamContext['issue']): Promise<StremioStream[]> {
  return (await buildStreamList([], candidates, id, { appUrl, issue })).streams;
}

// Resolve the title, search the configured discovery sources, and present ranked
// releases as selectable Stremio streams. Browsing must never trigger a download;
// selecting a stream hits the protected playback route. Never throws: a failure
// surfaces to Stremio as "no results".
export async function getStreams(id: MediaId, context: StreamContext): Promise<{ streams: StremioStream[] }> {
  const sources = configuredDiscoverySources(context.settings);
  const started = Date.now();
  // Stremio drops stream requests that take too long; stay well under that.
  // Stremio clients often abandon stream requests around 8–12 s.
  const signal = AbortSignal.timeout(SEARCH_DEADLINE_MS);
  const local = context.cache ? cachedCopies(id, context.cache, AbortSignal.timeout(CACHED_COPIES_TIMEOUT_MS)) : Promise.resolve([]);
  const search = async (): Promise<Candidate[]> => {
    if (!sources.some(({ source }) => source.configured)) return [];
    try {
      const metadata = createMetadataProvider(context.settings.metadata);
      return await findReleases({ id, metadata, sources, signal, protocols: [context.settings.downloadBackend.protocol] });
    } catch (error) {
      log.warn(`Debridarr search ${id.type}/${id.imdbId} failed: ${signal.aborted ? 'timeout' : error instanceof MetadataError ? `metadata_${error.code}` : 'upstream'} after ${Date.now() - started}ms.`);
      return [];
    }
  };
  try {
    const [copies, candidates] = await Promise.all([local, search()]);
    const result = await buildStreamList(copies, candidates, id, context);
    log.info(`Debridarr streams ${id.type}/${id.imdbId}: cached=${copies.length} candidates=${candidates.length} streams=${result.streams.length} elapsed=${Date.now() - started}ms${signal.aborted ? ' deadline_reached' : ''}`);
    return result;
  } catch {
    log.warn(`Debridarr streams ${id.type}/${id.imdbId}: reference_storage_failed after ${Date.now() - started}ms.`);
    return { streams: [] };
  }
}

export async function buildStreamList(copies: CachedCopy[], candidates: Candidate[], id: MediaId, context: Pick<StreamContext, 'appUrl' | 'issue'>): Promise<{ streams: StremioStream[] }> {
  const entries = copies.map(({ request, progress }) => {
    const parsed = parseReleaseTitle(request.name);
    // A cached pack is pinned to one file, so show the exact episode.
    const scoped = id.type === 'series' && id.season !== undefined && id.episode !== undefined
      ? { ...parsed, season: id.season, episode: id.episode, seasonPack: false } : parsed;
    return { request, parsed, label: streamLabel(request.name, scoped, request.bytes, { cache: { progress } }) };
  });
  const hashes = new Set(copies.map(copy => sourceInfoHash(copy.request.source)));
  for (const { release, parsed } of candidates) {
    const hash = release.infoHash?.toLowerCase() ?? (release.magnetUrl ? magnetInfoHash(release.magnetUrl) : undefined);
    if (hash && hashes.has(hash)) continue;
    const request = releaseRequest(release, id);
    if (request) entries.push({ request, parsed, label: streamLabel(release.title, parsed, release.size, { seeders: release.seeders, indexer: release.indexer }) });
  }
  // Persist cached and fresh references together: one atomic write per result list.
  const tokens = entries.length ? await context.issue(entries.map(entry => entry.request)) : [];
  return { streams: entries.map(({ label, parsed }, i) => ({
    ...label, url: `${context.appUrl}/play/${tokens[i]}`,
    behaviorHints: { notWebReady: true, bingeGroup: `debridarr-${parsed.resolution ?? 'sd'}` },
  })) };
}
