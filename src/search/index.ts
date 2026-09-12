import { MOVIE_CATEGORIES, SERIES_CATEGORIES, type Release, type ReleaseSource } from '../discovery/source.js';
import type { DownloadProtocol } from '../backends/download.js';
import type { DiscoveryProviderPreferences } from '../discovery/config.js';
import type { MediaId, MetadataProvider } from '../metadata/index.js';
import { normalizeTitle, releaseMatches } from './match.js';
import { parseReleaseTitle, type ParsedRelease } from './parse.js';
import { releaseRequest } from './requests.js';
import { ConnectionError } from '../integrations/http.js';
import { rankCandidates, type Candidate } from './rank.js';
import { log } from '../log.js';

export type { Candidate } from './rank.js';
export { parseReleaseTitle } from './parse.js';
export { releaseMatches, normalizeTitle, titleTokens } from './match.js';
export { rankCandidates } from './rank.js';

const DEFAULT_LIMIT = 50;

const pad = (value: number) => String(value).padStart(2, '0');

// A discovery provider paired with its own content preferences, so a source's
// results are filtered and ranked against what *it* was configured to
// prefer, not one instance-wide setting.
export interface DiscoverySource {
  source: ReleaseSource;
  preferences: DiscoveryProviderPreferences;
}

// One query for the primary title plus, if there is one, its original/alternate
// title (just the first — TMDB is the only provider that gives one) — useful
// for foreign-language and internationally retitled releases.
export function buildQueries(id: MediaId, title: string, year?: number, alternateTitle?: string): string[] {
  const titles = alternateTitle ? [title, alternateTitle] : [title];
  if (id.type === 'movie') return titles.map(t => (year ? `${t} ${year}` : t));
  const tag = `S${pad(id.season ?? 0)}`;
  return titles.flatMap(t => [`${t} ${tag}E${pad(id.episode ?? 0)}`, `${t} ${tag}`]);
}

// Allow-set filtering: an empty set means no filter. A release is dropped
// only if its resolution/codec/language is known and isn't in the allowed
// set — an untagged release (no resolution or codec read, or no language tag
// at all) is never excluded on that basis alone, since we can't tell. A
// 'multi'/'dual' language tag always passes a language filter (it likely
// includes something wanted; we just don't know what).
export function passesPreferences(parsed: ParsedRelease, preferences: DiscoveryProviderPreferences): boolean {
  if (preferences.resolutions.length > 0 && parsed.resolution !== undefined &&
      !preferences.resolutions.includes(parsed.resolution)) {
    return false;
  }
  if (preferences.codecs.length > 0 && parsed.codec !== undefined && !preferences.codecs.includes(parsed.codec)) {
    return false;
  }
  if (preferences.languages.length > 0 && parsed.languages.length > 0 &&
      !parsed.languages.includes('multi') && !parsed.languages.some(l => preferences.languages.includes(l))) {
    return false;
  }
  return true;
}

function dedupeKey(release: Release): string {
  return release.infoHash ?? `${normalizeTitle(release.title)}|${release.size}`;
}

export interface FindReleasesOptions {
  id: MediaId;
  metadata: MetadataProvider;
  sources: DiscoverySource[];
  signal: AbortSignal;
  limit?: number;
  // Releases whose protocol is not listed are unusable. Defaults to torrent
  // so a torrent-only backend never surfaces NZB results.
  protocols?: readonly DownloadProtocol[];
}

// Resolves the title, runs every configured source's queries concurrently,
// then dedupes across all of them, filters to releases that actually match and
// fit each source's own language/quality preferences, and ranks them.
// Individual source or query failures are tolerated; the caller decides what
// an empty result means.
export async function findReleases(options: FindReleasesOptions): Promise<Candidate[]> {
  const { id, metadata, sources, signal, limit = DEFAULT_LIMIT, protocols = ['torrent'] } = options;
  const active = sources.filter(({ source }) => source.configured);
  if (!active.length) return [];

  const started = Date.now();
  const wanted = await metadata.resolve(id, signal);
  const categories = id.type === 'movie' ? MOVIE_CATEGORIES : SERIES_CATEGORIES;
  const queries = buildQueries(id, wanted.title, wanted.year, wanted.alternateTitles[0]);
  const jobs = active.flatMap((source, sourceIndex) =>
    queries.map((query, queryIndex) => ({ source, sourceIndex, queryIndex, query })));

  const batches = await Promise.allSettled(
    jobs.map(job => job.source.source.search(job.query, signal, categories)),
  );

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  let received = 0;
  let mismatches = 0;
  let filtered = 0;
  let duplicates = 0;
  let failed = 0;
  let unusable = 0;
  for (const [index, batch] of batches.entries()) {
    const job = jobs[index]!;
    if (batch.status !== 'fulfilled') {
      failed++;
      const reason = signal.aborted ? 'timeout' : batch.reason instanceof ConnectionError ? batch.reason.code : 'unavailable';
      log.warn(`Debridarr discovery search ${id.type}/${id.imdbId} source=${job.sourceIndex + 1} query=${job.queryIndex + 1} failed: ${reason}`);
      continue;
    }
    const preferences = job.source.preferences;
    for (const release of batch.value) {
      const key = dedupeKey(release);
      received++;
      if (!protocols.includes(release.protocol) || !releaseRequest(release, id)) { unusable++; continue; }
      const parsed = parseReleaseTitle(release.title);
      if (!releaseMatches({ releaseTitle: release.title, parsed, wanted })) { mismatches++; continue; }
      if (!passesPreferences(parsed, preferences)) { filtered++; continue; }
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      candidates.push({ release, parsed, preferences: { languages: preferences.languages } });
    }
  }

  log.info(`Debridarr search ${id.type}/${id.imdbId}: sources=${active.length} queries=${jobs.length} failed=${failed} received=${received} title_year_episode_rejected=${mismatches} preference_rejected=${filtered} unusable=${unusable} duplicates=${duplicates} matched=${candidates.length} elapsed=${Date.now() - started}ms`);

  const ranked = rankCandidates(candidates);
  const top = ranked.slice(0, limit);
  // The result cap must not hide the season pack entirely: if single episodes
  // filled every slot, surface the best-ranked pack (preferring the wanted
  // season) in the last one so "grab the whole season" stays available.
  if (top.length === limit && !top.some(c => c.parsed.seasonPack)) {
    const pack = ranked.find(c => c.parsed.seasonPack && c.parsed.season === id.season)
      ?? ranked.find(c => c.parsed.seasonPack);
    if (pack) {
      top[limit - 1] = pack;
      log.info(`Debridarr search ${id.type}/${id.imdbId}: kept a season pack past the ${limit}-result cap`);
    }
  }
  return top;
}
