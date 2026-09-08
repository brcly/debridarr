import {
  MOVIE_CATEGORIES, SERIES_CATEGORIES, type ProwlarrClient, type ProwlarrRelease,
} from '../integrations/prowlarr/client.js';
import type { MediaId, MetadataProvider } from '../metadata/index.js';
import type { Settings } from '../settings.js';
import { normalizeTitle, releaseMatches } from './match.js';
import { parseReleaseTitle, type ParsedRelease } from './parse.js';
import { rankCandidates, type Candidate } from './rank.js';

export type { Candidate } from './rank.js';
export { parseReleaseTitle } from './parse.js';
export { releaseMatches, normalizeTitle, titleTokens } from './match.js';
export { rankCandidates } from './rank.js';

const DEFAULT_LIMIT = 30;

const pad = (value: number) => String(value).padStart(2, '0');

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
export function passesPreferences(parsed: ParsedRelease, preferences: Settings['preferences']): boolean {
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

function dedupeKey(release: ProwlarrRelease): string {
  return release.infoHash ?? `${normalizeTitle(release.title)}|${release.size}`;
}

const noPreferences: Settings['preferences'] = { languages: [], resolutions: [], codecs: [] };

export interface FindReleasesOptions {
  id: MediaId;
  metadata: MetadataProvider;
  prowlarr: ProwlarrClient;
  signal: AbortSignal;
  limit?: number;
  preferences?: Settings['preferences'];
}

// Resolves the title, runs the Prowlarr queries concurrently, then dedupes,
// filters to releases that actually match and fit the language/quality
// preferences, and ranks them. Individual query failures are tolerated; the
// caller decides what an empty result means.
export async function findReleases(options: FindReleasesOptions): Promise<Candidate[]> {
  const { id, metadata, prowlarr, signal, limit = DEFAULT_LIMIT, preferences = noPreferences } = options;
  if (!prowlarr.configured) return [];

  const wanted = await metadata.resolve(id, signal);
  const categories = id.type === 'movie' ? MOVIE_CATEGORIES : SERIES_CATEGORIES;
  const queries = buildQueries(id, wanted.title, wanted.year, wanted.alternateTitles[0]);

  const batches = await Promise.allSettled(
    queries.map(query => prowlarr.search(query, signal, categories)),
  );

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const [index, batch] of batches.entries()) {
    if (batch.status !== 'fulfilled') {
      const reason = batch.reason instanceof Error ? batch.reason.message : String(batch.reason);
      console.warn(`Debridarr Prowlarr search for ${JSON.stringify(queries[index])} failed: ${reason}`);
      continue;
    }
    for (const release of batch.value) {
      const key = dedupeKey(release);
      if (seen.has(key)) continue;
      seen.add(key);
      const parsed = parseReleaseTitle(release.title);
      if (releaseMatches({ releaseTitle: release.title, parsed, wanted }) && passesPreferences(parsed, preferences)) {
        candidates.push({ release, parsed });
      }
    }
  }

  return rankCandidates(candidates, { languages: preferences.languages }).slice(0, limit);
}
