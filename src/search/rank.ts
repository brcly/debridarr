import type { Release } from '../discovery/source.js';
import type { ParsedRelease } from './parse.js';

export interface RankPreferences {
  languages?: string[];
}

export interface Candidate {
  release: Release;
  parsed: ParsedRelease;
  // The preferences of the source this candidate came from, so the language
  // tie-break below stays per-source even when candidates from several
  // sources are ranked together.
  preferences: RankPreferences;
}

const SOURCE_RANK: Record<string, number> = {
  bluray: 5, webdl: 4, web: 3, webrip: 2, hdtv: 1, dvd: 0, cam: -5,
};

// A season pack needs at least this many seeders to be worth preferring over
// single episodes; below it, a pack is treated like any other release.
const PACK_SEED_FLOOR = 3;

const healthyPack = (c: Candidate): boolean => c.parsed.seasonPack && (c.release.protocol === 'usenet' || c.release.seeders >= PACK_SEED_FLOOR);

// Cached copies are prepended by the addon. For new downloads: a downloadable
// season pack outranks single episodes (picking it fetches the whole season for
// seamless next-episode playback), then seed count wins — a well-seeded release
// should not sit below a nearly dead higher-resolution one. Language preference,
// resolution and source break ties in availability. A near-dead pack (below the
// seed floor) falls back to plain seed order.
export function rankCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    const pack = Number(healthyPack(b)) - Number(healthyPack(a));
    if (pack) return pack;
    const seeds = b.release.seeders - a.release.seeders;
    if (seeds) return seeds;
    // Each candidate is judged against its own source's language preference
    // (an empty preference always "matches", same as the search filter's
    // no-filter semantics), so mixed-source results still tie-break sensibly.
    const matchesOwnLanguages = (c: Candidate): boolean => {
      const languages = c.preferences.languages;
      if (!languages || languages.length === 0) return true;
      return c.parsed.languages.includes('multi') || c.parsed.languages.some(l => languages.includes(l));
    };
    const preferred = Number(matchesOwnLanguages(b)) - Number(matchesOwnLanguages(a));
    if (preferred) return preferred;
    const resolution = (b.parsed.resolution ?? 0) - (a.parsed.resolution ?? 0);
    if (resolution) return resolution;
    const source = (SOURCE_RANK[b.parsed.source ?? ''] ?? 0) - (SOURCE_RANK[a.parsed.source ?? ''] ?? 0);
    if (source) return source;
    return b.release.size - a.release.size;
  });
}
