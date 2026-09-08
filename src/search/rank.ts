import type { ProwlarrRelease } from '../integrations/prowlarr/client.js';
import type { ParsedRelease } from './parse.js';

export interface Candidate {
  release: ProwlarrRelease;
  parsed: ParsedRelease;
}

const SOURCE_RANK: Record<string, number> = {
  bluray: 5, webdl: 4, web: 3, webrip: 2, hdtv: 1, dvd: 0, cam: -5,
};

export interface RankPreferences {
  languages?: string[];
}

// Live torrents first, then (if any languages are preferred) a release
// tagged with one of them, then higher resolution, then better source, then
// more seeders, then larger files. Stable and predictable rather than
// clever. `preferences` defaults to a no-op so existing callers are unaffected.
export function rankCandidates(candidates: Candidate[], preferences: RankPreferences = {}): Candidate[] {
  const languages = preferences.languages;
  return [...candidates].sort((a, b) => {
    const live = Number(b.release.seeders > 0) - Number(a.release.seeders > 0);
    if (live) return live;
    if (languages && languages.length > 0) {
      const matches = (c: Candidate) => c.parsed.languages.includes('multi') || c.parsed.languages.some(l => languages.includes(l));
      const preferred = Number(matches(b)) - Number(matches(a));
      if (preferred) return preferred;
    }
    const resolution = (b.parsed.resolution ?? 0) - (a.parsed.resolution ?? 0);
    if (resolution) return resolution;
    const source = (SOURCE_RANK[b.parsed.source ?? ''] ?? 0) - (SOURCE_RANK[a.parsed.source ?? ''] ?? 0);
    if (source) return source;
    if (b.release.seeders !== a.release.seeders) return b.release.seeders - a.release.seeders;
    return b.release.size - a.release.size;
  });
}
