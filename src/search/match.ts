import type { ResolvedTitle } from '../metadata/index.js';
import type { ParsedRelease } from './parse.js';

// Fold accents, drop punctuation, collapse whitespace, and normalise the common
// "&"/"and" spelling so titles compare loosely.
export function normalizeTitle(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function titleTokens(value: string): string[] {
  const stop = new Set(['the', 'a', 'an', 'of', 'and']);
  return normalizeTitle(value).split(' ').filter(token => token.length > 1 && !stop.has(token));
}

export interface MatchInput {
  releaseTitle: string;
  parsed: ParsedRelease;
  wanted: ResolvedTitle;
}

function titleHits(haystack: string, words: Set<string>, title: string): boolean {
  const tokens = titleTokens(title);
  return tokens.length > 0 && tokens.every(token => words.has(token) || haystack.includes(token));
}

// A release matches when every significant word of the wanted title — or of
// any known alternate/original title — appears in the release name, the year
// is within a year (when both are known), and — for series — the
// season/episode line up or it is a season pack. Each candidate title is
// checked as a whole; their words are never combined, or unrelated titles
// could match by coincidence.
export function releaseMatches({ releaseTitle, parsed, wanted }: MatchInput): boolean {
  const haystack = normalizeTitle(releaseTitle);
  const words = new Set(haystack.split(' '));
  const titleOk = [wanted.title, ...wanted.alternateTitles].some(title => titleHits(haystack, words, title));
  if (!titleOk) return false;

  if (wanted.type === 'movie') {
    if (wanted.year && parsed.year && Math.abs(parsed.year - wanted.year) > 1) return false;
    return true;
  }

  if (wanted.season === undefined || wanted.episode === undefined) return false;
  if (parsed.season !== undefined && parsed.season !== wanted.season) return false;
  if (parsed.seasonPack) return parsed.season === undefined || parsed.season === wanted.season;
  return parsed.episode === wanted.episode && parsed.season === wanted.season;
}
